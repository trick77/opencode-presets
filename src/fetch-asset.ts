import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface FetchSpec {
  url: string;
  dest: string;
  sha256?: string | null;
}

export interface FetchResult {
  dest: string;
  cached: boolean;
}

export async function fetchAsset({ url, dest, sha256 }: FetchSpec): Promise<FetchResult> {
  await mkdir(dirname(dest), { recursive: true });

  const exists = await fileExists(dest);
  if (exists) {
    if (sha256) {
      const actual = await sha256Of(dest);
      if (actual === sha256) return { dest, cached: true };
      // checksum mismatch on cached file -> re-download
    } else {
      return { dest, cached: true };
    }
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: HTTP ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());

  if (sha256) {
    const actual = createHash('sha256').update(buf).digest('hex');
    if (actual !== sha256) {
      throw new Error(`sha256 mismatch for ${url}: expected ${sha256}, got ${actual}`);
    }
  }

  await writeFile(dest, buf);
  return { dest, cached: false };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256Of(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}
