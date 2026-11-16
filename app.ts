// app.ts — the forge's HTTP server: one process, one in-memory store, four surfaces.
//
//   GET  /healthz                          the suite's boot probe
//   /{owner}/{repo}.git/...                git smart HTTP (lib/githttp.ts)
//   /api/v3/...                            REST v3 (lib/rest.ts)
//   /api/graphql                           GraphQL v4 (lib/graphql.ts)
//   /mcp                                   Model Context Protocol (lib/mcp.ts)
//
// Routing is by path shape alone; every handler answers JSON (or git protocol bytes) and no
// handler throws past this module — an unexpected failure is a 500 with a message, and the
// server keeps serving.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGitRequest } from './lib/githttp.ts';
import { handleGraphql } from './lib/graphql.ts';
import { sendError, sendJson } from './lib/http.ts';
import { handleMcp } from './lib/mcp.ts';
import { handleRest } from './lib/rest.ts';
import { Forge } from './lib/store.ts';

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function route(forge: Forge, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const segments = url.pathname.split('/').filter((part) => part !== '').map(decodeSegment);

  if (url.pathname === '/healthz') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (segments[0] === 'api' && segments[1] === 'graphql') {
    await handleGraphql(forge, token, req, res);
    return;
  }
  if (segments[0] === 'mcp') {
    await handleMcp(forge, token, req, res);
    return;
  }
  if (segments[0] === 'api' && segments[1] === 'v3') {
    await handleRest(forge, token, req, res, { segments: segments.slice(2), query: url.searchParams });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}
  if (segments.length >= 3 && segments[1]!.endsWith('.git')) {
    const tail = segments.slice(2).join('/');
    if (tail === 'info/refs' || tail === 'git-upload-pack' || tail === 'git-receive-pack') {
      await handleGitRequest(forge, token, req, res, { owner: segments[0]!, repo: segments[1]!.slice(0, -4), tail }, url.searchParams);
      return;
    }
  }

  sendError(res, 404, 'Not Found');
}

/** Build the forge's server (not yet listening). */
export function createApp(): Server {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return createServer((req, res) => {
    route(forge, token, req, res).catch((err: unknown) => {
      try {
        if (!res.headersSent) sendError(res, 500, err instanceof Error ? err.message : 'internal error');
        else res.end();
      } catch {
        // The socket is already gone; nothing sensible remains to do.
      }
    });
  });
}
