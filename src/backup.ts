import { copyFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

// Copy `source` to `<backupDir>/<basename(source)>.<UTC-timestamp>.bak`.
// Timestamp is millisecond-precision UTC; collisions from a single CLI
// invocation are effectively impossible.
// Returns the path of the backup, or null if `source` does not exist.
export async function backup(source: string, backupDir: string): Promise<string | null> {
  if (!(await fileExists(source))) return null;

  await mkdir(backupDir, { recursive: true });

  const base = source.split('/').pop()!;
  const ts = utcTimestamp(new Date());
  const dest = join(backupDir, `${base}.${ts}.bak`);

  await copyFile(source, dest);
  return dest;
}

function utcTimestamp(d: Date): string {
  const pad = (x: number, w = 2) => String(x).padStart(w, '0');
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    pad(d.getUTCMilliseconds(), 3) +
    'Z'
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
