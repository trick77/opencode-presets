import readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import chalk from 'chalk';
import type { ConfMeta } from './parse-conf.js';

export const c = {
  title: chalk.bold.cyan,
  meta: chalk.gray,
  ok: chalk.green,
  warn: chalk.yellow,
  err: chalk.red,
  info: chalk.cyan,
  dim: chalk.dim,
  bold: chalk.bold,
};

interface Waiter {
  resolve: (line: string) => void;
  reject: (e: Error) => void;
}

let _rl: readline.Interface | null = null;
const _lineQueue: string[] = [];
const _waiters: Waiter[] = [];
let _closed = false;

function ensureRl(): void {
  if (_rl) return;
  _rl = readline.createInterface({ input, output, terminal: false });
  _rl.on('line', (line) => {
    const w = _waiters.shift();
    if (w) w.resolve(line);
    else _lineQueue.push(line);
  });
  _rl.on('close', () => {
    _closed = true;
    let w;
    while ((w = _waiters.shift())) w.reject(new Error('input closed'));
  });
}

function readLine(prompt: string): Promise<string> {
  ensureRl();
  output.write(prompt);
  if (_lineQueue.length > 0) return Promise.resolve(_lineQueue.shift()!);
  if (_closed) return Promise.reject(new Error('input closed'));
  return new Promise<string>((resolve, reject) => _waiters.push({ resolve, reject }));
}

export function closeUi(): void {
  if (_rl) { _rl.close(); _rl = null; }
}

export function header(meta: ConfMeta): string {
  return [
    c.title('▸ ' + meta.name),
    c.meta('v' + meta.version),
    c.meta('by ' + meta.author),
  ].join('  ');
}

// The per-preset block printed before a `remove` confirm. Installs are
// rendered by renderSummary in batch.ts, which is cumulative across a batch
// and can state verified preconditions; this one describes a single preset
// being taken back out.
export function describe(
  meta: ConfMeta,
  target: string,
  currentValue: unknown,
  body: unknown
): string {
  const out: string[] = [];
  out.push(header(meta));
  out.push('');
  out.push(wrap(meta.description, 72, '  '));
  out.push('');
  out.push('  ' + c.bold('Action') + c.meta(' : ') + c.warn('remove'));
  out.push('  ' + c.bold('Target') + c.meta(' : ') + target);
  out.push('  ' + c.bold('Path  ') + c.meta(' : ') + meta.path);
  out.push('  ' + c.bold('Mode  ') + c.meta(' : ') + meta.mode);
  out.push('');
  out.push('  ' + c.bold('Change'));
  out.push(indent(removeDiff(currentValue, body, meta), '    '));

  if (meta.mode === 'merge' || meta.mode === 'merge-overwrite') {
    out.push('');
    out.push('  ' + c.warn('⚠  Remove in merge mode deletes any key whose current value still'));
    out.push('  ' + c.warn('   matches what this module would write. If a key happened to be set'));
    out.push('  ' + c.warn('   to the same value before this module was installed (e.g. you'));
    out.push('  ' + c.warn('   already had "git status *": "allow" before applying'));
    out.push('  ' + c.warn('   permissions-git-safe), remove cannot tell the difference and'));
    out.push('  ' + c.warn('   will delete it. Keys with diverging values are kept untouched.'));
  }

  return out.join('\n');
}

function removeDiff(current: unknown, incoming: unknown, meta: ConfMeta): string {
  if (current === undefined) return c.dim('(nothing at this path — nothing to remove)');
  if (meta.mode === 'replace') {
    return c.warn('- ') + truncJson(current) + '\n' +
           c.dim('(entire value above will be deleted; parent objects pruned if empty)');
  }
  if (meta.mode === 'append') {
    if (!Array.isArray(current)) {
      return c.dim('(value at path is not an array — nothing matchable to remove)');
    }
    const inc = Array.isArray(incoming) ? incoming : [];
    const willRemove = current.filter(value => inc.some(incomingValue => deepEqual(value, incomingValue)));
    const lines = [c.dim(`remove ${willRemove.length} matching entr${willRemove.length === 1 ? 'y' : 'ies'}`)];
    if (willRemove.length > 0) lines.push(c.warn('- ') + sampleValues(willRemove, 5));
    return lines.join('\n');
  }
  if (typeof current !== 'object' || current === null || Array.isArray(current)) {
    return c.dim('(value at path is not an object — nothing matchable to remove)');
  }
  const cur = current as Record<string, unknown>;
  const inc = incoming as Record<string, unknown>;
  const willRemove: string[] = [];
  const willKeep: string[] = [];
  for (const k of Object.keys(inc)) {
    if (!(k in cur)) continue;
    if (deepEqual(cur[k], inc[k])) willRemove.push(k);
    else willKeep.push(k);
  }
  const lines = [c.dim(`remove ${willRemove.length} matching key${willRemove.length === 1 ? '' : 's'}, ` +
                       `keep ${willKeep.length} (value diverged from module)`)];
  if (willRemove.length > 0) lines.push(c.warn('- ') + sample(willRemove, 5));
  return lines.join('\n');
}

function sample(keys: string[], n: number): string {
  if (keys.length <= n) return keys.map(k => JSON.stringify(k)).join(', ');
  const shown = keys.slice(0, n).map(k => JSON.stringify(k)).join(', ');
  return shown + c.dim(` … (+${keys.length - n} more)`);
}

function sampleValues(values: unknown[], n: number): string {
  if (values.length <= n) return values.map(v => JSON.stringify(v)).join(', ');
  const shown = values.slice(0, n).map(v => JSON.stringify(v)).join(', ');
  return shown + c.dim(` … (+${values.length - n} more)`);
}

function truncJson(value: unknown, max = 200): string {
  const s = JSON.stringify(value, null, 2);
  if (s.length <= max) return s;
  return s.slice(0, max) + c.dim(` … (${s.length - max} more chars)`);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (typeof a === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ka = Object.keys(ao), kb = Object.keys(bo);
    return ka.length === kb.length && ka.every(k => deepEqual(ao[k], bo[k]));
  }
  return false;
}

function indent(text: string, prefix: string): string {
  return text.split('\n').map(l => prefix + l).join('\n');
}

// Word-wrap `text` to `width` columns (counting prefix). Preserves
// explicit newlines as paragraph breaks.
export function wrap(text: string, width: number, prefix: string): string {
  const inner = Math.max(20, width - prefix.length);
  return text.split('\n').map(para => {
    const words = para.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
      if (line.length === 0) line = w;
      else if (line.length + 1 + w.length <= inner) line += ' ' + w;
      else { lines.push(line); line = w; }
    }
    if (line) lines.push(line);
    return lines.map(l => prefix + l).join('\n');
  }).join('\n');
}

export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const answer = (await readLine(question + suffix)).trim().toLowerCase();
  if (answer === '') return defaultYes;
  return answer === 'y' || answer === 'yes';
}

export async function promptText(question: string): Promise<string> {
  return (await readLine(question)).trim();
}

// Hidden-input prompt for secrets. No echo to terminal.
export function promptSecret(question: string): Promise<string> {
  if (!input.isTTY) return promptText(question);

  return new Promise<string>((resolve, reject) => {
    closeUi();
    output.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let buf = '';
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (ch === '\n' || ch === '\r' || code === 4) {
          input.setRawMode(false);
          input.pause();
          input.removeListener('data', onData);
          output.write('\n');
          resolve(buf);
          return;
        }
        if (code === 3) {
          input.setRawMode(false);
          input.pause();
          input.removeListener('data', onData);
          output.write('\n');
          reject(new Error('cancelled'));
          return;
        }
        if (code === 127 || code === 8) { buf = buf.slice(0, -1); continue; }
        buf += ch;
      }
    };
    input.on('data', onData);
  });
}
