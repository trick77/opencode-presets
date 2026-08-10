import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { parseConf } from './parse-conf.js';
import type { ConfMeta, ConfTarget, FetchDirective } from './parse-conf.js';
import { applyAtPath, removeAtPath, getAtPath } from './merge.js';
import type { ApplyStats, RemoveStats, MergeMode } from './merge.js';
import { fetchAsset } from './fetch-asset.js';
import { backup } from './backup.js';
import { c, confirm, promptText, promptSecret, describe, wrap } from './ui.js';
import type { SetValue } from './cli-args.js';
import { validateAgainstSchema } from './validate.js';
import type { ValidationResult } from './validate.js';
import { printValidationIssue } from './validation-output.js';

const SCHEMA_URL = 'https://opencode.ai/config.json';
const TUI_SCHEMA_URL = 'https://opencode.ai/tui.json';
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

type Json = unknown;
type JsonObject = Record<string, unknown>;

export interface BatchModule {
  confPath: string;
  meta: ConfMeta;
  body: Json;
  promptValues?: Record<string, string>;
  resolvedPath?: string;
  stats?: ApplyStats & { preservedBatch: number; preservedExisting: number };
  // Deny rules this module wanted to install that an existing key of the same
  // name kept out. `merge` preserving a value is normally uninteresting; when
  // the loser is a deny, a guardrail silently did not install.
  shadowedDenies?: { key: string; current: string }[];
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
  setValues?: SetValue[];
  targets?: Record<ConfTarget, string>;
  schemas?: Record<ConfTarget, string>;
  target?: string;
  cacheDir: string;
  backupDir: string;
}

export interface RunRemoveBatchOpts {
  confPaths: string[];
  targets?: Record<ConfTarget, string>;
  schemas?: Record<ConfTarget, string>;
  target?: string;
  cacheDir: string;
  backupDir: string;
}

// Run a batch consisting of zero or more --reset paths followed by
// zero or more module installs. Either side may be empty.
export async function runBatch(opts: RunBatchOpts): Promise<void> {
  const { resets, confPaths, setValues, cacheDir, backupDir } = opts;
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

  // Distribute --set / --set-env values to modules. Errors here surface
  // before the user is asked to confirm anything.
  try {
    distributeSetValues(modules, setValues ?? []);
  } catch (e) {
    console.error(c.err('error: ') + (e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }

  const targetName = resolveBatchTarget(modules, resets);
  const targets = opts.targets ?? { config: opts.target!, tui: opts.target! };
  const schemas = opts.schemas ?? { config: SCHEMA_URL, tui: TUI_SCHEMA_URL };
  const target = targets[targetName];
  const schemaUrl = schemas[targetName];
  const existing = await loadJsonOrNull(target);
  const baselineValidation = existing === null ? null : await validateAgainstSchema(existing, cacheDir, schemaUrl);
  const baselineValidationWarned = warnExistingValidationErrors(baselineValidation);

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
    const preset = m.promptValues ?? {};
    const allPreset = m.meta.prompts.every(p => p.name in preset);
    if (!allPreset) {
      console.log('');
      console.log(c.bold(m.meta.name) + c.dim(' — inputs:'));
    }
    m.promptValues = { ...preset };
    for (const p of m.meta.prompts) {
      let val: string;
      if (p.name in preset) {
        val = preset[p.name];
      } else {
        const label = '  ' + c.bold(p.name) +
          (p.help ? c.meta(' (' + p.help + ')') : '') +
          (p.default !== undefined ? c.meta(' [default: ' + p.default + ']') : '') +
          ': ';
        const raw = p.type === 'secret' ? await promptSecret(label) : await promptText(label);
        val = raw;
      }
      if (!val) {
        if (p.default !== undefined) {
          val = p.default;
        } else {
          console.error(c.err(`error: prompt "${p.name}" cannot be empty`));
          process.exit(1);
        }
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
  const startRoot: JsonObject = (existing ?? { '$schema': schemaUrl }) as JsonObject;
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

    if (m.meta.mode === 'merge') {
      const shadowed = findShadowedDenies(fullBody, beforeThisModule);
      if (shadowed.length > 0) m.shadowedDenies = shadowed;
    }

    m.stats = { ...stats, preservedBatch, preservedExisting: stats.preserved - preservedBatch };
  }

  const isNoOp = existing !== null && JSON.stringify(working) === JSON.stringify(existing);
  if (isNoOp) {
    console.log('');
    console.log('  ' + c.dim('· no change — target file untouched, no backup written'));
    return;
  }

  // ── Pre-write validation: abort if the resulting JSON would be invalid.
  await validateOrAbort(working, cacheDir, schemaUrl, 'pre-write', baselineValidation, !baselineValidationWarned);

  let backupPath: string | null = null;
  try {
    backupPath = await backup(target, backupDir);
  } catch (e) {
    console.error(c.err('error: backup failed: ') + (e instanceof Error ? e.message : String(e)));
    console.error(c.err('aborting; target file not modified.'));
    process.exit(1);
  }
  if (backupPath) console.log('  ' + c.ok('✓') + ' backed up → ' + c.meta(backupPath));

  await mkdir(dirname(target), { recursive: true });
  const tmp = target + '.tmp';
  await writeFile(tmp, JSON.stringify(working, null, 2) + '\n', 'utf8');
  await rename(tmp, target);

  // ── Post-write sanity check: re-read what we just wrote and re-validate.
  await validateAfterWrite(target, cacheDir, schemaUrl, baselineValidation);

  console.log('');
  console.log(renderFooter({ resetStats, modules, backupPath, target }));
}

// Deny rules in `body` that an existing key of the same name in `before` keeps
// out. `merge` preserving an existing value is normally uninteresting — but
// when the loser is a deny, a guardrail the user thinks they just installed is
// silently absent, so it has to be named.
export function findShadowedDenies(body: Json, before: Json): { key: string; current: string }[] {
  if (!isPlainObject(body) || !isPlainObject(before)) return [];

  const shadowed: { key: string; current: string }[] = [];
  for (const [key, incoming] of Object.entries(body)) {
    if (incoming !== 'deny') continue;
    if (!(key in before)) continue;
    const current = (before as JsonObject)[key];
    if (current === 'deny') continue;
    shadowed.push({ key, current: typeof current === 'string' ? current : JSON.stringify(current) });
  }
  return shadowed;
}

// opencode evaluates a per-agent ruleset after the global one, so an
// agent.<name>.permission block wins over anything a permission module writes.
// Installing global rules over a config that has one looks like it worked and
// changes nothing for that agent — worth saying before the user confirms.
export function agentOverrideWarnings(
  modules: { meta: ConfMeta }[],
  existing: JsonObject | null,
): string[] {
  if (!modules.some(m => m.meta.path === 'permission' || m.meta.path.startsWith('permission.'))) return [];

  const agents = existing ? getAtPath(existing, 'agent') : undefined;
  if (!isPlainObject(agents)) return [];

  const overriding = Object.entries(agents)
    .filter(([, cfg]) => isPlainObject(cfg) && 'permission' in (cfg as JsonObject))
    .map(([name]) => name);
  if (overriding.length === 0) return [];

  return [
    '    ' + c.warn('⚠  ') + `these agents set their own permission rules: ${overriding.join(', ')}`,
    '    ' + c.dim('   agent rules are evaluated last, so they win over what is installed here'),
    '    ' + c.dim('   fix: delete ') +
      overriding.map(a => `agent.${a}.permission`).join(', ') +
      c.dim(' to fall back to these rules,'),
    '    ' + c.dim('        or repeat the same rules inside each agent block'),
  ];
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
    for (const line of agentOverrideWarnings(modules, existing)) lines.push(line);

    const totalFetches = modules.reduce((n, m) => n + m.meta.fetch.length, 0);
    const totalPrompts = modules.reduce((n, m) => n + m.meta.prompts.length, 0);
    const totalPins = modules.reduce((n, m) => n + m.meta.pins.length, 0);
    if (totalFetches > 0 || totalPrompts > 0 || totalPins > 0) {
      const bits: string[] = [];
      if (totalFetches > 0) bits.push(`${totalFetches} fetch${totalFetches === 1 ? '' : 'es'}`);
      if (totalPrompts > 0) bits.push(`${totalPrompts} prompt${totalPrompts === 1 ? '' : 's'}`);
      if (totalPins > 0) bits.push(`${totalPins} pin${totalPins === 1 ? '' : 's'}`);
      lines.push('    ' + c.dim(bits.join(', ')));
    }
  }

  return lines.join('\n');
}

function renderFooter(
  { resetStats, modules, backupPath, target }:
  { resetStats: ResetStat[]; modules: BatchModule[]; backupPath: string | null; target: string }
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

    // A preserved allow is noise; a preserved deny means a guardrail is missing
    // from the config the user believes they just hardened.
    for (const s of m.shadowedDenies ?? []) {
      lines.push('    ' + c.warn('⚠ ') +
        `${JSON.stringify(s.key)} is already "${s.current}" in your config — the deny was NOT applied`);
    }
  }
  const shadowedPaths = [...new Set(
    modules.filter(m => m.shadowedDenies?.length).map(m => m.resolvedPath ?? m.meta.path),
  )];
  if (shadowedPaths.length > 0) {
    const names = modules.filter(m => m.shadowedDenies?.length).map(m => m.meta.name).join(' ');
    lines.push('');
    lines.push('  ' + c.warn('To apply those denies, pick one:'));
    lines.push('    ' + c.dim('1.') + ` delete the listed keys from ${shadowedPaths.join(', ')} in ${target},`);
    lines.push('       ' + c.dim(`then re-run: opencode-presets install ${names}`));
    lines.push('    ' + c.dim('2.') + ' wipe the whole path and reinstall from scratch:');
    for (const p of shadowedPaths) {
      lines.push('       ' + c.bold(`opencode-presets install --reset ${p} ${names}`));
    }
    lines.push('       ' + c.dim('this also deletes any other hand-written rules at that path'));
    lines.push('    ' + c.dim('3.') + ' keep your rule deliberately — nothing to do, but the guardrail is off');
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
export async function runRemoveBatch(opts: RunRemoveBatchOpts): Promise<void> {
  const { confPaths, cacheDir, backupDir } = opts;
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

  const targetName = resolveBatchTarget(modules, []);
  const targets = opts.targets ?? { config: opts.target!, tui: opts.target! };
  const schemas = opts.schemas ?? { config: SCHEMA_URL, tui: TUI_SCHEMA_URL };
  const target = targets[targetName];
  const schemaUrl = schemas[targetName];
  const existing = await loadJsonOrNull(target);
  if (existing === null) {
    console.log(c.dim('target file does not exist — nothing to remove.'));
    return;
  }
  const baselineValidation = await validateAgainstSchema(existing, cacheDir, schemaUrl);
  const baselineValidationWarned = warnExistingValidationErrors(baselineValidation);

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
    console.log('  ' + c.dim('· no change — target file untouched, no backup written'));
    return;
  }

  await validateOrAbort(working, cacheDir, schemaUrl, 'pre-write', baselineValidation, !baselineValidationWarned);

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

  await validateAfterWrite(target, cacheDir, schemaUrl, baselineValidation);

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
function resolveBatchTarget(modules: Array<{ meta: ConfMeta }>, resets: string[]): ConfTarget {
  const targets = new Set(modules.map(m => m.meta.target));
  if (targets.size > 1) {
    console.error(c.err('error: ') + 'cannot combine presets with different @target values in one operation.');
    console.error(c.err('       ') + 'run separate commands for config and tui presets.');
    process.exit(1);
  }
  if (targets.size === 1) return [...targets][0];
  if (resets.length > 0) return 'config';
  return 'config';
}

async function validateOrAbort(
  config: unknown,
  cacheDir: string,
  schemaUrl: string,
  phase: 'pre-write' | 'post-write',
  baseline?: ValidationResult | null,
  warnUnchanged = true,
): Promise<void> {
  const result = await validateAgainstSchema(config, cacheDir, schemaUrl);
  if (result.skipped) {
    console.error(c.warn('⚠  ') + result.errors.join('; '));
    return;
  }
  if (result.ok) return;

  if (
    baseline &&
    !baseline.skipped &&
    !baseline.ok &&
    sameValidationErrors(baseline.errors, result.errors)
  ) {
    if (phase === 'pre-write' && warnUnchanged) warnUnchangedValidationErrors(result);
    return;
  }

  if (phase === 'pre-write') {
    console.error('');
    console.error(c.err('✗ ') + c.bold('schema validation failed — would have produced an invalid target file'));
    for (const e of result.errors.slice(0, 12)) printValidationIssue(e, c.err);
    if (result.errors.length > 12) console.error(c.dim(`  … (+${result.errors.length - 12} more)`));
    console.error('');
    console.error(c.err('aborting; target file not modified.'));
    process.exit(1);
  } else {
    // post-write: shouldn't happen if pre-write passed, but surface as a loud warning.
    console.error('');
    console.error(c.err('⚠  post-write validation FAILED — target file on disk does not match the schema.'));
    console.error(c.err('   This is unexpected. Errors:'));
    for (const e of result.errors.slice(0, 12)) printValidationIssue(e, c.err);
  }
}

function warnExistingValidationErrors(result: ValidationResult | null): boolean {
  if (!result || result.skipped || result.ok) return false;
  console.error(c.warn('⚠  ') + c.bold('target file is already invalid against the opencode schema'));
  for (const e of result.errors.slice(0, 6)) printValidationIssue(e, c.warn);
  if (result.errors.length > 6) console.error(c.dim(`  … (+${result.errors.length - 6} more)`));
  console.error(c.dim('   opencode-presets will proceed only if this operation does not add new schema errors.'));
  return true;
}

function warnUnchangedValidationErrors(result: ValidationResult): void {
  console.error(c.warn('⚠  ') + 'target already has schema validation errors; proceeding because this operation does not add new schema errors');
  for (const e of result.errors.slice(0, 6)) printValidationIssue(e, c.warn);
  if (result.errors.length > 6) console.error(c.dim(`  … (+${result.errors.length - 6} more)`));
}

async function validateAfterWrite(
  target: string,
  cacheDir: string,
  schemaUrl: string,
  baseline?: ValidationResult | null,
): Promise<void> {
  try {
    const raw = await readFile(target, 'utf8');
    const parsed = JSON.parse(raw);
    await validateOrAbort(parsed, cacheDir, schemaUrl, 'post-write', baseline);
  } catch (e) {
    console.error(c.err('⚠  could not re-read written file for post-write check: ') +
      (e instanceof Error ? e.message : String(e)));
  }
}

function sameValidationErrors(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const remaining = new Map<string, number>();
  for (const err of a) remaining.set(err, (remaining.get(err) ?? 0) + 1);
  for (const err of b) {
    const count = remaining.get(err) ?? 0;
    if (count === 0) return false;
    if (count === 1) remaining.delete(err);
    else remaining.set(err, count - 1);
  }
  return remaining.size === 0;
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
    for (const [k, v] of Object.entries(value as JsonObject)) {
      out[expandCacheStr(k, cacheDir)] = expandCacheInValue(v, cacheDir);
    }
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
    for (const [k, v] of Object.entries(value as JsonObject)) {
      out[expandPromptsStr(k, promptValues)] = expandPromptsInValue(v, promptValues);
    }
    return out;
  }
  return value;
}

// Route --set / --set-env values to their target modules. Scoped values
// (preset.name) must match a module's @name. Unscoped values are
// accepted only when exactly one loaded module declares that prompt;
// ambiguity is a hard error rather than guessing. Unknown names and
// duplicate assignments are also rejected.
export function distributeSetValues(modules: BatchModule[], setValues: SetValue[]): void {
  if (setValues.length === 0) return;
  for (const sv of setValues) {
    const matches = modules.filter(m => {
      if (sv.scope !== undefined && m.meta.name !== sv.scope) return false;
      return m.meta.prompts.some(p => p.name === sv.name);
    });
    if (matches.length === 0) {
      if (sv.scope !== undefined) {
        throw new Error(`--set ${sv.scope}.${sv.name}: no module named "${sv.scope}" declares a prompt "${sv.name}"`);
      }
      throw new Error(`--set ${sv.name}: no installed module declares a prompt with that name`);
    }
    if (matches.length > 1) {
      const names = matches.map(m => m.meta.name).join(', ');
      throw new Error(
        `--set ${sv.name}: ambiguous — declared by multiple modules (${names}). Scope it as --set <preset>.${sv.name}=...`
      );
    }
    const m = matches[0];
    m.promptValues ??= {};
    if (sv.name in m.promptValues) {
      throw new Error(`--set ${sv.name}: value provided more than once for module "${m.meta.name}"`);
    }
    m.promptValues[sv.name] = sv.value;
  }
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
