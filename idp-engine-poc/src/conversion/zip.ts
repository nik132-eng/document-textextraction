import { inflateRawSync } from 'node:zlib';

/**
 * Minimal ZIP reader (central directory + stored/deflate), enough for OOXML/ODF containers.
 * No dependency, and bounded: entries above MAX_ENTRY_BYTES are refused (zip-bomb guard).
 */
const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

export const isZip = (buf: Buffer): boolean => buf.length > 4 && buf.readUInt32LE(0) === LOC_SIG;

export function listZip(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('ZIP_NO_EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) throw new Error('ZIP_BAD_CEN');
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    entries.push({
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      localOffset: buf.readUInt32LE(p + 42),
      name: buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function readZipEntry(buf: Buffer, name: string): Buffer | null {
  const entry = listZip(buf).find((e) => e.name === name);
  if (!entry) return null;
  if (entry.size > MAX_ENTRY_BYTES) throw new Error('ZIP_ENTRY_TOO_LARGE');
  const p = entry.localOffset;
  if (buf.readUInt32LE(p) !== LOC_SIG) throw new Error('ZIP_BAD_LOCAL');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
  throw new Error(`ZIP_METHOD_${entry.method}`);
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 65_557);
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  return -1;
}
