import { readdir, stat } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { parseConf, type PinDirective } from './parse-conf.js';
import { c, wrap as wrapText } from './ui.js';

interface Row {
  ok: boolean;
  name: string;
  ver: string;
  mode: string;
  path: string;
  description: string;
  pins: PinDirective[];
  file: string;
  source: string;
  error?: string;
  shadowed?: boolean;
}

export async function listConfs(dirs: string[], { long = false, repoRoot }: { long?: boolean; repoRoot: string }): Promise<void> {
  const allRows: Row[] = [];
  let anyExists = false;

  for (const dir of dirs) {
    const exists = await isDir(dir);
    if (!exists) {
      if (dirs.length === 1) {
        console.error(c.err('error: directory not found: ') + dir);
        process.exit(1);
      }
      continue;
    }
    anyExists = true;

    const entries = await readdir(dir);
    const files = entries
      .filter(n => n.endsWith('.conf'))
      .map(n => join(dir, n))
      .sort();

    for (const f of files) {
      try {
        const { meta } = await parseConf(f);
        // A bundle has no @path and no @mode of its own — showing the parser's
        // `replace` default against an empty path would be actively misleading.
        const isBundle = meta.includes.length > 0;
        allRows.push({
          ok: true,
          name: meta.name,
          ver: meta.version,
          mode: isBundle ? 'bundle' : meta.mode,
          path: isBundle ? meta.includes.join(', ') : meta.path,
          description: meta.description,
          pins: meta.pins,
          file: f,
          source: dir,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        allRows.push({
          ok: false,
          name: basename(f).replace(/\.conf$/, ''),
          ver: '-',
          mode: '-',
          path: '-',
          description: '',
          pins: [],
          file: f,
          source: dir,
          error: msg.replace(f + ':', '').trim(),
        });
      }
    }
  }

  if (!anyExists) {
    console.log(c.dim('(no preset directories exist; create ./presets/ or pass a path)'));
    return;
  }
  if (allRows.length === 0) {
    console.log(c.dim('(no .conf files in preset dirs)'));
    return;
  }

  const seen = new Set<string>();
  for (const r of allRows) {
    if (seen.has(r.name)) r.shadowed = true;
    else seen.add(r.name);
  }

  allRows.sort((a, b) => a.name.localeCompare(b.name) || (a.shadowed ? 1 : -1));

  printTable(allRows, dirs, long, repoRoot);
}

function printTable(rows: Row[], dirs: string[], long: boolean, repoRoot: string): void {
  for (const d of dirs) {
    if (rows.some(r => r.source === d)) {
      const tag = sourceTag(d, repoRoot);
      console.log(c.dim('# ') + d + (tag ? c.dim('  ' + tag) : ''));
    }
  }
  console.log('');

  const nameW = Math.max(4, ...rows.map(r => r.name.length));
  const verW  = Math.max(3, ...rows.map(r => r.ver.length));
  const modeW = Math.max(4, ...rows.map(r => r.mode.length));
  const srcW  = dirs.length > 1 ? Math.max(6, ...rows.map(r => sourceShort(r.source, dirs).length)) : 0;

  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));

  let head = c.bold(pad('NAME', nameW)) + '  ' +
             c.bold(pad('VER', verW))   + '  ' +
             c.bold(pad('MODE', modeW)) + '  ';
  if (srcW > 0) head += c.bold(pad('SOURCE', srcW)) + '  ';
  head += c.bold('PATH');
  console.log(head);

  for (const r of rows) {
    const nameCol = r.shadowed ? c.dim(pad(r.name, nameW)) : pad(r.name, nameW);
    let line = nameCol + '  ' + pad(r.ver, verW) + '  ' + pad(r.mode, modeW) + '  ';
    if (srcW > 0) line += pad(sourceShort(r.source, dirs), srcW) + '  ';
    line += truncatePath(r.path, 60);

    if (!r.ok)         line = c.err(line) + '  ' + c.err('! ' + r.error);
    else if (r.shadowed) line += c.dim('  (shadowed by earlier dir)');
    console.log(line);

    if (long && r.ok && r.description) {
      console.log(wrapText(r.description, 76, '    '));
    }
    if (long && r.ok) {
      for (const p of r.pins) {
        console.log(c.dim(`    pins: ${p.name} ${p.version}`));
      }
    }
  }
}

function sourceShort(dir: string, dirs: string[]): string {
  const trail = basename(dir);
  const collisions = dirs.filter(d => basename(d) === trail).length;
  return collisions > 1 ? dir : trail;
}

function sourceTag(dir: string, repoRoot: string): string {
  if (dir === resolve(process.cwd(), 'presets')) return '(local)';
  if (dir === resolve(repoRoot, 'presets')) return '(shipped)';
  return '';
}

function truncatePath(path: string, max: number): string {
  if (path.length <= max) return path;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.4);
  const tail = keep - head;
  return path.slice(0, head) + '…' + path.slice(path.length - tail);
}

async function isDir(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}
