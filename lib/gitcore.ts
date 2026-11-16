// gitcore.ts — the git object model in pure TypeScript over node:crypto and node:zlib.
//
// Everything the forge knows about git lives here: object ids (SHA-1 over the canonical
// "<type> <length>\0" header), commit/tree/tag parsing and serialization, tree construction
// from a flat path map, packfile reading (with OFS/REF delta resolution) and packfile writing
// (plain objects only — the protocol never requires a server to send deltas), and the pkt-line
// framing the smart-HTTP protocol speaks. No git binary is ever invoked.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  /** The object's payload bytes (everything after the "<type> <len>\0" header). */
  data: Buffer;
}

const TYPE_CODES: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of a payload: sha1("<type> <byte length>\0" + payload). */
export function objectId(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ------------------------------------------------------------------------------------------------
// Commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTime: number;
  committerName: string;
  committerEmail: string;
  committerTime: number;
  message: string;
}

const IDENT_RE = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/;

function parseIdent(line: string): { name: string; email: string; time: number } {
  const match = IDENT_RE.exec(line);
  if (match === null) return { name: line, email: '', time: 0 };
  return { name: match[1] ?? '', email: match[2] ?? '', time: Number(match[3] ?? 0) };
}

/** Parse a commit payload. Tolerant of missing fields; never throws on odd input. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const info: CommitInfo = {
    tree: ZERO_OID,
    parents: [],
    authorName: '',
    authorEmail: '',
    authorTime: 0,
    committerName: '',
    committerEmail: '',
    committerTime: 0,
    message,
  };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const ident = parseIdent(line.slice(7));
      info.authorName = ident.name;
      info.authorEmail = ident.email;
      info.authorTime = ident.time;
    } else if (line.startsWith('committer ')) {
      const ident = parseIdent(line.slice(10));
      info.committerName = ident.name;
      info.committerEmail = ident.email;
      info.committerTime = ident.time;
    }
  }
  return info;
}

export interface Identity {
  name: string;
  email: string;
}

/** Serialize a commit with a fixed "+0000" zone, exactly as git writes it. */
export function buildCommitData(input: {
  tree: string;
  parents: readonly string[];
  author: Identity;
  committer: Identity;
  time: number;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author.name} <${input.author.email}> ${input.time} +0000`);
  lines.push(`committer ${input.committer.name} <${input.committer.email}> ${input.time} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}

// ------------------------------------------------------------------------------------------------
// Trees

export interface TreeEntry {
  /** "100644", "100755", "120000", "40000" (directory), "160000" (gitlink). */
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.toString('utf8', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function isDirMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Git's tree order: bytewise by name, directories comparing as if the name ended in "/". */
function treeSortKey(entry: TreeEntry): string {
  return isDirMode(entry.mode) ? `${entry.name}/` : entry.name;
}

export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const ka = treeSortKey(a);
  const kb = treeSortKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

export function buildTreeData(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------------------------------------
// Tags

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  taggerName: string;
  taggerEmail: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const info: TagInfo = { object: ZERO_OID, type: '', tag: '', taggerName: '', taggerEmail: '', message: split === -1 ? '' : text.slice(split + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) {
      const ident = parseIdent(line.slice(7));
      info.taggerName = ident.name;
      info.taggerEmail = ident.email;
    }
  }
  return info;
}

// ------------------------------------------------------------------------------------------------
// Packfiles

/**
 * The number of bytes the zlib stream starting at `offset` occupies inside `buf`, found by a
 * bounded search: `inflateSync` accepts trailing bytes, so the shortest prefix that inflates to
 * exactly `expectedSize` bytes is the stream's true end. Throws when no prefix works.
 */
function zlibStreamLength(buf: Buffer, offset: number, expectedSize: number): number {
  const remaining = buf.length - offset;
  const attempt = (length: number): boolean => {
    try {
      return inflateSync(buf.subarray(offset, offset + length)).length === expectedSize;
    } catch {
      return false;
    }
  };
  if (!attempt(remaining)) throw new Error('pack entry does not inflate');
  // The predicate is monotone: at or past the stream's end inflateSync succeeds (it ignores
  // trailing bytes); before the end the stream is truncated and throws. Binary-search the end.
  let lo = 1;
  let hi = remaining;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (attempt(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

interface RawPackEntry {
  /** The pack type code: 1..4 plain, 6 OFS_DELTA, 7 REF_DELTA. */
  typeCode: number;
  /** The inflated payload (the delta instructions, for delta entries). */
  data: Buffer;
  /** For REF_DELTA: the base's object id. */
  baseRef?: string;
  /** For OFS_DELTA: the byte offset of the base entry in the pack. */
  baseOffset?: number;
}

/** Apply a git delta payload to a base payload. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] ?? 0;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // source size (the base's length; trusted)
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] ?? 0;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) { copyOffset |= delta[offset] ?? 0; offset += 1; }
      if (op & 0x02) { copyOffset |= (delta[offset] ?? 0) << 8; offset += 1; }
      if (op & 0x04) { copyOffset |= (delta[offset] ?? 0) << 16; offset += 1; }
      if (op & 0x08) { copyOffset |= (delta[offset] ?? 0) << 24; offset += 1; }
      if (op & 0x10) { copySize |= delta[offset] ?? 0; offset += 1; }
      if (op & 0x20) { copySize |= (delta[offset] ?? 0) << 8; offset += 1; }
      if (op & 0x40) { copySize |= (delta[offset] ?? 0) << 16; offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta produced the wrong size');
  return result;
}

/**
 * Parse a whole packfile into resolved objects. `resolveExternal` supplies objects the pack's
 * REF_DELTA entries base themselves on but the pack does not carry (thin packs). Returns the
 * objects in pack order. Throws on any structural problem; the caller decides what that means.
 */
export function parsePack(pack: Buffer, resolveExternal?: (oid: string) => GitObject | undefined): GitObject[] {
  if (pack.length < 12 + 20) throw new Error('pack is too short');
  if (pack.toString('utf8', 0, 4) !== 'PACK') throw new Error('pack has no PACK signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not supported`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const checksum = sha1Hex(pack.subarray(0, pack.length - 20));
  if (!trailer.equals(Buffer.from(checksum, 'hex'))) throw new Error('pack checksum mismatch');

  const entries: RawPackEntry[] = [];
  const entryOffsets: number[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryStart = offset;
    let byte = pack[offset] ?? 0;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] ?? 0;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseRef: string | undefined;
    let baseOffset: number | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset to the base entry, in git's offset encoding.
      byte = pack[offset] ?? 0;
      offset += 1;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset] ?? 0;
        offset += 1;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryStart - back;
    } else if (typeCode === 7) {
      baseRef = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    if (CODE_TYPES[typeCode] === undefined && typeCode !== 6 && typeCode !== 7) throw new Error(`pack object type code ${typeCode} is unknown`);
    const streamLength = zlibStreamLength(pack, offset, size);
    const data = inflateSync(pack.subarray(offset, offset + streamLength));
    if (data.length !== size) throw new Error('pack entry inflated to the wrong size');
    offset += streamLength;
    entryOffsets.push(entryStart);
    entries.push({ typeCode, data, baseRef, baseOffset });
  }

  // Resolve deltas: an entry's true type is its base's type.
  const byOffset = new Map<number, number>();
  entryOffsets.forEach((entryOffset, index) => byOffset.set(entryOffset, index));
  const resolved: (GitObject | null)[] = entries.map(() => null);
  const byId = new Map<string, GitObject>();
  const resolve = (index: number): GitObject => {
    const done = resolved[index];
    if (done !== null && done !== undefined) return done;
    const entry = entries[index]!;
    let object: GitObject;
    if (entry.baseRef === undefined && entry.baseOffset === undefined) {
      object = { type: CODE_TYPES[entry.typeCode]!, data: entry.data };
    } else {
      let base: GitObject | undefined;
      if (entry.baseOffset !== undefined) {
        const baseIndex = byOffset.get(entry.baseOffset);
        if (baseIndex === undefined) throw new Error('delta base offset is not in the pack');
        base = resolve(baseIndex);
      } else {
        base = byId.get(entry.baseRef!);
        if (base === undefined) {
          // Resolve the pack's plain entries until the base turns up among them.
          for (let candidate = 0; candidate < entries.length && base === undefined; candidate += 1) {
            const candidateEntry = entries[candidate]!;
            if (candidateEntry.baseRef === undefined && candidateEntry.baseOffset === undefined) {
              const candidateObject = resolve(candidate);
              if (objectId(candidateObject.type, candidateObject.data) === entry.baseRef) base = candidateObject;
            }
          }
        }
        if (base === undefined) {
          const external = resolveExternal?.(entry.baseRef!);
          if (external === undefined) throw new Error(`thin pack base ${entry.baseRef} is not available`);
          base = external;
        }
      }
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    }
    resolved[index] = object;
    byId.set(objectId(object.type, object.data), object);
    return object;
  };
  const objects: GitObject[] = [];
  for (let index = 0; index < entries.length; index += 1) objects.push(resolve(index));
  return objects;
}

/** Serialize objects as a version-2 packfile of plain (non-delta) entries. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'utf8');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    const code = TYPE_CODES[object.type];
    let size = object.data.length;
    const first = size & 0x0f;
    size >>>= 4;
    const headBytes: number[] = [];
    let byte = (code << 4) | first;
    if (size > 0) byte |= 0x80;
    headBytes.push(byte);
    while (size > 0) {
      let next = size & 0x7f;
      size >>>= 7;
      if (size > 0) next |= 0x80;
      headBytes.push(next);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

// ------------------------------------------------------------------------------------------------
// pkt-lines

/** One pkt-line frame: 4 hex digits of total length + payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const prefix = length.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(prefix, 'ascii'), data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Split a buffer into pkt-line frames; throws on a malformed length prefix. */
export function parsePkts(buf: Buffer): Pkt[] {
  const frames: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const hex = buf.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`invalid pkt-line length ${JSON.stringify(hex)}`);
    const length = parseInt(hex, 16);
    if (length === 0) {
      frames.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      frames.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      frames.push({ kind: 'response-end' });
      offset += 4;
    } else if (length < 4 || offset + length > buf.length) {
      throw new Error('pkt-line length out of range');
    } else {
      frames.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return frames;
}

/** A side-band-64k packet: band byte + payload inside one pkt-line. */
export function sidebandPacket(band: 1 | 2 | 3, payload: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), payload]));
}

/** Split `data` into side-band-1 packets of at most 65516 payload bytes each (band byte included in the frame budget). */
export function sidebandWrap(data: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const MAX_PAYLOAD = 65515; // 65519 max frame payload, minus nothing: band byte is part of the payload
  let offset = 0;
  if (data.length === 0) return Buffer.alloc(0);
  while (offset < data.length) {
    const slice = data.subarray(offset, offset + MAX_PAYLOAD);
    chunks.push(sidebandPacket(1, slice));
    offset += slice.length;
  }
  return Buffer.concat(chunks);
}
