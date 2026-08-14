#!/usr/bin/env node
// Report shipped @fetch lines whose sha256 no longer matches the file they
// point at in this repo.
//
// Some presets fetch a first-party file — rules/de-swiss.md is the first —
// from raw.githubusercontent.com, pinned to a commit and a sha256. Editing
// that file in the working tree does not touch the preset, so the preset goes
// on serving the old bytes from the old commit. Nothing in `npm test` notices:
// the suite only checks that an @fetch dest is referenced by the body, never
// that the hash still describes the file. That gap is what this closes.
//
//   node scripts/check-fetch-hashes.mjs
//
// Deliberately NOT part of `npm test`. Updating a first-party fetch takes two
// PRs — the content has to be merged before its commit SHA exists to pin — so
// between them a mismatch is the expected state, not a broken build. Same
// shape as check-pins.mjs: a drift report you act on, not a gate.
//
// Exit 0 = every first-party fetch matches. Exit 1 = drift, or a URL pointing
// at a path this repo does not have.

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseConf } from '../dist/src/parse-conf.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRESET_DIR = resolve(REPO_ROOT, 'presets');

// Only this repo's own raw URLs. A third-party fetch (lombok.jar) has no local
// file to compare against and is none of this script's business.
const FIRST_PARTY =
  /^https:\/\/raw\.githubusercontent\.com\/trick77\/opencode-presets\/[^/]+\/(.+)$/;

const sha256 = buf => createHash('sha256').update(buf).digest('hex');

const files = (await readdir(PRESET_DIR)).filter(n => n.endsWith('.conf')).sort();

const rows = [];
let drifted = false;

for (const file of files) {
  const path = resolve(PRESET_DIR, file);
  const { meta } = await parseConf(path);
  for (const fetch of meta.fetch) {
    const match = FIRST_PARTY.exec(fetch.url);
    if (!match) continue;
    const repoPath = match[1];
    const preset = file.replace(/\.conf$/, '');

    let actual;
    try {
      actual = sha256(await readFile(resolve(REPO_ROOT, repoPath)));
    } catch {
      drifted = true;
      rows.push({ preset, repoPath, state: 'NO SUCH FILE', actual: '—' });
      continue;
    }

    const ok = actual === fetch.sha256;
    if (!ok) drifted = true;
    rows.push({ preset, repoPath, state: ok ? 'ok' : 'STALE', actual });
  }
}

if (rows.length === 0) {
  console.log('no first-party @fetch lines to check');
  process.exit(0);
}

const w = (s, n) => String(s).padEnd(n);
console.log(`${w('PRESET', 30)}${w('FILE', 26)}STATE`);
for (const r of rows) {
  console.log(`${w(r.preset, 30)}${w(r.repoPath, 26)}${r.state}`);
  if (r.state === 'STALE') console.log(`  working tree is ${r.actual}`);
}

// process.exitCode, not process.exit(): stdout is a pipe under CI and exiting
// outright can drop buffered writes — the table is the whole signal.
if (drifted) {
  console.log('\nA STALE row means the preset still fetches the old bytes from the old');
  console.log('commit. Merge the file change first, then a second PR bumps @version, the');
  console.log('@fetch dest filename, the commit in the URL and the sha256 together.');
  console.log('The dest filename must change too — an existing dest is not re-fetched.');
  process.exitCode = 1;
} else {
  console.log('\nall first-party fetches match');
}
