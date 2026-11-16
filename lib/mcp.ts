// mcp.ts — the Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over streamable HTTP.
//
// The server speaks the current revision's discovery handshake (server/discover, no session)
// and the legacy initialize handshake, and offers six tools that act on the same store as the
// REST surface, so an object created here is the same object REST reads back. tools/list is
// built once and never changes, so two calls answer byte for byte alike. An unauthenticated
// request is an HTTP 401 before any JSON-RPC work happens; a body that is not JSON is an
// HTTP 400 carrying the JSON-RPC parse error.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { authorized, readBody, sendEmpty, sendError, sendJson } from './http.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { VIEWER, type Forge, type Repo } from './store.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' } as const;
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (forge: Forge, args: Record<string, unknown>) => Record<string, unknown> | unknown[];
}

function toolError(message: string): { __toolError: string } {
  return { __toolError: message };
}

function isToolError(value: unknown): value is { __toolError: string } {
  return typeof value === 'object' && value !== null && '__toolError' in value;
}

function ownedRepo(forge: Forge, args: Record<string, unknown>): Repo | { __toolError: string } {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  if (owner !== VIEWER.login) return toolError(`repository ${owner}/${name} not found`);
  const repo = forge.getRepo(owner, name);
  return repo ?? toolError(`repository ${owner}/${name} not found`);
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

const STRING = { type: 'string' } as const;

const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: objectSchema(
      { name: STRING, description: STRING, private: { type: 'boolean' }, owner: STRING },
      ['name'],
    ),
    run: (forge, args) => {
      const name = String(args.name ?? '');
      if (name === '') return toolError('name is required');
      if (forge.getRepo(VIEWER.login, name) !== undefined) return toolError(`repository ${VIEWER.login}/${name} already exists`);
      const repo = forge.createRepo(VIEWER.login, name, typeof args.description === 'string' ? args.description : '', args.private === true);
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING }, ['owner', 'repo']),
    run: (forge, args) => {
      const repo = ownedRepo(forge, args);
      return isToolError(repo) ? repo : repoJson(repo);
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, title: STRING, body: STRING }, ['owner', 'repo', 'title']),
    run: (forge, args) => {
      const repo = ownedRepo(forge, args);
      if (isToolError(repo)) return repo;
      const issue = forge.createIssue(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
      return issueJson(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, state: STRING }, ['owner', 'repo']),
    run: (forge, args) => {
      const repo = ownedRepo(forge, args);
      if (isToolError(repo)) return repo;
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.seq - b.seq);
      return issues.map((issue) => issueJson(repo, issue));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: objectSchema(
      { owner: STRING, repo: STRING, title: STRING, head: STRING, base: STRING, body: STRING },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
    run: (forge, args) => {
      const repo = ownedRepo(forge, args);
      if (isToolError(repo)) return repo;
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      if (repo.branchTip(head) === null) return toolError(`head branch ${head} does not exist`);
      if (repo.branchTip(base) === null) return toolError(`base branch ${base} does not exist`);
      const pull = forge.createPull(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', head, base);
      return pullJson(repo, pull, forge);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: objectSchema(
      { owner: STRING, repo: STRING, pull_number: { type: 'integer' } },
      ['owner', 'repo', 'pull_number'],
    ),
    run: (forge, args) => {
      const repo = ownedRepo(forge, args);
      if (isToolError(repo)) return repo;
      const number = Number(args.pull_number);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return toolError(`pull request ${String(args.pull_number)} not found`);
      if (pull.merged) return toolError('pull request is already merged');
      const outcome = forge.mergePull(repo, pull, 'merge');
      if (!outcome.ok) return toolError('pull request is not mergeable: merge conflict');
      return pullJson(repo, pull, forge);
    },
  },
];

/** The tools/list result: built once, so every call answers the identical bytes. */
const TOOLS_LIST_RESULT = {
  tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
};

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function callTool(forge: Forge, params: Record<string, unknown>): Record<string, unknown> | { __rpcError: { code: number; message: string } } {
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return { __rpcError: { code: -32602, message: `unknown tool: ${name}` } };
  const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
  const required = (tool.inputSchema.required as string[]).filter((key) => args[key] === undefined || args[key] === '');
  if (required.length > 0) {
    return {
      content: [{ type: 'text', text: `missing required argument(s): ${required.join(', ')}` }],
      isError: true,
    };
  }
  const payload = tool.run(forge, args);
  if (isToolError(payload)) {
    return { content: [{ type: 'text', text: payload.__toolError }], isError: true };
  }
  const result: Record<string, unknown> = { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
  if (!Array.isArray(payload)) result.structuredContent = payload;
  return result;
}

function dispatch(forge: Forge, message: Record<string, unknown>): Record<string, unknown> {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = (SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { ...SERVER_INFO } });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, TOOLS_LIST_RESULT);
    case 'tools/call': {
      const outcome = callTool(forge, params);
      if ('__rpcError' in outcome) return rpcError(id, outcome.__rpcError.code, outcome.__rpcError.message);
      return rpcResult(id, outcome);
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

export async function handleMcp(forge: Forge, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    sendJson(res, 400, rpcError(null, -32700, 'Parse error: the body is not valid JSON'));
    return;
  }
  if (Array.isArray(body)) {
    const results = body.map((entry) => dispatch(forge, (entry ?? {}) as Record<string, unknown>));
    sendJson(res, 200, results);
    return;
  }
  const message = (body ?? {}) as Record<string, unknown>;
  // A notification (a method with no id) is acknowledged with an empty 202.
  if (typeof message.method === 'string' && message.id === undefined) {
    sendEmpty(res, 202);
    return;
  }
  sendJson(res, 200, dispatch(forge, message));
}
