// rest.ts — the REST v3 surface under /api/v3: users, repositories, branches, commits, the
// contents API, labels, issues, comments and pull requests, in GitHub's shapes.
//
// Discipline the suite checks: every reply is JSON with a request id; a missing token is a
// 401; a repository under another owner is a 404 (never a 403); a malformed JSON body is a
// 400; errors are {"message": string}. The serializers here are shared with the GraphQL and
// MCP surfaces so every view of an object agrees.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZERO_OID, objectId, parseCommit } from './gitcore.ts';
import { HttpError, authorized, parseJsonBody, readBody, sendEmpty, sendError, sendJson, stringField } from './http.ts';
import { VIEWER, type Forge, type IssueRecord, type PullRecord, type Repo } from './store.ts';

// ------------------------------------------------------------------------------------------------
// Serializers

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    html_url: `https://forge.invalid/${repo.fullName}`,
    clone_url: `https://forge.invalid/${repo.fullName}.git`,
  };
}

export function labelJson(name: string, color: string): Record<string, unknown> {
  return { name, color, default: false };
}

export function issueJson(repo: Repo, issue: IssueRecord): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(name, repo.labels.get(name)?.color ?? 'ededed')),
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    comments: repo.comments.filter((comment) => comment.issueNumber === issue.number).length,
    html_url: `https://forge.invalid/${repo.fullName}/issues/${issue.number}`,
  };
}

export function commentJson(repo: Repo, comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    html_url: `https://forge.invalid/${repo.fullName}/issues`,
  };
}

/** A pull request's live head/base shas (the branch tips now, the open-time tips as fallback). */
export function pullRefs(repo: Repo, pull: PullRecord): { headSha: string; baseSha: string } {
  return {
    headSha: repo.branchTip(pull.headRef) ?? pull.headShaAtOpen,
    baseSha: repo.branchTip(pull.baseRef) ?? pull.baseShaAtOpen,
  };
}

export function pullJson(repo: Repo, pull: PullRecord, forge: Forge): Record<string, unknown> {
  const { headSha, baseSha } = pullRefs(repo, pull);
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    html_url: `https://forge.invalid/${repo.fullName}/pull/${pull.number}`,
  };
}

/** The files a pull request changes: merge-base tree versus head tree, with line counts. */
export function pullFiles(repo: Repo, pull: PullRecord): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const { headSha, baseSha } = pullRefs(repo, pull);
  const mergeBase = repo.mergeBase(baseSha, headSha) ?? baseSha;
  const before = repo.filesAt(mergeBase);
  const after = repo.filesAt(headSha);
  const files: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry?.oid === newEntry?.oid) continue;
    const oldText = oldEntry === undefined ? null : (repo.getObject(oldEntry.oid)?.data.toString('utf8') ?? '');
    const newText = newEntry === undefined ? null : (repo.getObject(newEntry.oid)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineDiff(oldText, newText);
    files.push({
      filename: path,
      status: oldEntry === undefined ? 'added' : newEntry === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return files;
}

/** Line-level diff counts via a longest-common-subsequence over lines (files here are small). */
export function lineDiff(oldText: string | null, newText: string | null): { additions: number; deletions: number } {
  if (oldText === null) return { additions: newText === null ? 0 : countLines(newText), deletions: 0 };
  if (newText === null) return { additions: 0, deletions: countLines(oldText) };
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  // LCS length by dynamic programming over the shorter axis.
  const dp: number[] = new Array(newLines.length + 1).fill(0);
  for (let i = 1; i <= oldLines.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= newLines.length; j += 1) {
      const above = dp[j]!;
      if (oldLines[i - 1] === newLines[j - 1]) dp[j] = diagonal + 1;
      else dp[j] = Math.max(dp[j]!, dp[j - 1]!);
      diagonal = above;
    }
  }
  const common = dp[newLines.length]!;
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

function countLines(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length;
}

// ------------------------------------------------------------------------------------------------
// Routing helpers

export interface RestRoute {
  /** Path segments after /api/v3, percent-decoded. */
  segments: string[];
  query: URLSearchParams;
}

function notFound(res: ServerResponse): void {
  sendError(res, 404, 'Not Found');
}

/** The repository a route names, answering 404 (and returning null) when it is not the viewer's. */
function ownedRepo(forge: Forge, owner: string, name: string, res: ServerResponse): Repo | null {
  if (owner !== VIEWER.login) {
    notFound(res);
    return null;
  }
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) {
    notFound(res);
    return null;
  }
  return repo;
}

interface Page {
  page: number;
  perPage: number;
}

function pageOf(query: URLSearchParams): Page {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1,
  };
}

/** Slice a list for the page and, when more pages exist, emit GitHub's Link header. */
function paginate<T>(res: ServerResponse, req: IncomingMessage, items: readonly T[], page: Page): T[] {
  const start = (page.page - 1) * page.perPage;
  const slice = items.slice(start, start + page.perPage);
  if (start + page.perPage < items.length) {
    const host = req.headers.host ?? '127.0.0.1';
    const url = new URL(req.url ?? '/', `http://${host}`);
    url.searchParams.set('page', String(page.page + 1));
    url.searchParams.set('per_page', String(page.perPage));
    const lastPage = Math.ceil(items.length / page.perPage);
    const last = new URL(req.url ?? '/', `http://${host}`);
    last.searchParams.set('page', String(lastPage));
    last.searchParams.set('per_page', String(page.perPage));
    res.setHeader('link', `<${url.toString()}>; rel="next", <${last.toString()}>; rel="last"`);
  }
  return slice;
}

// ------------------------------------------------------------------------------------------------
// The surface

export async function handleRest(forge: Forge, token: string, req: IncomingMessage, res: ServerResponse, route: RestRoute): Promise<void> {
  const { segments, query } = route;
  const method = req.method ?? 'GET';

  try {
    // The root and meta documents answer without a repository but still require the token.
    if (segments.length === 0 || (segments.length === 1 && segments[0] === '')) {
      if (!authorized(req, token)) return sendError(res, 401, 'Requires authentication');
      if (method !== 'GET') return notFound(res);
      return sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues',
      });
    }
    if (segments.length === 1 && segments[0] === 'meta') {
      if (!authorized(req, token)) return sendError(res, 401, 'Requires authentication');
      if (method !== 'GET') return notFound(res);
      return sendJson(res, 200, { verifiable_password_authentication: false, installed_version: '1.0.0', github_connectivity: false });
    }

    if (!authorized(req, token)) return sendError(res, 401, 'Requires authentication');

    // Bodies on writes are JSON (DELETE /contents carries one too); GETs carry none.
    const raw = method === 'GET' ? Buffer.alloc(0) : await readBody(req);
    const body: Record<string, unknown> = raw.length === 0 ? {} : parseJsonBody(raw);

    if (segments[0] === 'user') return userRoutes(forge, req, res, segments, query, body, method);
    if (segments[0] === 'repos' && segments.length >= 3) return repoRoutes(forge, req, res, segments, query, body, method);
    return notFound(res);
  } catch (err) {
    if (err instanceof HttpError) return sendError(res, err.status, err.message);
    throw err;
  }
}

async function userRoutes(forge: Forge, req: IncomingMessage, res: ServerResponse, segments: string[], query: URLSearchParams, body: Record<string, unknown>, method: string): Promise<void> {
  if (segments.length === 1) {
    if (method !== 'GET') return notFound(res);
    return sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
  }
  if (segments.length === 2 && segments[1] === 'repos') {
    if (method === 'GET') {
      const repos = forge.reposOf(VIEWER.login).map(repoJson);
      return sendJson(res, 200, paginate(res, req, repos, pageOf(query)));
    }
    if (method === 'POST') {
      const name = stringField(body, 'name');
      if (name === undefined || name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        return sendError(res, 422, 'Repository creation failed: name is invalid');
      }
      if (forge.getRepo(VIEWER.login, name) !== undefined) {
        return sendError(res, 422, 'Repository creation failed: name already exists on this account');
      }
      const description = stringField(body, 'description') ?? '';
      const isPrivate = body.private === true;
      const repo = forge.createRepo(VIEWER.login, name, description, isPrivate);
      return sendJson(res, 201, repoJson(repo));
    }
  }
  return notFound(res);
}

async function repoRoutes(forge: Forge, req: IncomingMessage, res: ServerResponse, segments: string[], query: URLSearchParams, body: Record<string, unknown>, method: string): Promise<void> {
  const owner = segments[1]!;
  const name = segments[2]!;
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') {
      const repo = ownedRepo(forge, owner, name, res);
      if (repo === null) return;
      return sendJson(res, 200, repoJson(repo));
    }
    if (method === 'PATCH') {
      const repo = ownedRepo(forge, owner, name, res);
      if (repo === null) return;
      const description = stringField(body, 'description');
      if (description !== undefined) repo.description = description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      return sendJson(res, 200, repoJson(repo));
    }
    if (method === 'DELETE') {
      const repo = ownedRepo(forge, owner, name, res);
      if (repo === null) return;
      forge.deleteRepo(owner, name);
      return sendEmpty(res, 204);
    }
    return notFound(res);
  }

  const repo = ownedRepo(forge, owner, name, res);
  if (repo === null) return;

  // Branches and commits.
  if (rest[0] === 'branches') {
    if (method !== 'GET') return notFound(res);
    if (rest.length === 1) {
      const branches = repo.branchNames().map((branch) => ({ name: branch, commit: { sha: repo.refs.get(repo.branchRef(branch))! }, protected: false }));
      return sendJson(res, 200, branches);
    }
    const branch = rest.slice(1).join('/');
    const tip = repo.refs.get(repo.branchRef(branch));
    if (tip === undefined) return notFound(res);
    return sendJson(res, 200, { name: branch, commit: { sha: tip }, protected: false });
  }
  if (rest[0] === 'commits' && rest.length === 1) {
    if (method !== 'GET') return notFound(res);
    const shaParam = query.get('sha');
    let start: string | null;
    if (shaParam === null || shaParam === '') start = repo.branchTip(repo.defaultBranch);
    else if (repo.getObject(shaParam)?.type === 'commit') start = shaParam;
    else start = repo.branchTip(shaParam) ?? repo.refCommit(shaParam);
    if (start === null) return sendJson(res, 200, []);
    const history = repo.historyFrom(start);
    const items = history.slice(0, 1000).map((oid) => {
      const commit = parseCommit(repo.getObject(oid)!.data);
      return {
        sha: oid,
        commit: {
          message: commit.message,
          tree: { sha: commit.tree },
          author: { name: commit.authorName, email: commit.authorEmail, date: new Date(commit.authorTime * 1000).toISOString() },
          committer: { name: commit.committerName, email: commit.committerEmail, date: new Date(commit.committerTime * 1000).toISOString() },
        },
        parents: commit.parents.map((parent) => ({ sha: parent })),
      };
    });
    return sendJson(res, 200, items);
  }

  // Git data refs.
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = stringField(body, 'ref');
      const sha = stringField(body, 'sha');
      if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) return sendError(res, 422, 'Invalid ref or sha');
      if (repo.getObject(sha) === undefined) return sendError(res, 422, 'Object does not exist');
      if (repo.refs.has(ref)) return sendError(res, 422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return sendJson(res, 201, { ref, object: { sha, type: repo.getObject(sha)!.type } });
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) return notFound(res);
      return sendJson(res, 200, { ref, object: { sha: oid, type: repo.getObject(oid)?.type ?? 'commit' } });
    }
    return notFound(res);
  }

  // Contents.
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    return contentsRoutes(forge, res, repo, path, query, body, method);
  }

  // Labels.
  if (rest[0] === 'labels' && rest.length === 1) {
    if (method === 'GET') return sendJson(res, 200, [...repo.labels.values()].map((label) => labelJson(label.name, label.color)));
    if (method === 'POST') {
      const labelName = stringField(body, 'name');
      if (labelName === undefined || labelName === '') return sendError(res, 422, 'Label name is required');
      const color = stringField(body, 'color') ?? 'ededed';
      if (!repo.labels.has(labelName)) repo.labels.set(labelName, { name: labelName, color });
      return sendJson(res, 201, labelJson(labelName, color));
    }
    return notFound(res);
  }

  // Issues and comments.
  if (rest[0] === 'issues') return issueRoutes(forge, req, res, repo, rest.slice(1), query, body, method);

  // Pull requests.
  if (rest[0] === 'pulls') return pullRoutes(forge, req, res, repo, rest.slice(1), query, body, method);

  return notFound(res);
}

function contentsRoutes(forge: Forge, res: ServerResponse, repo: Repo, path: string, query: URLSearchParams, body: Record<string, unknown>, method: string): void {
  const refParam = query.get('ref') ?? stringField(body, 'branch') ?? repo.defaultBranch;
  if (method === 'GET') {
    const tip = repo.branchTip(refParam);
    if (tip === null) return notFound(res);
    const files = repo.filesAt(tip);
    const commit = repo.commitOf(tip)!;
    if (path !== '') {
      const file = files.get(path);
      if (file !== undefined) {
        const blob = repo.getObject(file.oid);
        if (blob === undefined) return notFound(res);
        return sendJson(res, 200, {
          type: 'file',
          name: path.split('/').pop(),
          path,
          sha: file.oid,
          size: blob.data.length,
          encoding: 'base64',
          content: blob.data.toString('base64'),
        });
      }
    }
    // A directory (or the root): list the entries directly under it.
    const prefix = path === '' ? '' : `${path}/`;
    const entries = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
    for (const [filePath, file] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const remainder = filePath.slice(prefix.length);
      const slash = remainder.indexOf('/');
      if (slash === -1) {
        entries.set(remainder, { type: 'file', name: remainder, path: filePath, sha: file.oid });
      } else {
        const dirName = remainder.slice(0, slash);
        if (!entries.has(dirName)) {
          const dirPath = prefix + dirName;
          entries.set(dirName, { type: 'dir', name: dirName, path: dirPath, sha: treeShaAt(repo, commit.tree, dirPath) ?? ZERO_OID });
        }
      }
    }
    if (path !== '' && entries.size === 0) return notFound(res);
    return sendJson(res, 200, [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
  }
  if (method === 'PUT') {
    const content = stringField(body, 'content');
    const message = stringField(body, 'message') ?? 'update';
    if (content === undefined || path === '') return sendError(res, 422, 'Content is required');
    const branch = stringField(body, 'branch') ?? repo.defaultBranch;
    const tip = repo.branchTip(branch);
    const existing = tip === null ? undefined : repo.filesAt(tip).get(path);
    const givenSha = stringField(body, 'sha');
    if (existing !== undefined && givenSha !== undefined && givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
      return sendError(res, 409, 'Conflict: the file has changed since the sha was read');
    }
    const bytes = Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
    const written = forge.writeFile(repo, branch, path, bytes, message);
    const status = written.existed ? 200 : 201;
    return sendJson(res, status, {
      content: { name: path.split('/').pop(), path, sha: written.blobSha, size: bytes.length, type: 'file', encoding: 'base64' },
      commit: { sha: written.commitSha, message },
    });
  }
  if (method === 'DELETE') {
    const message = stringField(body, 'message') ?? 'delete';
    const branch = stringField(body, 'branch') ?? repo.defaultBranch;
    const tip = repo.branchTip(branch);
    const existing = tip === null ? undefined : repo.filesAt(tip).get(path);
    if (existing === undefined) return notFound(res);
    const givenSha = stringField(body, 'sha');
    if (givenSha !== undefined && givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
      return sendError(res, 409, 'Conflict: the file has changed since the sha was read');
    }
    const deleted = forge.deleteFile(repo, branch, path, message);
    if (deleted === null) return notFound(res);
    return sendJson(res, 200, { content: null, commit: { sha: deleted.commitSha, message } });
  }
  return notFound(res);
}

/** The tree oid at a directory path inside a tree, for directory listing entries. */
function treeShaAt(repo: Repo, treeOid: string, dirPath: string): string | null {
  let current = treeOid;
  for (const part of dirPath.split('/')) {
    const object = repo.getObject(current);
    if (object === undefined || object.type !== 'tree') return null;
    // Walk one level: parse the raw tree.
    let next: string | null = null;
    const data = object.data;
    let offset = 0;
    while (offset < data.length) {
      const space = data.indexOf(0x20, offset);
      if (space === -1) break;
      const nul = data.indexOf(0x00, space + 1);
      if (nul === -1 || nul + 21 > data.length) break;
      const entryName = data.toString('utf8', space + 1, nul);
      if (entryName === part) {
        next = data.toString('hex', nul + 1, nul + 21);
        break;
      }
      offset = nul + 21;
    }
    if (next === null) return null;
    current = next;
  }
  return current;
}

function issueRoutes(forge: Forge, req: IncomingMessage, res: ServerResponse, repo: Repo, rest: string[], query: URLSearchParams, body: Record<string, unknown>, method: string): void {
  if (rest.length === 0) {
    if (method === 'POST') {
      const title = stringField(body, 'title');
      if (title === undefined || title === '') return sendError(res, 422, 'Issue title is required');
      const labels = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return sendError(res, 422, `Label "${label}" does not exist on this repository`);
      }
      const issue = forge.createIssue(repo, title, stringField(body, 'body') ?? '', labels);
      return sendJson(res, 201, issueJson(repo, issue));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      const direction = query.get('direction') ?? 'desc';
      issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      return sendJson(res, 200, paginate(res, req, issues.map((issue) => issueJson(repo, issue)), pageOf(query)));
    }
    return notFound(res);
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number <= 0) return notFound(res);
  const issue = repo.issues.get(number);

  if (rest.length === 1) {
    if (issue === undefined) return notFound(res);
    if (method === 'GET') return sendJson(res, 200, issueJson(repo, issue));
    if (method === 'PATCH') {
      const state = stringField(body, 'state');
      if (state === 'open' || state === 'closed') issue.state = state;
      const title = stringField(body, 'title');
      if (title !== undefined) issue.title = title;
      const text = stringField(body, 'body');
      if (text !== undefined) issue.body = text;
      if (Array.isArray(body.labels)) {
        const labels = body.labels.filter((label): label is string => typeof label === 'string');
        for (const label of labels) if (!repo.labels.has(label)) return sendError(res, 422, `Label "${label}" does not exist on this repository`);
        issue.labels = labels;
      }
      return sendJson(res, 200, issueJson(repo, issue));
    }
    return notFound(res);
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) return notFound(res);
    if (method === 'GET') {
      const comments = repo.comments.filter((comment) => comment.issueNumber === number).sort((a, b) => a.seq - b.seq);
      return sendJson(res, 200, comments.map((comment) => commentJson(repo, comment)));
    }
    if (method === 'POST') {
      const text = stringField(body, 'body');
      if (text === undefined) return sendError(res, 422, 'Comment body is required');
      const comment = forge.createComment(repo, number, text);
      return sendJson(res, 201, commentJson(repo, comment));
    }
  }
  return notFound(res);
}

function pullRoutes(forge: Forge, req: IncomingMessage, res: ServerResponse, repo: Repo, rest: string[], query: URLSearchParams, body: Record<string, unknown>, method: string): void {
  if (rest.length === 0) {
    if (method === 'POST') {
      const title = stringField(body, 'title');
      const head = stringField(body, 'head');
      const base = stringField(body, 'base');
      if (title === undefined || head === undefined || base === undefined) return sendError(res, 422, 'title, head and base are required');
      const headBranch = head.includes(':') ? head.split(':').pop()! : head;
      if (repo.branchTip(base) === null) return sendError(res, 422, `Base branch "${base}" does not exist`);
      if (repo.branchTip(headBranch) === null) return sendError(res, 422, `Head branch "${headBranch}" does not exist`);
      const duplicate = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.headRef === headBranch && pull.baseRef === base);
      if (duplicate !== undefined) return sendError(res, 422, `A pull request already exists for ${headBranch} into ${base}`);
      const pull = forge.createPull(repo, title, stringField(body, 'body') ?? '', headBranch, base);
      return sendJson(res, 201, pullJson(repo, pull, forge));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => a.seq - b.seq);
      return sendJson(res, 200, paginate(res, req, pulls.map((pull) => pullJson(repo, pull, forge)), pageOf(query)));
    }
    return notFound(res);
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number <= 0) return notFound(res);
  const pull = repo.pulls.get(number);

  if (rest.length === 1) {
    if (pull === undefined) return notFound(res);
    if (method === 'GET') return sendJson(res, 200, pullJson(repo, pull, forge));
    if (method === 'PATCH') {
      const state = stringField(body, 'state');
      if ((state === 'open' || state === 'closed') && !pull.merged) pull.state = state;
      const title = stringField(body, 'title');
      if (title !== undefined) pull.title = title;
      const text = stringField(body, 'body');
      if (text !== undefined) pull.body = text;
      return sendJson(res, 200, pullJson(repo, pull, forge));
    }
    return notFound(res);
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    if (pull === undefined) return notFound(res);
    return sendJson(res, 200, pullFiles(repo, pull));
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) return notFound(res);
    if (pull.merged) return sendError(res, 405, 'Pull Request is not mergeable: it has already been merged');
    if (pull.state !== 'open') return sendError(res, 405, 'Pull Request is not mergeable: it is closed');
    const method2 = stringField(body, 'merge_method') ?? 'merge';
    const outcome = forge.mergePull(repo, pull, method2 === 'squash' ? 'squash' : 'merge');
    if (!outcome.ok) return sendError(res, 405, 'Pull Request is not mergeable: merge conflict');
    return sendJson(res, 200, { sha: outcome.sha!, merged: true, message: 'Pull Request successfully merged' });
  }

  return notFound(res);
}
