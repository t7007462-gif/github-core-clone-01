// git.ts — pure git plumbing: objects, packs, pkt-lines, reachability.
// No dependencies: node:crypto for sha1, node:zlib for pack deflate/inflate.
// Everything here works on raw bytes so pushed objects round-trip exactly.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** sha1 of the canonical "<type> <len>\0<data>" framing. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function storeObject(objects: Map<string, GitObject>, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

// -------------------------------------------------------------------------------------------
// commits / trees / tags
// -------------------------------------------------------------------------------------------

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export interface Identity {
  name: string;
  email: string;
  timestamp: number; // epoch seconds
}

export function formatIdentity(id: Identity): string {
  return `${id.name} <${id.email}> ${id.timestamp} +0000`;
}

export function buildCommit(args: {
  tree: string;
  parents: readonly string[];
  author: Identity;
  committer: Identity;
  message: string;
}): Buffer {
  const msg = args.message;
  let text = `tree ${args.tree}\n`;
  for (const parent of args.parents) text += `parent ${parent}\n`;
  text += `author ${formatIdentity(args.author)}\n`;
  text += `committer ${formatIdentity(args.committer)}\n`;
  text += `\n${msg}`;
  return Buffer.from(text, 'utf8');
}

export interface TreeEntry {
  mode: string; // '100644' | '100755' | '120000' | '40000' | '160000'
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  // git sorts directories as if their name had a trailing slash
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message,
  };
}

// -------------------------------------------------------------------------------------------
// reachability
// -------------------------------------------------------------------------------------------

/** All objects reachable from the given tips (commits walk parents + trees; tags peel). */
export function collectReachable(
  lookup: (oid: string) => GitObject | undefined,
  tips: Iterable<string>,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const tip of tips) {
    if (tip !== ZERO_OID && isOid(tip) && !seen.has(tip)) {
      seen.add(tip);
      queue.push(tip);
    }
  }
  while (queue.length > 0) {
    const oid = queue.pop()!;
    const object = lookup(oid);
    if (!object) continue;
    const visit = (next: string) => {
      if (next !== ZERO_OID && isOid(next) && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    };
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      visit(commit.tree);
      for (const parent of commit.parents) visit(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) visit(entry.oid);
    } else if (object.type === 'tag') {
      visit(parseTag(object.data).object);
    }
  }
  return seen;
}

// -------------------------------------------------------------------------------------------
// pkt-lines
// -------------------------------------------------------------------------------------------

export function pktLine(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length + 4;
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'utf8');
  return Buffer.concat([header, payload]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'utf8');
}

export function pktBinary(payload: Buffer): Buffer {
  const len = payload.length + 4;
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'utf8');
  return Buffer.concat([header, payload]);
}

export interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Parse a pkt-line stream; trailing bytes after the last packet are ignored. */
export function parsePktLines(buffer: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const lenHex = buffer.subarray(offset, offset + 4).toString('utf8');
    const len = Number.parseInt(lenHex, 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (offset + len > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return packets;
}

// -------------------------------------------------------------------------------------------
// packfiles
// -------------------------------------------------------------------------------------------

const PACK_TYPE_NUM: Record<number, ObjectType | 'ofs-delta' | 'ref-delta'> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs-delta',
  7: 'ref-delta',
};

function readVarint(buffer: Buffer, offset: number): { value: number; offset: number } {
  let value = buffer[offset] & 0x7f;
  let shift = 7;
  offset += 1;
  while (buffer[offset - 1] & 0x80) {
    value |= (buffer[offset] & 0x7f) << shift;
    shift += 7;
    offset += 1;
  }
  return { value, offset };
}

// Node's streaming Inflate reports consumed bytes only asynchronously, so pack
// boundaries are found with inflateSync instead: it succeeds (ignoring trailing
// garbage) exactly when the slice holds a complete zlib stream, which is
// monotonic in the slice length, so a binary search finds the boundary.
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; consumed: number } {
  const remaining = buffer.length - offset;
  const tryInflate = (length: number): Buffer | null => {
    try {
      return inflateSync(buffer.subarray(offset, offset + length));
    } catch {
      return null;
    }
  };
  let low = 1;
  let high = remaining;
  let found: Buffer | null = tryInflate(high);
  if (found === null) throw new Error('zlib stream did not terminate');
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const attempt = tryInflate(mid);
    if (attempt !== null) {
      high = mid;
      found = attempt;
    } else {
      low = mid + 1;
    }
  }
  return { data: found!, consumed: high };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarintDelta = (): number => {
    let value = 0;
    let shift = 0;
    while (true) {
      const byte = delta[offset++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readVarintDelta();
  const targetSize = readVarintDelta();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset |= delta[offset++] << (bit * 8);
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) copySize |= delta[offset++] << (bit * 8);
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta has a zero opcode');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize) throw new Error(`delta produced ${out.length} bytes, expected ${targetSize}`);
  return out;
}

export interface ReadPackResult {
  objects: GitObject[];
}

/** Read a pack v2/v3: plain objects plus OFS_DELTA / REF_DELTA resolution. */
export function readPack(buffer: Buffer): ReadPackResult {
  if (buffer.length < 12 || buffer.subarray(0, 4).toString('utf8') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buffer.readUInt32BE(8);
  let offset = 12;
  const raw: Array<{ type: ObjectType | 'ofs-delta' | 'ref-delta'; data: Buffer; oid: string; baseOid?: string; baseOffset?: number }> = [];
  const offsetToIndex = new Map<number, number>();
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = buffer[offset++];
    const typeNum = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buffer[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const type = PACK_TYPE_NUM[typeNum];
    if (!type) throw new Error(`unknown pack object type ${typeNum}`);
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (type === 'ofs-delta') {
      let b = buffer[offset++];
      let base = b & 0x7f;
      while (b & 0x80) {
        b = buffer[offset++];
        base = ((base + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - base;
    } else if (type === 'ref-delta') {
      baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const { data, consumed } = inflateAt(buffer, offset);
    offset += consumed;
    if (data.length !== size) throw new Error(`pack object size mismatch: got ${data.length}, expected ${size}`);
    offsetToIndex.set(start, index);
    if (type === 'ofs-delta' || type === 'ref-delta') {
      raw.push({ type, data, oid: '', baseOid, baseOffset });
    } else {
      raw.push({ type: type as ObjectType, data, oid: hashObject(type as ObjectType, data) });
    }
  }
  // Resolve deltas (bases may appear later in the pack).
  const resolved: Array<GitObject | null> = raw.map((entry) =>
    entry.type === 'ofs-delta' || entry.type === 'ref-delta' ? null : { type: entry.type as ObjectType, data: entry.data },
  );
  const resolve = (index: number, depth: number): GitObject => {
    if (depth > 1000) throw new Error('delta chain too deep');
    const existing = resolved[index];
    if (existing) return existing;
    const entry = raw[index];
    let base: GitObject;
    if (entry.type === 'ofs-delta') {
      const baseIndex = offsetToIndex.get(entry.baseOffset!);
      if (baseIndex === undefined) throw new Error('ofs-delta base not in pack');
      base = resolve(baseIndex, depth + 1);
    } else {
      // ref-delta against an object already in this pack, by oid
      const baseIndex = raw.findIndex((candidate) => candidate.oid === entry.baseOid);
      if (baseIndex < 0) throw new Error('ref-delta base not in pack');
      base = resolve(baseIndex, depth + 1);
    }
    const data = applyDelta(base.data, entry.data);
    const object = { type: base.type, data };
    resolved[index] = object;
    raw[index].oid = hashObject(base.type, data);
    return object;
  };
  const objects: GitObject[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    objects.push(resolve(index, 0));
  }
  return { objects };
}

/** Write a pack v2 with plain (undeltified) objects and the sha1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'utf8');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  const typeNum: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const object of objects) {
    const size = object.data.length;
    const first: number[] = [];
    let remaining = size;
    let byte = (typeNum[object.type] << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) byte |= 0x80;
    first.push(byte);
    while (remaining > 0) {
      let next = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) next |= 0x80;
      first.push(next);
    }
    parts.push(Buffer.from(first));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
