import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

export interface ArchiveSpec {
  url: string;
  dest: string;
  sha256: string;
  // Only this subdirectory of the archive lands in dest, its prefix stripped.
  subdir?: string | null;
}

export interface ArchiveResult {
  dest: string;
  cached: boolean;
  files: number;
}

// Written last into dest, holding the archive's sha256. A dest without it is a
// half-finished extract, not a cache hit.
export const ARCHIVE_MARKER = '.opencode-presets-archive';

export async function fetchArchive({ url, dest, sha256, subdir }: ArchiveSpec): Promise<ArchiveResult> {
  if (await markerMatches(dest, sha256)) return { dest, cached: true, files: 0 };

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: HTTP ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = createHash('sha256').update(buf).digest('hex');
  if (actual !== sha256) {
    throw new Error(`sha256 mismatch for ${url}: expected ${sha256}, got ${actual}`);
  }

  const entries = selectEntries(readTar(gunzipSync(buf)), subdir ?? null, url);
  if (!entries.some(e => e.type === 'file')) {
    throw new Error(`archive ${url} has no files${subdir ? ` under ${subdir}/` : ''}`);
  }

  // Extract beside dest and rename into place, so an interrupted install never
  // leaves a dest that looks complete.
  const tmp = `${dest}.tmp-${process.pid}`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  try {
    for (const e of entries) {
      const target = join(tmp, ...e.path.split('/'));
      if (e.type === 'dir') {
        await mkdir(target, { recursive: true });
      } else {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, e.data, { mode: e.mode & 0o111 ? 0o755 : 0o644 });
      }
    }
    await writeFile(join(tmp, ARCHIVE_MARKER), sha256 + '\n');
    await rm(dest, { recursive: true, force: true });
    await rename(tmp, dest);
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  }
  return { dest, cached: false, files: entries.filter(e => e.type === 'file').length };
}

async function markerMatches(dest: string, sha256: string): Promise<boolean> {
  try {
    return (await readFile(join(dest, ARCHIVE_MARKER), 'utf8')).trim() === sha256;
  } catch {
    return false;
  }
}

export interface TarEntry {
  path: string;
  type: 'file' | 'dir';
  mode: number;
  data: Buffer;
}

// Minimal tar reader: ustar plus the pax and GNU long-name records GitHub and
// git archive emit. Only regular files and directories are accepted — a link
// or device entry is how an archive writes outside its own tree, so one of
// those refuses the whole archive rather than being skipped in silence.
export function readTar(tar: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | null = null;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) break;

    const size = parseOctal(header.subarray(124, 136));
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const dataStart = offset + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    if (data.length !== size) throw new Error('tar archive is truncated');
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (typeflag === 'g') continue;
    if (typeflag === 'x') {
      longName = paxPath(data) ?? longName;
      continue;
    }
    if (typeflag === 'L') {
      longName = cString(data);
      continue;
    }

    const name = longName ?? ustarName(header);
    longName = null;

    if (typeflag === '5') {
      entries.push({ path: name, type: 'dir', mode: 0o755, data: Buffer.alloc(0) });
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === '7') {
      entries.push({ path: name, type: 'file', mode: parseOctal(header.subarray(100, 108)), data: Buffer.from(data) });
    } else {
      throw new Error(`tar entry "${name}" has type "${typeflag}": only files and directories are accepted`);
    }
  }
  return entries;
}

// Strip the archive's single top-level directory (`<repo>-<sha>/`), keep only
// `subdir` if given, and refuse any path that could land outside dest.
export function selectEntries(entries: TarEntry[], subdir: string | null, url: string): TarEntry[] {
  const selected: TarEntry[] = [];
  const prefix = subdir ? subdir.replace(/^\/+|\/+$/g, '') + '/' : '';

  for (const e of entries) {
    const parts = e.path.split('/').filter(p => p.length > 0);
    if (e.path.startsWith('/') || parts.some(p => p === '..' || p === '.' || p.includes('\\'))) {
      throw new Error(`archive ${url} has unsafe path "${e.path}"`);
    }
    const rel = parts.slice(1).join('/');
    if (!rel) continue;
    if (prefix && !(rel + '/').startsWith(prefix)) continue;
    const path = rel.slice(prefix.length);
    if (!path) continue;
    // Belt and braces: the joined path must still sit under a fake root.
    const root = resolve(sep, 'root');
    if (!resolve(root, ...path.split('/')).startsWith(root + sep)) {
      throw new Error(`archive ${url} has unsafe path "${e.path}"`);
    }
    selected.push({ ...e, path });
  }
  return selected;
}

function ustarName(header: Buffer): string {
  const name = cString(header.subarray(0, 100));
  const magic = header.subarray(257, 262).toString('latin1');
  const prefix = magic === 'ustar' ? cString(header.subarray(345, 500)) : '';
  return prefix ? `${prefix}/${name}` : name;
}

function paxPath(data: Buffer): string | null {
  let path: string | null = null;
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) break;
    const len = parseInt(data.subarray(i, space).toString('latin1'), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = data.subarray(space + 1, i + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq !== -1 && record.slice(0, eq) === 'path') path = record.slice(eq + 1);
    i += len;
  }
  return path;
}

function cString(buf: Buffer): string {
  const nul = buf.indexOf(0);
  return (nul === -1 ? buf : buf.subarray(0, nul)).toString('utf8');
}

function parseOctal(buf: Buffer): number {
  const s = cString(buf).trim();
  return s ? parseInt(s, 8) : 0;
}
