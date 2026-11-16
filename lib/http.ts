// http.ts — the small HTTP plumbing every surface shares: request bodies, JSON replies with
// the request-id header the protocol checks require, bearer auth, and JSON body parsing with
// the malformed-body 400 the suite expects.

import type { IncomingMessage, ServerResponse } from 'node:http';

let requestCounter = 0;

/** A non-empty, unique-per-process request id. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Read a request body whole (bounded; the packs this forge sees are a few hundred KiB). */
export async function readBody(req: IncomingMessage, limit = 256 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > limit) throw new HttpError(413, 'request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Send a JSON reply with the forge's standard headers. */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    'x-oauth-scopes': 'repo, user',
  });
  res.end(text);
}

/** Send a binary reply (git protocol payloads). */
export function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

/** Send a header-only reply (204s, MCP notification acknowledgements). */
export function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId(), 'content-length': 0 });
  res.end();
}

/** The {message} error shape every REST error carries. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/**
 * Whether the request carries the trial's bearer token. When the process was started without
 * MAKEFUN_SHOP_TOKEN (a local smoke run), any bearer token is accepted but a missing one is
 * still a 401, matching the suite's anonymous-client expectations.
 */
export function authorized(req: IncomingMessage, expectedToken: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer (.+)$/.exec(header);
  if (match === null) return false;
  if (expectedToken === '') return true;
  return match[1] === expectedToken;
}

/** Parse a JSON request body; a malformed body is the protocol check's 400. */
export function parseJsonBody(raw: Buffer): Record<string, unknown> {
  if (raw.length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  return value as Record<string, unknown>;
}

export function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

export function boolField(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  return typeof value === 'boolean' ? value : undefined;
}
