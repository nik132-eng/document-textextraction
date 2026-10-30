import { createHash } from 'node:crypto';

export const sha256 = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex');

/** JSON.stringify with sorted object keys, so hashes do not depend on key order. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Uppercase, strip punctuation, collapse spaces (04 §7 normalizeLabel). */
export const normalizeLabel = (s: string): string =>
  s
    .toUpperCase()
    .replace(/[’']/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type SupportedMime = 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/tiff';

/** Magic-byte sniffing; the client-declared content type is never trusted. */
export function detectMime(buf: Buffer): SupportedMime | null {
  if (buf.length < 4) return null;
  if (buf.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const tiffLE = buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00;
  const tiffBE = buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a;
  if (tiffLE || tiffBE) return 'image/tiff';
  return null;
}

export const extensionFor = (mime: SupportedMime): string =>
  ({ 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/tiff': 'tif' })[
    mime
  ];
