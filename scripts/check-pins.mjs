#!/usr/bin/env node
// Report every @pins in shipped presets against upstream.
//
// Dependabot reads package.json; it cannot see a version recorded in a preset
// header comment. This closes that gap. Run after `npm run build`.
//
//   node scripts/check-pins.mjs [--out rows.json]
//
// --out saves the rows for bump-pins.mjs --rows, so both act on one lookup.
//
// A pin that is merely behind is not a failure: bump-pins.mjs opens the PR, or
// the MANUAL row says why a human has to. Red means the check itself is wrong.
//
// Exit 0 = nothing broken. Exit 1 = AHEAD? or NO SOURCE (a PIN_SOURCES entry
// is wrong or missing). Exit 2 = a lookup failed (network, rate limit) — re-run.

import { appendFile, writeFile } from 'node:fs/promises';
import { PIN_SOURCES } from '../dist/src/pin-sources.js';
import { collectPins, short, day } from './pins-lib.mjs';

const rows = await collectPins();
const outIdx = process.argv.indexOf('--out');
if (outIdx !== -1) await writeFile(process.argv[outIdx + 1], JSON.stringify(rows));
if (rows.length === 0) {
  console.log('no @pins in any shipped preset');
  process.exit(0);
}

const note = r => {
  switch (r.state) {
    case 'BEHIND': return `${r.bump} to ${r.target} (${day(r.targetDate)}) → bump-pins opens a PR`;
    case 'COOLDOWN': return r.waitingUntil ? `newer release eligible ${day(r.waitingUntil)}` : '';
    case 'MANUAL': return `bump by hand: ${r.manual}`;
    default: return r.detail ?? '';
  }
};

const w = (s, n) => String(s).padEnd(n);
const lines = [`${w('PIN', 34)}${w('PINNED', 12)}${w('LATEST', 12)}${w('STATE', 15)}${w('PRESET', 24)}NOTE`];
for (const r of rows) {
  lines.push(`${w(r.name, 34)}${w(short(r.version), 12)}${w(short(r.latest), 12)}${w(r.state, 15)}${w(r.preset, 24)}${note(r)}`);
}

const pinned = new Set(rows.map(r => r.name));
for (const name of Object.keys(PIN_SOURCES).filter(n => !pinned.has(n))) {
  lines.push('', `note: PIN_SOURCES has an entry for "${name}", which no preset pins any more`);
}

const broken = rows.some(r => r.state === 'AHEAD?' || r.state === 'NO SOURCE');
const failed = rows.some(r => r.state === 'LOOKUP FAILED');
if (rows.some(r => r.state === 'NO SOURCE')) {
  lines.push('', 'A "NO SOURCE" pin needs a lookup registered in src/pin-sources.ts, not a version bump.');
}
if (rows.some(r => r.state === 'AHEAD?')) {
  lines.push('', 'AHEAD? = the PIN_SOURCES lookup for that pin is not authoritative; fix the source.');
}
if (rows.some(r => r.state === 'MANUAL')) {
  lines.push('', 'MANUAL: bump the @pins line, the version in the body or @fetch/@archive, the',
    'README row and the expected-pins test together. For a hash, re-verify against a second source.');
}
if (failed) lines.push('', 'One or more lookups failed. That is not drift — re-run.');

console.log(lines.join('\n'));

if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Pins\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`);
}
// Annotations make a MANUAL drift visible on a green run.
if (process.env.GITHUB_ACTIONS) {
  for (const r of rows.filter(r => r.state === 'MANUAL')) {
    console.log(`::warning title=${r.preset}::${r.name} ${short(r.version)} → ${short(r.latest)}: bump by hand (${r.manual})`);
  }
}

// process.exitCode rather than process.exit(): stdout is a pipe under CI, and
// exiting outright can drop buffered writes — the table above is the whole
// signal.
process.exitCode = broken ? 1 : failed ? 2 : 0;
