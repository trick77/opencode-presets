import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { parseConf } from './parse-conf.js';
import type { ConfMeta, FetchDirective } from './parse-conf.js';
import { applyAtPath, removeAtPath, getAtPath } from './merge.js';
import type { ApplyStats, RemoveStats, MergeMode } from './merge.js';
import { fetchAsset } from './fetch-asset.js';
import { backup } from './backup.js';
import { c, confirm, promptText, promptSecret, describe, wrap } from './ui.js';
import { validateAgainstSchema } from './validate.js';

const SCHEMA_URL = 'https://opencode.ai/config.json';
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

type Json = unknown;
type JsonObject = Record<string, unknown>;

interface BatchModule {
  confPath: string;
  meta: ConfMeta;
  body: Json;
  promptValues?: Record<string, string>;
  resolvedPath?: string;
  stats?: ApplyStats & { preservedBatch: number; preservedExisting: number };
}

interface RemoveModule {
  meta: ConfMeta;
  body: Json;
  expandedBody: Json;
  stats?: RemoveStats;
}

interface ResetStat {
  path: string;
  beforeKeyCount: number;
  removed: number;
  missing: boolean;
}

export interface RunBatchOpts {
  resets: string[];
  confPaths: string[];
  target: string;
  cacheDir: string;
  backupDir: string;
}

export interface RunRemoveBatchOpts {
  confPaths: string[];
  target: string;
  cacheDir: string;
  backupDir: string;
}

// Run a batch consisting of zero or more --reset paths followed by
// zero or more module installs. Either side may be empty.
export async function runBatch({ resets, confPaths, target, cacheDir, backupDir }: RunBatchOpts): Promise<void> {
  const modules: BatchModule[] = [];
  for (const cp of confPaths) {
    try {
      const parsed = await parseConf(cp);
      modules.push({ confPath: cp, meta: parsed.meta, body: parsed.body });
    } catch (e) {
      console.error(c.err('error: ') + (e instanceof Error ? e.message : String(e)));
      process.exit(2);
    }
  }

  const existing = await loadJsonOrNull(target);

  console.log('');
  console.log(renderSummary({ resets, modules, existing, target }));
  console.log('');

  if (resets.length + modules.length === 0) {
    console.log(c.dim('nothing to do.'));
    return;
  }

  const proceed = await confirm(`Apply ${resets.length} reset(s) + ${modules.length} install(s)?`);
  if (!proceed) {
    console.log(c.dim('declined.'));
    return;
  }

  // ── Collect prompts per module ──
  for (const m of modules) {
    if (m.meta.prompts.length === 0) continue;
    console.log('');
    console.log(c.bold(m.meta.name) + c.dim(' — inputs:'));
    m.promptValues = {};
    for (const p of m.meta.prompts) {
      const label = '  ' + c.bold(p.name) +
        (p.help ? c.meta(' (' + p.help + ')') : '') + ': ';
      const val = p.type === 'secret' ? await promptSecret(label) : await promptText(label);
      if (!val) {
        console.error(c.err(`error: prompt "${p.name}" cannot be empty`));
        process.exit(1);
      }
      if (p.name === 'name' && !ID_RE.test(val)) {
        console.error(c.err(`error: invalid identifier "${val}" — must match ${ID_RE.source}`));
        process.exit(1);
      }
      m.promptValues[p.name] = val;
    }
  }

  // ── Run all fetches ──
  for (const m of modules) {
    for (const f of m.meta.fetch) {
      f.dest = expandCacheStr(f.dest, cacheDir);
      try {
        const r = await fetchAsset(f as FetchDirective);
        console.log('  ' + c.ok('✓') + ' ' + (r.cached ? 'cached ' : 'fetched ') + c.meta(f.dest));
      } catch (e) {
        console.error(c.err('error: ') + (e instanceof Error ? e.message : String(e)));
        process.exit(1);
      }
    }
  }

  // ── Compute cumulative new root ──
  const startRoot: JsonObject = (existing ?? { '$schema': SCHEMA_URL }) as JsonObject;
  let working: JsonObject = structuredCloneSafe(startRoot);

  const preBatchKeysByPath: Record<string, Set<string>> = {};

  const resetStats: ResetStat[] = [];
  for (const path of resets) {
    const before = getAtPath(working, path);
    const beforeKeyCount = isPlainObject(before)
      ? Object.keys(before).length
      : (before === undefined ? 0 : 1);
    const { next, stats } = removeAtPath(working, path, undefined, 'replace');
    working = next;
    resetStats.push({ path, beforeKeyCount, removed: stats.removed, missing: stats.missing });
  }

  for (const m of modules) {
    const fullBody = expandPromptsInValue(
      expandCacheInValue(m.body, cacheDir),
      m.promptValues || {}
    );
    const fullPath = expandPromptsStr(
      expandCacheStr(m.meta.path, cacheDir),
      m.promptValues || {}
    );
    m.resolvedPath = fullPath;

    if (!preBatchKeysByPath[fullPath]) {
      const startVal = getAtPath(startRoot, fullPath);
      preBatchKeysByPath[fullPath] = isPlainObject(startVal)
        ? new Set(Object.keys(startVal))
        : new Set();
    }
    const beforeThisModule = getAtPath(working, fullPath);
    const beforeKeys = isPlainObject(beforeThisModule)
      ? new Set(Object.keys(beforeThisModule))
      : new Set<string>();

    const { next, stats } = applyAtPath(working, fullPath, fullBody, m.meta.mode);
    working = next;

    let preservedBatch = 0;
    if ((m.meta.mode === 'merge' || m.meta.mode === 'merge-overwrite') && isPlainObject(fullBody)) {
      const preBatch = preBatchKeysByPath[fullPath];
      for (const k of Object.keys(fullBody)) {
        if (beforeKeys.has(k) && !preBatch.has(k)) preservedBatch++;
      }
    }

    m.stats = { ...stats, preservedBatch, preservedExisting: stats.preserved - preservedBatch };
  }

  const isNoOp = existing !== null && JSON.stringify(working) === JSON.stringify(existing);
  if (isNoOp) {
    console.log('');
    console.log('  ' + c.dim('· no change — opencode.json untouched, no backup written'));
    return;
  }

  // ── Pre-write validation: abort if the resulting JSON would be invalid.
  await validateOrAbort(working, cacheDir, 'pre-write');

  let backupPath: string | null = null;
  try {
    backupPath = await backup(target, backupDir);
  } catch (e) {
    console.error(c.err('error: backup failed: ') + (e instanceof Error ? e.message : String(e)));
    console.error(c.err('aborting; opencode.json not modified.'));
    process.exit(1);
  }
  if (backupPath) console.log('  ' + c.ok('✓') + ' backed up → ' + c.meta(backupPath));

  await mkdir(dirname(target), { recursive: true });
  const tmp = target + '.tmp';
  await writeFile(tmp, JSON.stringify(working, null, 2) + '\n', 'utf8');
  await rename(tmp, target);

  // ── Post-write sanity check: re-read what we just wrote and re-validate.
  await validateAfterWrite(target, cacheDir);

  console.log('');
  console.log(renderFooter({ resetStats, modules, backupPath }));
}

function renderSummary(
  { resets, modules, existing, target }:
  { resets: string[]; modules: BatchModule[]; existing: JsonObject | null; target: string }
): string {
  const lines: string[] = [];
  lines.push(c.bold('Target') + c.meta(': ') + target);
  lines.push('');

  if (resets.length > 0) {
    lines.push('  ' + c.warn('Will RESET:'));
    for (const path of resets) {
      const cur = existing ? getAtPath(existing, path) : undefined;
      const desc = cur === undefined
        ? c.dim('(nothing currently at this path)')
        : isPlainObject(cur)
          ? c.dim(`(currently: ${Object.keys(cur).length} key${Object.keys(cur).length === 1 ? '' : 's'}; will be deleted)`)
          : c.dim('(currently set; will be deleted)');
      lines.push('    • ' + path + '  ' + desc);
    }
    lines.push('    ' + c.warn('⚠  Reset deletes EVERYTHING at the path, including hand-edits.'));
    lines.push('');
  }

  if (modules.length > 0) {
    lines.push('  ' + c.ok('Will INSTALL:'));
    for (const m of modules) {
      lines.push('    • ' + c.bold(m.meta.name) + c.meta(` v${m.meta.version}`) +
        c.dim(` → ${m.meta.path}`) + ' ' + colorMode(m.meta.mode));
      lines.push(wrap(m.meta.description, 72, '        '));
    }
    const totalFetches = modules.reduce((n, m) => n + m.meta.fetch.length, 0);
    const totalPrompts = modules.reduce((n, m) => n + m.meta.prompts.length, 0);
    if (totalFetches > 0 || totalPrompts > 0) {
      const bits: string[] = [];
      if (totalFetches > 0) bits.push(`${totalFetches} fetch${totalFetches === 1 ? '' : 'es'}`);
      if (totalPrompts > 0) bits.push(`${totalPrompts} prompt${totalPrompts === 1 ? '' : 's'}`);
      lines.push('    ' + c.dim(bits.join(', ')));
    }
  }

  return lines.join('\n');
}

function renderFooter(
  { resetStats, modules, backupPath }:
  { resetStats: ResetStat[]; modules: BatchModule[]; backupPath: string | null }
): string {
  const lines: string[] = [];
  lines.push(c.ok('✓') + ' applied ' + c.bold(`${modules.length} module${modules.length === 1 ? '' : 's'}`) +
    (resetStats.length > 0 ? c.dim(` (after ${resetStats.length} reset${resetStats.length === 1 ? '' : 's'})`) : ''));

  for (const rs of resetStats) {
    if (rs.missing) {
      lines.push('  ' + c.dim(`• RESET ${rs.path}                     — nothing to wipe`));
    } else {
      const what = rs.beforeKeyCount > 1 ? `${rs.beforeKeyCount} keys` : 'value';
      lines.push('  ' + c.warn(`• RESET ${rs.path}`) + c.dim(`  — wiped ${what}`));
    }
  }
  for (const m of modules) {
    if (!m.stats) continue;
    let summary: string;
    if (m.stats.mode === 'replace') {
      summary = m.stats.replaced ? `replaced value at ${m.resolvedPath}` : 'no change';
    } else {
      summary = `added ${m.stats.added}, preserved ${m.stats.preserved}`;
      if (m.stats.preservedBatch > 0) {
        summary += c.dim(` (${m.stats.preservedBatch} dedup'd in batch)`);
      }
      if (m.stats.overwritten) summary += `, overwritten ${m.stats.overwritten}`;
    }
    lines.push('  • ' + c.bold(m.meta.name) + c.meta(' — ') + summary);
  }

  const resetsApplied = resetStats.filter(r => !r.missing).length;
  const leavesReplaced = modules.filter(m => m.stats && m.stats.mode === 'replace' && m.stats.replaced).length;
  const keysAdded = modules.reduce((n, m) => n + (m.stats?.added || 0), 0);
  const dedups = modules.reduce((n, m) => n + (m.stats?.preservedBatch || 0), 0);

  lines.push('');
  if (resetStats.length > 0) lines.push('  ' + c.dim('Resets applied:    ') + resetsApplied);
  lines.push('  ' + c.dim('Leaves replaced:   ') + leavesReplaced);
  lines.push('  ' + c.dim('Keys added:        ') + keysAdded);
  if (dedups > 0)        lines.push('  ' + c.dim('Duplicates skipped:') + ' ' + dedups);
  if (backupPath)        lines.push('  ' + c.dim('Backup:            ') + backupPath);

  return lines.join('\n');
}

// Atomic multi-module remove: parse all, single confirm, single backup, single write.
export async function runRemoveBatch({ confPaths, target, cacheDir, backupDir }: RunRemoveBatchOpts): Promise<void> {
  const modules: RemoveModule[] = [];
  for (const cp of confPaths) {
    let parsed;
    try { parsed = await parseConf(cp); }
    catch (e) {
      console.error(c.err('error: ') + (e instanceof Error ? e.message : String(e)));
      process.exit(2);
    }
    const { meta, body } = parsed;

    if (/\{\{prompt:[a-zA-Z_][a-zA-Z0-9_-]*\}\}/.test(meta.path)) {
      console.error(c.err('error: ') + `${meta.name} installs to a dynamic path (${meta.path}).`);
      console.error(c.err('       ') + 'remove cannot resolve it. use `opencode-presets reset <path>` instead.');
      process.exit(1);
    }

    const expandedBody = expandCacheInValue(body, cacheDir);
    if (/\{\{prompt:/.test(JSON.stringify(expandedBody)) && meta.mode !== 'replace') {
      console.error(c.err('error: ') + `${meta.name} uses @prompt placeholders in a non-replace module; cannot remove.`);
      process.exit(1);
    }

    modules.push({ meta, body, expandedBody });
  }

  const existing = await loadJsonOrNull(target);
  if (existing === null) {
    console.log(c.dim('opencode.json does not exist — nothing to remove.'));
    return;
  }

  console.log('');
  console.log(c.bold('Target') + c.meta(': ') + target);
  console.log('');
  for (const m of modules) {
    const cur = getAtPath(existing, m.meta.path);
    console.log(describe(m.meta, target, cur, m.expandedBody, 'remove'));
    console.log('');
  }

  const proceed = await confirm(`Remove ${modules.length} preset${modules.length === 1 ? '' : 's'}?`);
  if (!proceed) { console.log(c.dim('declined.')); return; }

  let working: JsonObject = structuredCloneSafe(existing);
  for (const m of modules) {
    const { next, stats } = removeAtPath(working, m.meta.path, m.expandedBody, m.meta.mode);
    working = next;
    m.stats = stats;
  }

  if (JSON.stringify(working) === JSON.stringify(existing)) {
    console.log('  ' + c.dim('· no change — opencode.json untouched, no backup written'));
    return;
  }

  await validateOrAbort(working, cacheDir, 'pre-write');

  let backupPath: string | null = null;
  try { backupPath = await backup(target, backupDir); }
  catch (e) {
    console.error(c.err('error: backup failed: ') + (e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }
  if (backupPath) console.log('  ' + c.ok('✓') + ' backed up → ' + c.meta(backupPath));

  await mkdir(dirname(target), { recursive: true });
  const tmp = target + '.tmp';
  await writeFile(tmp, JSON.stringify(working, null, 2) + '\n', 'utf8');
  await rename(tmp, target);

  await validateAfterWrite(target, cacheDir);

  console.log('');
  console.log(c.ok('✓') + ' removed ' + c.bold(`${modules.length} preset${modules.length === 1 ? '' : 's'}`));
  for (const m of modules) {
    if (!m.stats) continue;
    const summary = m.stats.mode === 'replace'
      ? `removed value at ${m.meta.path}`
      : `removed ${m.stats.removed}, kept ${m.stats.kept}`;
    console.log('  • ' + c.bold(m.meta.name) + c.meta(' — ') + summary);
  }
}

// Validate the would-be-new config against opencode's JSON schema.
// On invalid, print the errors and abort BEFORE backup/write.
// On schema-unavailable (offline + no cache), print a warning and proceed.
async function validateOrAbort(config: unknown, cacheDir: string, phase: 'pre-write' | 'post-write'): Promise<void> {
  const result = await validateAgainstSchema(config, cacheDir);
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
    console.error('');
    console.error(c.err('aborting; opencode.json not modified.'));
    process.exit(1);
  } else {
    // post-write: shouldn't happen if pre-write passed, but surface as a loud warning.
    console.error('');
    console.error(c.err('⚠  post-write validation FAILED — opencode.json on disk does not match the schema.'));
    console.error(c.err('   This is unexpected. Errors:'));
    for (const e of result.errors.slice(0, 12)) console.error('  ' + c.err(e));
  }
}

async function validateAfterWrite(target: string, cacheDir: string): Promise<void> {
  try {
    const raw = await readFile(target, 'utf8');
    const parsed = JSON.parse(raw);
    await validateOrAbort(parsed, cacheDir, 'post-write');
  } catch (e) {
    console.error(c.err('⚠  could not re-read written file for post-write check: ') +
      (e instanceof Error ? e.message : String(e)));
  }
}

function colorMode(mode: MergeMode): string {
  if (mode === 'merge') return c.info(`(${mode})`);
  return c.warn(`(${mode})`);
}

function expandCacheStr(s: string, cacheDir: string): string {
  return s.replaceAll('{{cache}}', cacheDir);
}

function expandCacheInValue(value: Json, cacheDir: string): Json {
  if (typeof value === 'string') return expandCacheStr(value, cacheDir);
  if (Array.isArray(value)) return value.map(v => expandCacheInValue(v, cacheDir));
  if (value && typeof value === 'object') {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value as JsonObject)) out[k] = expandCacheInValue(v, cacheDir);
    return out;
  }
  return value;
}

function expandPromptsStr(s: string, promptValues: Record<string, string>): string {
  return s.replace(/\{\{prompt:([a-zA-Z_][a-zA-Z0-9_-]*)\}\}/g, (_, name) => {
    if (!(name in promptValues)) {
      throw new Error(`references {{prompt:${name}}} but no @prompt directive declared`);
    }
    return promptValues[name];
  });
}

function expandPromptsInValue(value: Json, promptValues: Record<string, string>): Json {
  if (typeof value === 'string') return expandPromptsStr(value, promptValues);
  if (Array.isArray(value)) return value.map(v => expandPromptsInValue(v, promptValues));
  if (value && typeof value === 'object') {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value as JsonObject)) out[k] = expandPromptsInValue(v, promptValues);
    return out;
  }
  return value;
}

function isPlainObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

async function loadJsonOrNull(path: string): Promise<JsonObject | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as JsonObject;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
