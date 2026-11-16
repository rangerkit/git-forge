// githttp.ts — git smart HTTP: the ref advertisements, protocol v2 ls-refs and fetch, the
// protocol v0 fetch fallback, and receive-pack pushes with report-status.
//
// The dialect is the one real git speaks, narrowed to what the wire needs:
//   - upload-pack advertises protocol v2 (ls-refs + fetch, sha1) when the client offers it via
//     the Git-Protocol header, and a v0 ref list otherwise;
//   - receive-pack always advertises v0 with report-status, side-band-64k and delete-refs;
//   - pushes are fast-forward-only, decided per ref, and reported per ref;
//   - fetches send exactly the objects the client lacks: the closure of the wants minus the
//     closure of the haves, cut at the client's shallow boundary and at any requested depth.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  isOid,
  parseCommit,
  parsePack,
  parsePkts,
  parseTag,
  pktLine,
  sidebandPacket,
  sidebandWrap,
  writePack,
  type GitObject,
  type Pkt,
} from './gitcore.ts';
import { authorized, readBody, sendBytes, sendError } from './http.ts';
import type { Forge, Repo } from './store.ts';

const UPLOAD_CAPS_V0 = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not agent=makefun-forge/1.0';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=makefun-forge/1.0';

interface RefLine {
  oid: string;
  name: string;
  symrefTarget?: string;
  peeled?: string;
}

/** Every ref the repo advertises: HEAD first (when born or always, for v0), then refs sorted. */
function advertisedRefs(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const headRef = repo.headRef();
  const headOid = repo.refs.get(headRef);
  if (headOid !== undefined) lines.push({ oid: headOid, name: 'HEAD', symrefTarget: headRef });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { oid, name };
    const object = repo.getObject(oid);
    if (object !== undefined && object.type === 'tag') {
      const target = parseTag(object.data).object;
      const peeled = repo.peelToCommit(oid);
      if (peeled !== null) line.peeled = peeled;
      else if (target !== '') line.peeled = target;
    }
    lines.push(line);
  }
  return lines;
}

/** The v0 advertisement body: service preamble, flush, ref lines (first carries capabilities), flush. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS_V0} symref=HEAD:${repo.headRef()}` : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = advertisedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      let line = `${ref.oid} ${ref.name}`;
      if (index === 0) line += `\0${caps}`;
      parts.push(pktLine(`${line}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 capability advertisement: version line, agent, ls-refs, fetch, object-format, flush. */
function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('agent=makefun-forge/1.0\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

// ------------------------------------------------------------------------------------------------
// Object selection for fetch

interface FetchSelection {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/** Add a tree and everything under it to `into`. */
function addTreeClosure(repo: Repo, treeOid: string, into: Map<string, GitObject>): void {
  const object = repo.getObject(treeOid);
  if (object === undefined || object.type !== 'tree' || into.has(treeOid)) return;
  into.set(treeOid, object);
  for (const entry of parseTreeEntries(repo, treeOid)) {
    if (entry.mode === '40000' || entry.mode === '040000') addTreeClosure(repo, entry.oid, into);
    else {
      const blob = repo.getObject(entry.oid);
      if (blob !== undefined) into.set(entry.oid, blob);
    }
  }
}

function parseTreeEntries(repo: Repo, treeOid: string): { mode: string; oid: string }[] {
  const object = repo.getObject(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  const entries: { mode: string; oid: string }[] = [];
  const data = object.data;
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    entries.push({ mode: data.toString('utf8', offset, space), oid: data.toString('hex', nul + 1, nul + 21) });
    offset = nul + 21;
  }
  return entries;
}

/** The full object closure of a commit: the commit, its ancestors, and every tree and blob. */
function commitClosure(repo: Repo, start: string, cutAt: ReadonlySet<string>, into: Map<string, GitObject>): void {
  const queue: string[] = [start];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.getObject(oid);
    if (object === undefined || object.type !== 'commit' || into.has(oid)) continue;
    into.set(oid, object);
    const commit = repo.commitOf(oid)!;
    addTreeClosure(repo, commit.tree, into);
    if (!cutAt.has(oid)) queue.push(...commit.parents);
  }
}

/**
 * Choose the objects a fetch sends. Wants are peeled through tags; haves exclude their closure
 * (cut at the client's shallow list); a depth keeps only that many generations of the wants and
 * reports the cut commits as shallow, plus any client-shallow commit whose parents now arrive
 * as unshallow.
 */
function selectFetchObjects(repo: Repo, wants: readonly string[], haves: readonly string[], clientShallow: readonly string[], depth: number | null): FetchSelection {
  const shallowSet = new Set(clientShallow);
  // What the client already holds.
  const held = new Map<string, GitObject>();
  for (const have of haves) {
    const commit = repo.peelToCommit(have);
    if (commit !== null) commitClosure(repo, commit, shallowSet, held);
    const object = repo.getObject(have);
    if (object !== undefined && object.type === 'tag') held.set(have, object);
  }

  // What the client asks for: tag objects plus commit generations.
  const included = new Map<string, GitObject>();
  const includedCommits = new Set<string>();
  const generations = new Map<string, number>();
  let frontier: string[] = [];
  for (const want of wants) {
    const object = repo.getObject(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      if (!held.has(want)) included.set(want, object);
      const commit = repo.peelToCommit(want);
      if (commit !== null && !generations.has(commit)) {
        generations.set(commit, 1);
        frontier.push(commit);
      }
    } else if (object.type === 'commit') {
      if (!generations.has(want)) {
        generations.set(want, 1);
        frontier.push(want);
      }
    } else if (!held.has(want)) {
      included.set(want, object);
    }
  }
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      const generation = generations.get(oid)!;
      if (depth !== null && generation > depth) continue;
      const object = repo.getObject(oid);
      if (object === undefined || object.type !== 'commit') continue;
      includedCommits.add(oid);
      const commit = repo.commitOf(oid)!;
      if (!held.has(oid)) {
        included.set(oid, object);
        addTreeClosure(repo, commit.tree, included);
      }
      if (depth === null || generation < depth) {
        for (const parent of commit.parents) {
          if (!generations.has(parent)) {
            generations.set(parent, generation + 1);
            next.push(parent);
          }
        }
      }
    }
    frontier = next;
  }
  for (const oid of [...included.keys()]) {
    if (held.has(oid) && !wants.includes(oid)) included.delete(oid);
  }

  // Shallow bookkeeping.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const oid of includedCommits) {
      if (held.has(oid)) continue;
      const commit = repo.commitOf(oid);
      if (commit === null) continue;
      const cut = commit.parents.some((parent) => !includedCommits.has(parent) && !held.has(parent) && repo.getObject(parent) !== undefined);
      if (cut) shallow.push(oid);
    }
  }
  for (const oid of clientShallow) {
    const commit = repo.commitOf(oid);
    if (commit === null) continue;
    if (shallow.includes(oid)) continue;
    const parentsArrive = commit.parents.length > 0 && commit.parents.every((parent) => includedCommits.has(parent) || held.has(parent));
    if (parentsArrive) unshallow.push(oid);
  }

  // Order: tags, then commits (generation order), then trees and blobs — any order parses, this
  // one keeps packs readable.
  const ordered: GitObject[] = [];
  const seen = new Set<string>();
  const push = (oid: string): void => {
    if (seen.has(oid)) return;
    const object = included.get(oid);
    if (object === undefined) return;
    seen.add(oid);
    ordered.push(object);
  };
  for (const oid of included.keys()) if (included.get(oid)!.type === 'tag') push(oid);
  for (const oid of generations.keys()) if (includedCommits.has(oid)) push(oid);
  for (const oid of included.keys()) push(oid);
  return { objects: ordered, shallow, unshallow };
}

// ------------------------------------------------------------------------------------------------
// ls-refs (protocol v2)

function handleLsRefs(repo: Repo, args: readonly string[]): Buffer {
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));

  const parts: Buffer[] = [];
  const headRef = repo.headRef();
  if (matches('HEAD')) {
    const headOid = repo.refs.get(headRef);
    if (headOid !== undefined) {
      let line = `${headOid} HEAD`;
      if (wantSymrefs) line += ` symref-target:${headRef}`;
      parts.push(pktLine(`${line}\n`));
    } else if (wantUnborn) {
      let line = 'unborn HEAD';
      if (wantSymrefs) line += ` symref-target:${headRef}`;
      parts.push(pktLine(`${line}\n`));
    }
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    const object = repo.getObject(oid);
    if (wantPeel && object !== undefined && object.type === 'tag') {
      const peeled = repo.peelToCommit(oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------------------------------------
// fetch (protocol v2 and v0)

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

function parseFetchArgs(args: readonly string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) request.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const value = Number(arg.slice(7).trim());
      if (Number.isFinite(value) && value > 0) request.depth = Math.trunc(value);
    } else if (arg === 'done') request.done = true;
  }
  return request;
}

/** A v2 fetch reply: acknowledgments (when haves), shallow-info (when cutting), then the packfile section. */
function v2FetchReply(repo: Repo, request: FetchRequest): Buffer {
  const selection = selectFetchObjects(repo, request.wants, request.haves, request.shallow, request.depth);
  const pack = writePack(selection.objects);
  const sections: Buffer[][] = [];
  if (request.haves.length > 0) {
    const lines: Buffer[] = [pktLine('acknowledgments\n')];
    const common = request.haves.filter((have) => repo.getObject(have) !== undefined);
    if (common.length === 0) lines.push(pktLine('NAK\n'));
    else for (const have of common) lines.push(pktLine(`ACK ${have}\n`));
    sections.push(lines);
  }
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    const lines: Buffer[] = [pktLine('shallow-info\n')];
    for (const oid of selection.shallow) lines.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) lines.push(pktLine(`unshallow ${oid}\n`));
    sections.push(lines);
  }
  const packLines: Buffer[] = [pktLine('packfile\n'), sidebandWrap(pack)];
  sections.push(packLines);

  const parts: Buffer[] = [];
  sections.forEach((lines, index) => {
    parts.push(...lines);
    parts.push(index === sections.length - 1 ? PKT_FLUSH : PKT_DELIM);
  });
  return Buffer.concat(parts);
}

/** A v0 fetch reply: shallow lines, NAK, then the pack in side-band-64k packets and a flush. */
function v0FetchReply(repo: Repo, request: FetchRequest, sideband: boolean): Buffer {
  const selection = selectFetchObjects(repo, request.wants, request.haves, request.shallow, request.depth);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  if (sideband) {
    parts.push(sidebandWrap(pack));
    parts.push(PKT_FLUSH);
  } else {
    parts.push(pack);
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------------------------------------
// receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Apply one push: unpack the pack into the repo, then decide each ref update on its own —
 * creates and deletes always allowed, updates fast-forward-only. Answers the report-status
 * stream (framed in side-band-1 packets when the client asked for side-band-64k).
 */
function handlePush(repo: Repo, commands: readonly PushCommand[], packBytes: Buffer | null, sideband: boolean): Buffer {
  let unpackOk = true;
  let unpackDetail = '';
  if (packBytes !== null && packBytes.length > 0) {
    try {
      const objects = parsePack(packBytes, (oid) => repo.getObject(oid));
      for (const object of objects) repo.storeObject(object.type, object.data);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }

  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : `unpack error ${unpackDetail}\n`];
  for (const command of commands) {
    const fail = (reason: string): void => {
      reportLines.push(`ng ${command.ref} ${reason}\n`);
    };
    if (!unpackOk) {
      fail('unpack failed');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      // A deletion.
      if (current === ZERO_OID) {
        fail('reference does not exist');
        continue;
      }
      if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        fail('stale ref');
        continue;
      }
      repo.refs.delete(command.ref);
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    const newCommit = repo.peelToCommit(command.newOid);
    if (newCommit === null) {
      fail('new object is not a commit');
      continue;
    }
    if (current !== ZERO_OID) {
      if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        fail('stale ref');
        continue;
      }
      const currentCommit = repo.peelToCommit(current);
      if (currentCommit !== null && currentCommit !== newCommit && !repo.isAncestor(currentCommit, newCommit)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }

  const report = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
  if (!sideband) return report;
  const parts: Buffer[] = [];
  let offset = 0;
  const MAX = 65519 - 1; // frame payload budget minus the band byte
  while (offset < report.length) {
    const slice = report.subarray(offset, offset + MAX);
    parts.push(sidebandPacket(1, slice));
    offset += slice.length;
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------------------------------------
// Routing

function dataLines(frames: Pkt[]): string[] {
  const lines: string[] = [];
  for (const frame of frames) {
    if (frame.kind === 'data') lines.push(frame.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

/** Split a command stream at its first flush: the frames before it, and the raw bytes after. */
function splitAtFirstFlush(body: Buffer): { frames: Pkt[]; rest: Buffer } {
  let offset = 0;
  const frames: Pkt[] = [];
  while (offset + 4 <= body.length) {
    const hex = body.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('invalid pkt-line length');
    const length = parseInt(hex, 16);
    if (length === 0) {
      frames.push({ kind: 'flush' });
      offset += 4;
      return { frames, rest: body.subarray(offset) };
    }
    if (length === 1) {
      frames.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      frames.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) throw new Error('pkt-line length out of range');
    frames.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { frames, rest: body.subarray(offset) };
}

export interface GitRoute {
  owner: string;
  repo: string;
  /** "info/refs" or the service name ("git-upload-pack" / "git-receive-pack"). */
  tail: string;
}

/** Handle one git smart-HTTP request. `repo` is undefined when the repository does not exist. */
export async function handleGitRequest(
  forge: Forge,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
  route: GitRoute,
  query: URLSearchParams,
): Promise<void> {
  void forge;
  if (!authorized(req, token)) {
    sendError(res, 401, 'Unauthorized');
    return;
  }
  const repo = forge.getRepo(route.owner, route.repo);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }

  if (route.tail === 'info/refs' && req.method === 'GET') {
    const service = query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendError(res, 400, 'service parameter required');
      return;
    }
    const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
    const body = wantsV2 ? v2Advertisement() : v0Advertisement(repo, service);
    sendBytes(res, 200, `application/x-${service}-advertisement`, body);
    return;
  }

  if (route.tail === 'git-upload-pack' && req.method === 'POST') {
    const raw = await readBody(req);
    let frames: Pkt[];
    try {
      frames = parsePkts(raw);
    } catch {
      sendError(res, 400, 'malformed pkt-line stream');
      return;
    }
    const lines = dataLines(frames);
    const commandLine = lines.find((line) => line.startsWith('command='));
    if (commandLine === 'command=ls-refs') {
      const args = lines.slice(lines.indexOf(commandLine) + 1);
      sendBytes(res, 200, 'application/x-git-upload-pack-result', handleLsRefs(repo, args));
      return;
    }
    if (commandLine === 'command=fetch') {
      const args = lines.slice(lines.indexOf(commandLine) + 1);
      sendBytes(res, 200, 'application/x-git-upload-pack-result', v2FetchReply(repo, parseFetchArgs(args)));
      return;
    }
    // Protocol v0 fetch: want lines, a flush, have lines, done.
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    let sideband = false;
    for (const line of lines) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const oid = rest.split(' ')[0] ?? '';
        if (isOid(oid)) wants.push(oid);
        if (rest.includes('side-band-64k')) sideband = true;
        if (rest.includes('deepen ')) {
          const match = /deepen (\d+)/.exec(rest);
          if (match !== null) depth = Number(match[1]);
        }
      } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    }
    sendBytes(res, 200, 'application/x-git-upload-pack-result', v0FetchReply(repo, { wants, haves, shallow, depth, done: true }, sideband));
    return;
  }

  if (route.tail === 'git-receive-pack' && req.method === 'POST') {
    const raw = await readBody(req);
    let split: { frames: Pkt[]; rest: Buffer };
    try {
      split = splitAtFirstFlush(raw);
    } catch {
      sendError(res, 400, 'malformed pkt-line stream');
      return;
    }
    const commands: PushCommand[] = [];
    let sideband = false;
    let reportStatus = false;
    split.frames.forEach((frame, index) => {
      if (frame.kind !== 'data') return;
      let text = frame.payload.toString('utf8');
      if (index === 0) {
        const nul = text.indexOf('\0');
        if (nul !== -1) {
          const caps = text.slice(nul + 1);
          if (caps.includes('side-band-64k')) sideband = true;
          if (caps.includes('report-status')) reportStatus = true;
          text = text.slice(0, nul);
        }
      }
      const parts = text.replace(/\n$/, '').split(' ');
      if (parts.length === 3 && isOid(parts[0]!) && isOid(parts[1]!)) {
        commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
      }
    });
    void reportStatus;
    const reply = handlePush(repo, commands, split.rest.length > 0 ? split.rest : null, sideband);
    sendBytes(res, 200, 'application/x-git-receive-pack-result', reply);
    return;
  }

  sendError(res, 404, 'Not Found');
}
