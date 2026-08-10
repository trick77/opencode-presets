#!/usr/bin/env node
// Report @pins in shipped presets that have fallen behind upstream.
//
// Dependabot reads package.json; it cannot see a version recorded in a preset
// header comment. This closes that gap. Run after `npm run build` — it imports
// the compiled parser rather than reimplementing the .conf format.
//
//   node scripts/check-pins.mjs
//
// Exit 0 = every pin current. Exit 1 = drift, or a pin with no registered
// source. Exit 2 = a lookup failed (network, rate limit), which is not drift
// and should not be reported as if it were.

import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseConf } from '../dist/src/parse-conf.js';
import { pinSourceFor, compareVersions, latestSemverTag, PIN_SOURCES, UnknownPinError } from '../dist/src/pin-sources.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRESET_DIR = resolve(REPO_ROOT, 'presets');
const TIMEOUT_MS = 20_000;

async function getJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

// The token is only for the rate limit; both endpoints are public.
const ghHeaders = () =>
  process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};

async function latestFor(source) {
  switch (source.kind) {
    case 'npm': {
      const body = await getJson(`https://registry.npmjs.org/${source.pkg}/latest`);
      return body.version;
    }
    case 'github-release': {
      const body = await getJson(`https://api.github.com/repos/${source.repo}/releases/latest`, ghHeaders());
      return String(body.tag_name).replace(/^v/, '');
    }
    case 'github-tags': {
      const body = await getJson(
        `https://api.github.com/repos/${source.repo}/tags?per_page=100`, ghHeaders());
      const latest = latestSemverTag(body.map(t => t.name));
      if (!latest) throw new Error(`${source.repo}: no version-shaped tags on the first page`);
      return latest;
    }
  }
  throw new Error(`unhandled pin source kind: ${source.kind}`);
}

async function shippedPins() {
  const files = (await readdir(PRESET_DIR)).filter(n => n.endsWith('.conf')).sort();
  const pins = [];
  for (const file of files) {
    const { meta } = await parseConf(resolve(PRESET_DIR, file));
    for (const pin of meta.pins) pins.push({ ...pin, preset: meta.name, file });
  }
  return pins;
}

const pins = await shippedPins();
if (pins.length === 0) {
  console.log('no @pins in any shipped preset');
  process.exit(0);
}

// An entry here that nothing pins any more is dead weight that will quietly
// rot; flag it rather than letting the map drift away from the presets.
const pinned = new Set(pins.map(p => p.name));
const orphans = Object.keys(PIN_SOURCES).filter(name => !pinned.has(name));

const rows = [];
let failed = false;
let drifted = false;

for (const pin of pins) {
  let source;
  try {
    source = pinSourceFor(pin.name);
  } catch (e) {
    if (e instanceof UnknownPinError) {
      rows.push({ ...pin, latest: '?', state: 'NO SOURCE', detail: e.message });
      drifted = true;
      continue;
    }
    throw e;
  }

  try {
    const latest = await latestFor(source);
    const cmp = compareVersions(pin.version, latest);
    // A pin ahead of upstream is not good news — it means this source is not
    // authoritative for that artifact, so its "ok" verdicts are worthless too.
    // Both sources tried for lombok before this one failed exactly that way.
    const state = cmp < 0 ? 'BEHIND' : cmp > 0 ? 'AHEAD?' : 'ok';
    if (cmp !== 0) drifted = true;
    rows.push({ ...pin, latest, state });
  } catch (e) {
    failed = true;
    rows.push({ ...pin, latest: '—', state: 'LOOKUP FAILED', detail: e.message });
  }
}

const w = (s, n) => String(s).padEnd(n);
console.log(`${w('PIN', 34)}${w('PINNED', 12)}${w('LATEST', 12)}${w('STATE', 15)}PRESET`);
for (const r of rows) {
  console.log(`${w(r.name, 34)}${w(r.version, 12)}${w(r.latest, 12)}${w(r.state, 15)}${r.preset}`);
  if (r.detail) console.log(`  ${r.detail}`);
}

for (const name of orphans) {
  console.log(`\nnote: PIN_SOURCES has an entry for "${name}", which no preset pins any more`);
}

if (drifted) {
  console.log('\nBump the @pins line, the version where it is used in the body or @fetch,');
  console.log('and the README row together — a test enforces @pins and body agreeing.');
  console.log('For an @fetch, re-verify sha256 against a second source before committing.');
  process.exit(1);
}
if (failed) {
  console.log('\nOne or more lookups failed. That is not drift — re-run.');
  process.exit(2);
}
console.log('\nall pins current');
