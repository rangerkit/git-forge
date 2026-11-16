// graphql.ts — the GraphQL v4 surface at /api/graphql: just enough of the language (operations,
// variables, aliases, fragments, input objects, enum lists, batched operations) to serve the
// documents gh and github-mcp-server send, executed against the same store as REST.
//
// Global ids are opaque base64url strings ("Repository:7", "Issue:7:3", ...) that round-trip
// through node(id:) and the mutation inputs, and are stable across reads because they derive
// from the records' own ids. Unknown fields are validation errors in a 200 reply, as GitHub
// answers them; an unknown repository is data.repository = null with no errors.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { authorized, readBody, sendError, sendJson } from './http.ts';
import { pullFiles } from './rest.ts';
import { VIEWER, type Forge, type IssueRecord, type PullRecord, type Repo } from './store.ts';

// ------------------------------------------------------------------------------------------------
// Lexer and parser

type Value =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface FieldNode {
  kind: 'field';
  name: string;
  alias?: string;
  args: { name: string; value: Value }[];
  selection?: SelectionNode[];
}
interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}
interface InlineFragmentNode {
  kind: 'inline';
  typeCondition?: string;
  selection: SelectionNode[];
}
type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  operation: 'query' | 'mutation';
  name?: string;
  selection: SelectionNode[];
}
interface FragmentNode {
  name: string;
  typeCondition: string;
  selection: SelectionNode[];
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (/\s|,/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '"') {
      if (source.startsWith('"""', index)) {
        const end = source.indexOf('"""', index + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push(`"${source.slice(index + 3, end)}"`);
        index = end + 3;
        continue;
      }
      let cursor = index + 1;
      let value = '';
      while (cursor < source.length && source[cursor] !== '"') {
        if (source[cursor] === '\\') {
          value += source[cursor + 1] ?? '';
          cursor += 2;
        } else {
          value += source[cursor];
          cursor += 1;
        }
      }
      if (cursor >= source.length) throw new Error('unterminated string');
      tokens.push(`"${value}"`);
      index = cursor + 1;
      continue;
    }
    if (char === '.') {
      if (source.startsWith('...', index)) {
        tokens.push('...');
        index += 3;
        continue;
      }
      throw new Error('unexpected character "."');
    }
    if ('!$():=@[]{}|'.includes(char)) {
      tokens.push(char);
      index += 1;
      continue;
    }
    const nameMatch = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(index));
    if (nameMatch !== null) {
      tokens.push(nameMatch[0]);
      index += nameMatch[0].length;
      continue;
    }
    const numberMatch = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(index));
    if (numberMatch !== null) {
      tokens.push(numberMatch[0]);
      index += numberMatch[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)}`);
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private index = 0;
  readonly operations: OperationNode[] = [];
  readonly fragments = new Map<string, FragmentNode>();

  constructor(source: string) {
    this.tokens = tokenize(source);
    this.parseDocument();
  }

  private peek(): string | undefined {
    return this.tokens[this.index];
  }
  private next(): string {
    const token = this.tokens[this.index];
    if (token === undefined) throw new Error('unexpected end of document');
    this.index += 1;
    return token;
  }
  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  private parseDocument(): void {
    while (this.index < this.tokens.length) {
      const token = this.peek()!;
      if (token === 'query' || token === 'mutation' || token === 'subscription') {
        this.next();
        let name: string | undefined;
        if (this.peek() !== undefined && /^[_A-Za-z]/.test(this.peek()!) && this.peek() !== '(' && this.peek() !== '{') name = this.next();
        if (this.peek() === '(') this.skipBalanced('(', ')'); // variable definitions
        // Directives on the operation are skipped.
        while (this.peek() === '@') {
          this.next();
          this.next();
          if (this.peek() === '(') this.skipBalanced('(', ')');
        }
        const selection = this.parseSelectionSet();
        this.operations.push({ operation: token === 'mutation' ? 'mutation' : 'query', name, selection });
      } else if (token === 'fragment') {
        this.next();
        const name = this.next();
        this.expect('on');
        const typeCondition = this.next();
        const selection = this.parseSelectionSet();
        this.fragments.set(name, { name, typeCondition, selection });
      } else if (token === '{') {
        const selection = this.parseSelectionSet();
        this.operations.push({ operation: 'query', selection });
      } else {
        throw new Error(`unexpected token ${token}`);
      }
    }
  }

  private skipBalanced(open: string, close: string): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token === open) depth += 1;
      else if (token === close) depth -= 1;
    } while (depth > 0);
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.next() });
        }
        continue;
      }
      let name = this.next();
      let alias: string | undefined;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args: { name: string; value: Value }[] = [];
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.next();
          this.expect(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.expect(')');
      }
      while (this.peek() === '@') {
        this.next();
        this.next();
        if (this.peek() === '(') this.skipBalanced('(', ')');
      }
      let selection: SelectionNode[] | undefined;
      if (this.peek() === '{') selection = this.parseSelectionSet();
      selections.push({ kind: 'field', name, alias, args, selection });
    }
    this.expect('}');
    return selections;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d*\.\d/.test(token) || /^-?\d+(\.\d+)?[eE]/.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

/** Resolve a parsed Value against the operation's variables into plain JS data. */
function coerce(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'variable':
      return variables[value.name];
    case 'list':
      return value.items.map((item) => coerce(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = coerce(field.value, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Schema: the field sets validation knows, and the introspection tables.

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'nodes', '__type', '__schema', '__typename'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', '__typename'],
  User: ['id', 'login', 'name', 'email', '__typename'],
  Organization: ['id', 'login', 'name', '__typename'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'description', 'isPrivate', 'issue', 'issues', 'pullRequest', 'pullRequests',
    'createdAt', 'updatedAt', 'url', 'isArchived', 'stargazerCount', 'forkCount', '__typename',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'repository',
    'createdAt', 'updatedAt', 'closed', 'url', '__typename',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'author', 'repository', 'createdAt', 'updatedAt', 'mergeCommit',
    'url', 'commits', 'isDraft', '__typename',
  ],
  Ref: ['name', 'prefix', 'target', '__typename'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  IssueEdge: ['node', 'cursor', '__typename'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  PullRequestEdge: ['node', 'cursor', '__typename'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType', '__typename'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor', '__typename'],
  Node: ['id', '__typename'],
  Comment: ['id', 'body', 'author', 'createdAt', '__typename'],
  IssueComment: ['id', 'body', 'author', 'createdAt', '__typename'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  CommentEdge: ['node', 'cursor', '__typename'],
  Label: ['name', 'color', '__typename'],
  LabelConnection: ['nodes', 'pageInfo', 'totalCount', '__typename'],
  Commit: ['oid', 'message', 'committedDate', '__typename'],
  CreateIssuePayload: ['issue', 'clientMutationId', '__typename'],
  CloseIssuePayload: ['issue', 'clientMutationId', '__typename'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId', '__typename'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId', '__typename'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId', '__typename'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', '__typename'],
  __Field: ['name', 'description', 'type', 'args', 'isDeprecated', 'deprecationReason', '__typename'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason', '__typename'],
  __Schema: ['types', 'queryType', 'mutationType', '__typename'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

const TYPE_KINDS: Readonly<Record<string, string>> = {
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  MergeableState: 'ENUM',
  PullRequestMergeMethod: 'ENUM',
  RepositoryPermission: 'ENUM',
  IssueOrderField: 'ENUM',
  OrderDirection: 'ENUM',
};

// ------------------------------------------------------------------------------------------------
// Global ids

function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const at = text.indexOf(':');
    if (at === -1) return null;
    return { kind: text.slice(0, at), key: text.slice(at + 1) };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------
// Execution

type GqlObject = Record<string, unknown> & { __gqlType: string };

function typed(type: string, fields: Record<string, unknown>): GqlObject {
  return { __gqlType: type, ...fields };
}

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: { message: string }[];
}

function userObject(): GqlObject {
  return typed('User', { id: globalId('User', String(VIEWER.id)), login: VIEWER.login, name: VIEWER.name, email: VIEWER.email });
}

function repoObject(ctx: ExecContext, repo: Repo): GqlObject {
  return typed('Repository', {
    id: globalId('Repository', String(repo.id)),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.fullName,
    description: repo.description,
    isPrivate: repo.isPrivate,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: '2023-11-14T22:13:20Z',
    updatedAt: '2023-11-14T22:13:20Z',
    url: `https://forge.invalid/${repo.fullName}`,
    isArchived: false,
    stargazerCount: 0,
    forkCount: 0,
    owner: userObject(),
    defaultBranchRef: () => {
      const tip = repo.branchTip(repo.defaultBranch);
      if (tip === null) return null;
      return typed('Ref', { name: repo.defaultBranch, prefix: 'refs/heads/', target: typed('Commit', { oid: tip }) });
    },
    issue: (args: Record<string, unknown>) => {
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : issueObject(ctx, repo, issue);
    },
    issues: (args: Record<string, unknown>) => issuesConnection(ctx, repo, args),
    pullRequest: (args: Record<string, unknown>) => {
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : pullObject(ctx, repo, pull);
    },
    pullRequests: (args: Record<string, unknown>) => {
      const all = [...repo.pulls.values()].sort((a, b) => a.seq - b.seq);
      const first = typeof args.first === 'number' ? Math.trunc(args.first) : all.length;
      const nodes = all.slice(0, first).map((pull) => pullObject(ctx, repo, pull));
      return typed('PullRequestConnection', {
        nodes,
        totalCount: all.length,
        pageInfo: typed('PageInfo', { hasNextPage: all.length > nodes.length, hasPreviousPage: false, startCursor: null, endCursor: null }),
      });
    },
  });
}

function issueObject(ctx: ExecContext, repo: Repo, issue: IssueRecord): GqlObject {
  void ctx;
  return typed('Issue', {
    id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    closed: issue.state === 'closed',
    author: userObject(),
    repository: undefined, // filled lazily below to avoid cycles in materialization
    createdAt: '2023-11-14T22:13:20Z',
    updatedAt: '2023-11-14T22:13:20Z',
    url: `https://forge.invalid/${repo.fullName}/issues/${issue.number}`,
    labels: typed('LabelConnection', {
      nodes: issue.labels.map((name) => typed('Label', { name, color: repo.labels.get(name)?.color ?? 'ededed' })),
      totalCount: issue.labels.length,
    }),
    comments: typed('IssueCommentConnection', {
      nodes: repo.comments
        .filter((comment) => comment.issueNumber === issue.number)
        .map((comment) => typed('IssueComment', { id: globalId('IssueComment', String(comment.id)), body: comment.body, author: userObject() })),
      totalCount: repo.comments.filter((comment) => comment.issueNumber === issue.number).length,
    }),
  });
}

function issuesConnection(ctx: ExecContext, repo: Repo, args: Record<string, unknown>): GqlObject {
  let issues = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? args.states.map((state) => String(state)) : null;
  if (states !== null) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const descending = orderBy?.direction === 'DESC';
  issues.sort((a, b) => (descending ? b.seq - a.seq : a.seq - b.seq));

  let startIndex = 0;
  const after = typeof args.after === 'string' ? args.after : null;
  if (after !== null) {
    const decoded = parseCursor(after);
    const at = decoded === null ? -1 : issues.findIndex((issue) => issue.number === decoded);
    if (at !== -1) startIndex = at + 1;
  }
  const first = typeof args.first === 'number' ? Math.trunc(args.first) : issues.length;
  const page = issues.slice(startIndex, startIndex + Math.max(0, first));
  const hasNextPage = startIndex + page.length < issues.length;
  const nodes = page.map((issue) => issueObject(ctx, repo, issue));
  return typed('IssueConnection', {
    nodes,
    totalCount: issues.length,
    pageInfo: typed('PageInfo', {
      hasNextPage,
      hasPreviousPage: startIndex > 0,
      startCursor: page.length > 0 ? cursorOf(page[0]!.number) : null,
      endCursor: page.length > 0 ? cursorOf(page[page.length - 1]!.number) : null,
    }),
  });
}

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function parseCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function pullObject(ctx: ExecContext, repo: Repo, pull: PullRecord): GqlObject {
  const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
  return typed('PullRequest', {
    id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state,
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    author: userObject(),
    createdAt: '2023-11-14T22:13:20Z',
    updatedAt: '2023-11-14T22:13:20Z',
    url: `https://forge.invalid/${repo.fullName}/pull/${pull.number}`,
    isDraft: false,
    mergeable: () => {
      if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
      const baseTip = repo.branchTip(pull.baseRef);
      const headTip = repo.branchTip(pull.headRef);
      if (baseTip === null || headTip === null) return 'UNKNOWN';
      return ctx.forge.mergeTrees(repo, baseTip, headTip).ok ? 'MERGEABLE' : 'CONFLICTING';
    },
    files: (args: Record<string, unknown>) => {
      const all = pullFiles(repo, pull);
      const first = typeof args.first === 'number' ? Math.trunc(args.first) : all.length;
      return typed('PullRequestFileConnection', {
        nodes: all.slice(0, first).map((file) =>
          typed('PullRequestChangedFile', {
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status.toUpperCase(),
          }),
        ),
        totalCount: all.length,
      });
    },
  });
}

function typeObject(name: string): GqlObject | null {
  const fields = TYPE_FIELDS[name];
  const enumValues = ENUM_VALUES[name];
  if (fields === undefined && enumValues === undefined) return null;
  return typed('__Type', {
    name,
    kind: TYPE_KINDS[name] ?? 'OBJECT',
    description: null,
    fields: fields === undefined ? null : fields.filter((field) => field !== '__typename').map((field) => typed('__Field', { name: field, description: null, isDeprecated: false, deprecationReason: null })),
    enumValues: enumValues === undefined ? null : enumValues.map((value) => typed('__EnumValue', { name: value, description: null, isDeprecated: false, deprecationReason: null })),
    possibleTypes: null,
    inputFields: null,
    ofType: null,
  });
}

function repoByGlobalId(ctx: ExecContext, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Repository') return null;
  const wanted = Number(parsed.key);
  for (const repo of ctx.forge.repos.values()) if (repo.id === wanted) return repo;
  return null;
}

function issueByGlobalId(ctx: ExecContext, id: unknown): { repo: Repo; issue: IssueRecord } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Issue') return null;
  const [repoId, number] = parsed.key.split(':');
  for (const repo of ctx.forge.repos.values()) {
    if (repo.id !== Number(repoId)) continue;
    const issue = repo.issues.get(Number(number));
    return issue === undefined ? null : { repo, issue };
  }
  return null;
}

function pullByGlobalId(ctx: ExecContext, id: unknown): { repo: Repo; pull: PullRecord } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'PullRequest') return null;
  const [repoId, number] = parsed.key.split(':');
  for (const repo of ctx.forge.repos.values()) {
    if (repo.id !== Number(repoId)) continue;
    const pull = repo.pulls.get(Number(number));
    return pull === undefined ? null : { repo, pull };
  }
  return null;
}

function nodeById(ctx: ExecContext, id: unknown): GqlObject | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.kind === 'Repository') {
    const repo = repoByGlobalId(ctx, id);
    return repo === null ? null : repoObject(ctx, repo);
  }
  if (parsed.kind === 'Issue') {
    const found = issueByGlobalId(ctx, id);
    return found === null ? null : issueObject(ctx, found.repo, found.issue);
  }
  if (parsed.kind === 'PullRequest') {
    const found = pullByGlobalId(ctx, id);
    return found === null ? null : pullObject(ctx, found.repo, found.pull);
  }
  if (parsed.kind === 'User') return userObject();
  return null;
}

function rootQuery(ctx: ExecContext): GqlObject {
  return typed('Query', {
    viewer: userObject(),
    repository: (args: Record<string, unknown>) => {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      if (owner !== VIEWER.login) return null;
      const repo = ctx.forge.getRepo(owner, name);
      return repo === undefined ? null : repoObject(ctx, repo);
    },
    node: (args: Record<string, unknown>) => nodeById(ctx, args.id),
    __type: (args: Record<string, unknown>) => typeObject(String(args.name ?? '')),
  });
}

function rootMutation(ctx: ExecContext): GqlObject {
  return typed('Mutation', {
    createIssue: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGlobalId(ctx, input.repositoryId);
      if (repo === null) throw new Error('repository not found');
      const issue = ctx.forge.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return typed('CreateIssuePayload', { issue: issueObject(ctx, repo, issue), clientMutationId: input.clientMutationId ?? null });
    },
    closeIssue: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueByGlobalId(ctx, input.issueId);
      if (found === null) throw new Error('issue not found');
      found.issue.state = 'closed';
      return typed('CloseIssuePayload', { issue: issueObject(ctx, found.repo, found.issue), clientMutationId: input.clientMutationId ?? null });
    },
    createPullRequest: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGlobalId(ctx, input.repositoryId);
      if (repo === null) throw new Error('repository not found');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (repo.branchTip(head) === null) throw new Error(`head branch ${head} does not exist`);
      if (repo.branchTip(base) === null) throw new Error(`base branch ${base} does not exist`);
      const pull = ctx.forge.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
      return typed('CreatePullRequestPayload', { pullRequest: pullObject(ctx, repo, pull), clientMutationId: input.clientMutationId ?? null });
    },
    mergePullRequest: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = pullByGlobalId(ctx, input.pullRequestId);
      if (found === null) throw new Error('pull request not found');
      const method = String(input.mergeMethod ?? 'MERGE');
      const outcome = ctx.forge.mergePull(found.repo, found.pull, method === 'SQUASH' ? 'squash' : 'merge');
      if (!outcome.ok) throw new Error('pull request is not mergeable');
      return typed('MergePullRequestPayload', { pullRequest: pullObject(ctx, found.repo, found.pull), clientMutationId: input.clientMutationId ?? null });
    },
    addComment: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueByGlobalId(ctx, input.subjectId);
      if (found === null) throw new Error('subject not found');
      const comment = ctx.forge.createComment(found.repo, found.issue.number, String(input.body ?? ''));
      const node = typed('IssueComment', { id: globalId('IssueComment', String(comment.id)), body: comment.body, author: userObject() });
      return typed('AddCommentPayload', {
        commentEdge: typed('CommentEdge', { node, cursor: cursorOf(comment.id) }),
        subject: issueObject(ctx, found.repo, found.issue),
        clientMutationId: input.clientMutationId ?? null,
      });
    },
  });
}

// ------------------------------------------------------------------------------------------------
// Validation and field resolution

/** The object type a field returns, for the fields validation descends into. */
const FIELD_TYPES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Repository: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection' },
  Issue: { author: 'User', labels: 'LabelConnection', comments: 'IssueCommentConnection', repository: 'Repository' },
  PullRequest: { author: 'User', repository: 'Repository', files: 'PullRequestFileConnection', headRef: 'Ref', baseRef: 'Ref', mergeCommit: 'Commit' },
  Ref: { target: 'Commit' },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo' },
  IssueEdge: { node: 'Issue' },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo' },
  PullRequestEdge: { node: 'PullRequest' },
  PullRequestFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo' },
  LabelConnection: { nodes: 'Label' },
  IssueCommentConnection: { nodes: 'IssueComment', pageInfo: 'PageInfo' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'CommentEdge', subject: 'Issue' },
  CommentEdge: { node: 'IssueComment' },
  __Type: { fields: '__Field', enumValues: '__EnumValue', possibleTypes: '__Type', inputFields: '__Field', ofType: '__Type' },
  __Field: { type: '__Type', args: '__InputValue' },
  __Schema: { types: '__Type', queryType: '__Type', mutationType: '__Type' },
};

function validateSelections(ctx: ExecContext, typeName: string, selections: readonly SelectionNode[]): void {
  const fields = TYPE_FIELDS[typeName];
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) validateSelections(ctx, fragment.typeCondition, fragment.selection);
      continue;
    }
    if (selection.kind === 'inline') {
      validateSelections(ctx, selection.typeCondition ?? typeName, selection.selection);
      continue;
    }
    if (fields !== undefined && !fields.includes(selection.name)) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      continue;
    }
    if (selection.selection !== undefined) {
      const childType = FIELD_TYPES[typeName]?.[selection.name];
      if (childType !== undefined) validateSelections(ctx, childType, selection.selection);
    }
  }
}

function executeSelections(ctx: ExecContext, source: GqlObject, selections: readonly SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && fragmentApplies(fragment.typeCondition, source)) {
        Object.assign(out, executeSelections(ctx, source, fragment.selection));
      }
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition === undefined || fragmentApplies(selection.typeCondition, source)) {
        Object.assign(out, executeSelections(ctx, source, selection.selection));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    out[key] = resolveField(ctx, source, selection);
  }
  return out;
}

function fragmentApplies(typeCondition: string, source: GqlObject): boolean {
  if (typeCondition === source.__gqlType) return true;
  if (typeCondition === 'Node') return ['Repository', 'Issue', 'PullRequest', 'User'].includes(source.__gqlType);
  return false;
}

function resolveField(ctx: ExecContext, source: GqlObject, field: FieldNode): unknown {
  if (field.name === '__typename') return source.__gqlType;
  let value: unknown = source[field.name];
  if (typeof value === 'function') {
    const args: Record<string, unknown> = {};
    for (const arg of field.args) args[arg.name] = coerce(arg.value, ctx.variables);
    try {
      value = (value as (args: Record<string, unknown>) => unknown)(args);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }
  if (value === undefined) value = null;
  if (field.selection === undefined || field.selection.length === 0) return value;
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((entry) => (isGqlObject(entry) ? executeSelections(ctx, entry, field.selection!) : entry));
  }
  if (isGqlObject(value)) return executeSelections(ctx, value, field.selection);
  return value;
}

function isGqlObject(value: unknown): value is GqlObject {
  return typeof value === 'object' && value !== null && '__gqlType' in value;
}

function executeOperation(forge: Forge, parser: Parser, operation: OperationNode, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: ExecContext = { forge, variables, fragments: parser.fragments, errors: [] };
  const root = operation.operation === 'mutation' ? rootMutation(ctx) : rootQuery(ctx);
  validateSelections(ctx, root.__gqlType, operation.selection);
  const data = executeSelections(ctx, root, operation.selection);
  const reply: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) reply.errors = ctx.errors;
  return reply;
}

// ------------------------------------------------------------------------------------------------
// The HTTP endpoint

interface OperationRequest {
  query: string;
  variables: Record<string, unknown>;
  operationName?: string;
}

function executeRequest(forge: Forge, request: OperationRequest): Record<string, unknown> {
  let parser: Parser;
  try {
    parser = new Parser(request.query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation = request.operationName !== undefined ? parser.operations.find((op) => op.name === request.operationName) ?? parser.operations[0] : parser.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation in document' }] };
  return executeOperation(forge, parser, operation, request.variables);
}

export async function handleGraphql(forge: Forge, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorized(req, token)) {
    sendError(res, 401, 'Unauthorized');
    return;
  }
  if (req.method !== 'POST') {
    sendError(res, 404, 'Not Found');
    return;
  }
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      const request = entry as OperationRequest;
      return executeRequest(forge, { query: String(request.query ?? ''), variables: request.variables ?? {}, operationName: request.operationName });
    });
    sendJson(res, 200, results);
    return;
  }
  const request = body as OperationRequest;
  const result = executeRequest(forge, { query: String(request.query ?? ''), variables: request.variables ?? {}, operationName: request.operationName });
  sendJson(res, 200, result);
}
