// The offline half of the weekly pin bump: which upstream version to take and
// the text edits that move a preset to it. scripts/bump-pins.mjs does the
// network, git and PR work around these.
//
// Every rewrite throws when its anchor is not where it expects. A preset whose
// shape changed must fail the bump loudly, not ship a half-edited preset.

import { compareVersions } from './pin-sources.js';
import { escapeRegExp } from './recover-prompts.js';

export type BumpType = 'major' | 'minor' | 'patch';

// Upstream release older than this may be bumped. Hijacked releases (the May
// 2026 TanStack worm) were pulled within days; this is the only review a
// patch/minor bump gets.
export const COOLDOWN_DAYS = 7;

const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;

// Positional, like Dependabot: the first segment that differs decides.
// 0.0.83 → 0.0.84 is a patch; no 0.x special case.
export function bumpType(from: string, to: string): BumpType | null {
  if (compareVersions(to, from) <= 0) return null;
  const [a, b] = [from, to].map(v => v.split('.').map(n => parseInt(n, 10) || 0));
  if (a[0] !== b[0]) return 'major';
  if (a[1] !== b[1]) return 'minor';
  return 'patch';
}

// Preset @version follows the upstream bump: patch → patch, anything bigger →
// minor. Presets are 0.x/1.x of their own; an upstream major is a preset
// behaviour change, not a preset rewrite.
export function nextPresetVersion(version: string, bump: BumpType): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`preset @version "${version}" is not x.y.z`);
  const [maj, min, pat] = m.slice(1).map(Number);
  return bump === 'patch' ? `${maj}.${min}.${pat + 1}` : `${maj}.${min + 1}.0`;
}

export interface DatedVersion {
  version: string;
  date: Date;
}

export interface Eligibility {
  // Newest release past the cooldown, newer than the pin. Null → nothing to bump yet.
  eligible: DatedVersion | null;
  // When the next newer release clears the cooldown, if one is still waiting.
  waitingUntil: Date | null;
}

export function pickEligible(
  candidates: DatedVersion[], pinned: string, now: Date, days = COOLDOWN_DAYS,
): Eligibility {
  const cutoff = now.getTime() - days * 86_400_000;
  const newer = candidates
    .filter(c => PLAIN_VERSION.test(c.version) && compareVersions(c.version, pinned) > 0)
    .sort((x, y) => compareVersions(x.version, y.version));
  const ripe = newer.filter(c => c.date.getTime() <= cutoff);
  const eligible = ripe.at(-1) ?? null;
  const pending = newer.filter(c => c.date.getTime() > cutoff &&
    (!eligible || compareVersions(c.version, eligible.version) > 0));
  const waitingUntil = pending.length
    ? new Date(Math.min(...pending.map(c => c.date.getTime())) + days * 86_400_000)
    : null;
  return { eligible, waitingUntil };
}

// A version as a whole token: not part of 10.0.83 or 0.0.831, optional v kept.
function versionToken(v: string): RegExp {
  return new RegExp(`(?<![\\w.])(v?)${escapeRegExp(v)}(?![\\w-]|\\.\\d)`, 'g');
}

function replaceToken(text: string, from: string, to: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(versionToken(from), (_m, v: string) => { count++; return `${v}${to}`; });
  return { text: out, count };
}

export interface PinChange {
  preset: string;
  name: string;
  from: string;
  to: string;
}

// Moves a .conf to the new version: @pins, @version, and every occurrence in
// the body. Header lines other than those two must not mention the old
// version (a description saying "pinned to X" needs a human sentence).
export function rewriteConf(text: string, change: PinChange, bump: BumpType): string {
  const lines = text.split('\n');
  const bodyStart = lines.findIndex(l => !l.startsWith('//'));
  if (bodyStart <= 0) throw new Error(`${change.preset}: no header/body split found`);
  const header = lines.slice(0, bodyStart);
  const body = lines.slice(bodyStart).join('\n');

  if (header.some(l => /^\/\/ @(fetch|archive):/.test(l))) {
    throw new Error(`${change.preset}: has @fetch/@archive — hashes need a second source, bump by hand`);
  }

  const pinLine = `// @pins: ${change.name} ${change.from}`;
  const pinIdx = header.flatMap((l, i) => (l === pinLine ? [i] : []));
  if (pinIdx.length !== 1) throw new Error(`${change.preset}: expected one "${pinLine}" line, found ${pinIdx.length}`);
  header[pinIdx[0]] = `// @pins: ${change.name} ${change.to}`;

  const verIdx = header.flatMap((l, i) => (/^\/\/ @version: /.test(l) ? [i] : []));
  if (verIdx.length !== 1) throw new Error(`${change.preset}: expected one @version line, found ${verIdx.length}`);
  const presetVersion = header[verIdx[0]].slice('// @version: '.length).trim();
  header[verIdx[0]] = `// @version: ${nextPresetVersion(presetVersion, bump)}`;

  header.forEach((l, i) => {
    if (i === pinIdx[0] || i === verIdx[0]) return;
    if (versionToken(change.from).test(l)) {
      throw new Error(`${change.preset}: header line ${i + 1} mentions ${change.from} — bump by hand: ${l}`);
    }
  });

  const moved = replaceToken(body, change.from, change.to);
  if (moved.count === 0) throw new Error(`${change.preset}: body never mentions ${change.from}`);
  return [...header, moved.text].join('\n');
}

// README table row of the preset, or of the first bundle it is part of when
// it has none of its own. Only that row changes: elsewhere the README quotes
// old versions as format examples.
export function rewriteReadmeRow(text: string, rowNames: string[], from: string, to: string): string {
  const lines = text.split('\n');
  for (const name of rowNames) {
    const idx = lines.findIndex(l => l.startsWith(`| \`${name}\` |`));
    if (idx === -1) continue;
    const moved = replaceToken(lines[idx], from, to);
    if (moved.count === 0) throw new Error(`README row of ${name} never mentions ${from}`);
    lines[idx] = moved.text;
    return lines.join('\n');
  }
  throw new Error(`no README table row for any of: ${rowNames.join(', ')}`);
}

// The expected-pins table in test/builtin-presets.test.ts.
export function rewriteExpectedPins(text: string, change: PinChange): string {
  const entry = `'${change.preset}': [{ name: '${change.name}', version: '${change.from}' }]`;
  const parts = text.split(entry);
  if (parts.length !== 2) throw new Error(`expected one "${entry}" in the pins test, found ${parts.length - 1}`);
  return parts.join(entry.replace(`version: '${change.from}'`, `version: '${change.to}'`));
}
