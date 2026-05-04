#!/usr/bin/env node
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { removeAtPath, getAtPath } from '../src/merge.js';
import { backup } from '../src/backup.js';
import { c, confirm, closeUi } from '../src/ui.js';
import { listConfs } from '../src/list.js';
import { runBatch, runRemoveBatch } from '../src/batch.js';
import { validateAgainstSchema } from '../src/validate.js';

const CACHE_DIR = process.env.OPENCODE_PRESETS_CACHE
  ? resolve(process.env.OPENCODE_PRESETS_CACHE)
  : resolve(homedir(), '.cache/opencode-presets');
const BACKUP_DIR = resolve(CACHE_DIR, 'backups');
const TARGET = process.env.OPENCODE_CONFIG
  ? resolve(process.env.OPENCODE_CONFIG)
  : resolve(homedir(), '.config/opencode/opencode.json');

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname is either <repo>/bin (running source via ts) or
// <repo>/dist/bin (running compiled). In both cases the presets dir
// lives next to package.json, which we find by walking up.
const REPO_ROOT = findPackageRoot(__dirname);

function findPackageRoot(start: string): string {
  let dir = start;
  while (true) {
    const parent = dirname(dir);
    if (parent === dir) return start; // hit fs root, give up
    // package.json sibling check happens implicitly by stepping up
    // out of bin/ and dist/. We bail when we reach a dir whose parent
    // matches the package layout.
    if (dir.endsWith('/dist') || dir.endsWith('/bin')) {
      dir = parent;
      continue;
    }
    return dir;
  }
}
// Search path for `list` (in priority order):
//   1. dirs from OPENCODE_PRESETS_PATH (colon-separated; for team/personal repos)
//   2. ./presets/              (CWD-relative, honoured when it exists)
//   3. <repo>/presets/         (shipped baseline)
const DEFAULT_PRESET_DIRS: string[] = [
  ...(process.env.OPENCODE_PRESETS_PATH
    ? process.env.OPENCODE_PRESETS_PATH.split(':').filter(Boolean).map(p => resolve(p))
    : []),
  resolve(process.cwd(), 'presets'),
  resolve(REPO_ROOT, 'presets'),
];

const SCHEMA_URL = 'https://opencode.ai/config.json';
const EMPTY_CONFIG = { '$schema': SCHEMA_URL };

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    printUsage();
    process.exit(argv.length === 0 ? 1 : 0);
  }
  if (argv[0] === '-V' || argv[0] === '--version') {
    const raw = await readFile(resolve(REPO_ROOT, 'package.json'), 'utf8');
    console.log(`v${(JSON.parse(raw) as { version: string }).version}`);
    process.exit(0);
  }

  const sub = argv[0];

  if (sub === 'list') {
    const rest = argv.slice(1);
    const long = rest.includes('-l') || rest.includes('--long');
    const positional = rest.filter(a => a !== '-l' && a !== '--long');
    const dirs = positional[0] ? [resolve(positional[0])] : DEFAULT_PRESET_DIRS;
    await listConfs(dirs, { long, repoRoot: REPO_ROOT });
    return;
  }

  if (sub === 'reset') {
    if (argv.length === 1) { await runResetAll(); return; }
    if (argv.length !== 2) { printUsage(); process.exit(1); }
    await runReset(argv[1]);
    return;
  }

  if (sub === 'install') {
    const { resets, confPaths } = parseInstallArgs(argv.slice(1));
    if (confPaths.length === 0 && resets.length === 0) {
      printUsage();
      process.exit(1);
    }
    const resolved = await Promise.all(confPaths.map(resolveConfArg));
    await runBatch({
      resets,
      confPaths: resolved,
      target: TARGET,
      cacheDir: CACHE_DIR,
      backupDir: BACKUP_DIR,
    });
    return;
  }

  if (sub === 'remove') {
    const args = argv.slice(1);
    if (args.length === 0) { printUsage(); process.exit(1); }
    const resolved = await Promise.all(args.map(resolveConfArg));
    await runRemoveBatch({
      confPaths: resolved,
      target: TARGET,
      cacheDir: CACHE_DIR,
      backupDir: BACKUP_DIR,
    });
    return;
  }

  printUsage();
  process.exit(1);
}

// If `arg` looks like a path (contains a slash, ends in .conf, or
// resolves to an existing file), use it as-is. Otherwise treat it as
// a bare preset name and search DEFAULT_PRESET_DIRS for `<arg>.conf`.
async function resolveConfArg(arg: string): Promise<string> {
  const looksLikePath = arg.includes('/') || arg.endsWith('.conf');
  if (looksLikePath) return resolve(arg);

  for (const dir of DEFAULT_PRESET_DIRS) {
    const candidate = resolve(dir, arg + '.conf');
    if (await fileExists(candidate)) return candidate;
  }
  console.error(c.err('error: ') + `no preset named "${arg}" found in:`);
  for (const dir of DEFAULT_PRESET_DIRS) console.error('  ' + dir);
  console.error('  ' + c.dim('(set OPENCODE_PRESETS_PATH to add more dirs, or pass an explicit path)'));
  process.exit(1);
}

async function fileExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

function parseInstallArgs(args: string[]): { resets: string[]; confPaths: string[] } {
  const resets: string[] = [];
  const confPaths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--reset') {
      const next = args[++i];
      if (!next) { printUsage(); process.exit(1); }
      resets.push(next);
    } else if (a.startsWith('--reset=')) {
      resets.push(a.slice('--reset='.length));
    } else {
      confPaths.push(a);
    }
  }
  return { resets, confPaths };
}

async function runResetAll(): Promise<void> {
  const existing = await loadJsonOrNull(TARGET);
  if (existing === null) {
    console.log(c.dim('opencode.json does not exist — nothing to reset.'));
    return;
  }
  if (JSON.stringify(existing) === JSON.stringify(EMPTY_CONFIG)) {
    console.log(c.dim('opencode.json is already at the minimal baseline — nothing to reset.'));
    return;
  }

  console.log('');
  console.log(c.bold('Target') + c.meta(': ') + TARGET);
  console.log('');
  console.log(c.warn('⚠  reset (no path) wipes the ENTIRE opencode.json and replaces it with'));
  console.log(c.warn('   a minimal baseline:'));
  console.log('');
  console.log('     ' + JSON.stringify(EMPTY_CONFIG, null, 2).replace(/\n/g, '\n     '));
  console.log('');
  console.log(c.warn('   This deletes every preset, every MCP server, every permission rule,'));
  console.log(c.warn('   every hand-edit. Backup is taken first; you can restore from'));
  console.log(c.warn('   ~/.cache/opencode-presets/backups/ if needed.'));
  console.log('');

  const proceed = await confirm('Reset to minimal baseline?');
  if (!proceed) { console.log(c.dim('declined.')); return; }

  await validateOrAbort(EMPTY_CONFIG, 'pre-write');

  let backupPath: string | null = null;
  try { backupPath = await backup(TARGET, BACKUP_DIR); }
  catch (e) {
    console.error(c.err('error: backup failed: ') + (e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }
  if (backupPath) console.log('  ' + c.ok('✓') + ' backed up → ' + c.meta(backupPath));

  await mkdir(dirname(TARGET), { recursive: true });
  const tmp = TARGET + '.tmp';
  await writeFile(tmp, JSON.stringify(EMPTY_CONFIG, null, 2) + '\n', 'utf8');
  await rename(tmp, TARGET);

  await validateWritten();
  console.log('  ' + c.ok('✓') + ' reset to minimal baseline');
}

async function runReset(path: string): Promise<void> {
  const existing = await loadJsonOrNull(TARGET);
  if (existing === null) {
    console.log(c.dim('opencode.json does not exist — nothing to reset.'));
    return;
  }
  const current = getAtPath(existing, path);
  if (current === undefined) {
    console.log(c.dim(`nothing at ${path} — nothing to reset.`));
    return;
  }

  console.log('');
  console.log(c.bold('Target') + c.meta(': ') + TARGET);
  console.log(c.bold('Path  ') + c.meta(': ') + path);
  console.log(c.bold('Current value:'));
  console.log('  ' + c.warn('- ') + truncJson(current, 400));
  console.log('');
  console.log('  ' + c.warn('⚠  reset deletes EVERYTHING at this path, including any rules and'));
  console.log('  ' + c.warn('   entries you set by hand. There is no per-module distinction.'));
  console.log('');

  const proceed = await confirm('Reset?');
  if (!proceed) { console.log(c.dim('declined.')); return; }

  const { next } = removeAtPath(existing, path, undefined, 'replace');

  await validateOrAbort(next, 'pre-write');

  let backupPath: string | null = null;
  try {
    backupPath = await backup(TARGET, BACKUP_DIR);
  } catch (e) {
    console.error(c.err('error: backup failed: ') + (e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }
  if (backupPath) console.log('  ' + c.ok('✓') + ' backed up → ' + c.meta(backupPath));

  await mkdir(dirname(TARGET), { recursive: true });
  const tmp = TARGET + '.tmp';
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  await rename(tmp, TARGET);

  await validateWritten();
  console.log('  ' + c.ok('✓') + ' reset ' + c.bold(path));
}

async function validateOrAbort(config: unknown, phase: 'pre-write' | 'post-write'): Promise<void> {
  const result = await validateAgainstSchema(config, CACHE_DIR);
  if (result.skipped) {
    console.error(c.warn('⚠  ') + result.errors.join('; '));
    return;
  }
  if (result.ok) return;
  if (phase === 'pre-write') {
    console.error('');
    console.error(c.err('✗ ') + c.bold('schema validation failed — would have produced an invalid opencode.json'));
    for (const e of result.errors.slice(0, 12)) console.error('  ' + c.err(e));
    if (result.errors.length > 12) console.error(c.dim(`  … (+${result.errors.length - 12} more)`));
    console.error(c.err('aborting; opencode.json not modified.'));
    process.exit(1);
  } else {
    console.error('');
    console.error(c.err('⚠  post-write validation FAILED — opencode.json on disk does not match the schema.'));
    for (const e of result.errors.slice(0, 12)) console.error('  ' + c.err(e));
  }
}

async function validateWritten(): Promise<void> {
  try {
    const raw = await readFile(TARGET, 'utf8');
    await validateOrAbort(JSON.parse(raw), 'post-write');
  } catch (e) {
    console.error(c.err('⚠  could not re-read written file: ') +
      (e instanceof Error ? e.message : String(e)));
  }
}

function truncJson(value: unknown, max: number): string {
  const s = JSON.stringify(value, null, 2);
  return s.length <= max ? s : s.slice(0, max) + c.dim(` … (${s.length - max} more chars)`);
}

async function loadJsonOrNull(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

function printUsage(): void {
  console.log('Usage:');
  console.log('  opencode-presets list [<dir>] [--long]            list available .conf modules');
  console.log('  opencode-presets install [--reset <path>]... <conf>...');
  console.log('                                                   apply one or more modules');
  console.log('                                                   (with optional pre-resets)');
  console.log('  opencode-presets remove <conf>...                remove one or more installed presets');
  console.log('  opencode-presets reset [<path>]                  wipe a path, or wipe everything');
  console.log('                                                   to the minimal baseline if no path');
  console.log('');
  console.log('Environment:');
  console.log('  OPENCODE_CONFIG         target opencode.json (default ~/.config/opencode/opencode.json)');
  console.log('  OPENCODE_PRESETS_CACHE  cache dir            (default ~/.cache/opencode-presets)');
  console.log('  OPENCODE_PRESETS_PATH   colon-separated extra preset dirs (searched first by `list`,');
  console.log('                          ahead of ./presets and <repo>/presets)');
}

main()
  .then(() => closeUi())
  .catch(e => {
    closeUi();
    console.error(c.err('error: ') + (e instanceof Error ? (e.stack || e.message) : String(e)));
    process.exit(2);
  });
