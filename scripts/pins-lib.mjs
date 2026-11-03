// Network half of the pin checks, shared by check-pins.mjs (report) and
// bump-pins.mjs (open PRs). Imports the compiled parser and pin logic — run
// after `npm run build`.

import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseConf } from '../dist/src/parse-conf.js';
import { pinSourceFor, manualReason, compareVersions, latestSemverTag, UnknownPinError } from '../dist/src/pin-sources.js';
import { bumpType, pickEligible } from '../dist/src/pin-bump.js';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PRESET_DIR = resolve(REPO_ROOT, 'presets');
const TIMEOUT_MS = 20_000;

async function getJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

// The token is only for the rate limit; every endpoint here is public.
const ghHeaders = () =>
  process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};

// { latest, dated: [{ version, date, url }] | null }. `dated` is null where the
// source has no release dates (tags, branches) — those never auto-bump.
async function lookup(source) {
  switch (source.kind) {
    case 'npm': {
      // Full packument: /latest has no publish dates. Unpublished versions
      // stay in `time` but leave `versions`; deprecated ones are skipped —
      // both are what a pulled hijack looks like.
      const body = await getJson(`https://registry.npmjs.org/${source.pkg}`);
      const latest = body['dist-tags']?.latest;
      if (!latest) throw new Error(`${source.pkg}: no dist-tags.latest`);
      const dated = Object.entries(body.versions ?? {})
        .filter(([v, meta]) => !meta.deprecated && body.time?.[v] && compareVersions(v, latest) <= 0)
        .map(([v]) => ({
          version: v,
          date: new Date(body.time[v]),
          url: `https://www.npmjs.com/package/${source.pkg}/v/${v}`,
        }));
      return { latest, dated };
    }
    case 'github-release': {
      const body = await getJson(
        `https://api.github.com/repos/${source.repo}/releases?per_page=30`, ghHeaders());
      const dated = body
        .filter(r => !r.draft && !r.prerelease && r.published_at)
        .map(r => ({ version: String(r.tag_name).replace(/^v/, ''), date: new Date(r.published_at), url: r.html_url }))
        .filter(r => /^\d+\.\d+\.\d+$/.test(r.version));
      const latest = latestSemverTag(dated.map(r => r.version));
      if (!latest) throw new Error(`${source.repo}: no version-shaped release on the first page`);
      return { latest, dated };
    }
    case 'github-tags': {
      const body = await getJson(
        `https://api.github.com/repos/${source.repo}/tags?per_page=100`, ghHeaders());
      const latest = latestSemverTag(body.map(t => t.name));
      if (!latest) throw new Error(`${source.repo}: no version-shaped tags on the first page`);
      return { latest, dated: null };
    }
    case 'github-branch': {
      // Newest commit on the branch that touches the installed path.
      const body = await getJson(
        `https://api.github.com/repos/${source.repo}/commits?sha=${source.branch}&path=${source.path}&per_page=1`,
        ghHeaders());
      if (!body.length) throw new Error(`${source.repo}: no commits touch ${source.path} on ${source.branch}`);
      return { latest: body[0].sha, dated: null };
    }
  }
  throw new Error(`unhandled pin source kind: ${source.kind}`);
}

// A pinned commit is current when it already contains the newest commit that
// touched the path: compare reports the pin identical to it or ahead of it.
async function branchCmp(source, pinned, latest) {
  const body = await getJson(
    `https://api.github.com/repos/${source.repo}/compare/${latest}...${pinned}`, ghHeaders());
  return body.status === 'identical' || body.status === 'ahead' ? 0 : -1;
}

async function shippedPins() {
  const files = (await readdir(PRESET_DIR)).filter(n => n.endsWith('.conf')).sort();
  const pins = [];
  for (const file of files) {
    const { meta } = await parseConf(resolve(PRESET_DIR, file));
    for (const pin of meta.pins) pins.push({ ...pin, preset: meta.name, partOf: meta.partOf, file });
  }
  return pins;
}

// One row per @pins. state:
//   ok            current
//   BEHIND        newer release past the cooldown → bump-pins opens a PR
//   COOLDOWN      newer release, still inside the cooldown
//   MANUAL        behind, never auto-bumped (row.manual says why)
//   AHEAD?        pin newer than the source → the source is wrong
//   NO SOURCE     no PIN_SOURCES entry
//   LOOKUP FAILED network / rate limit
export async function collectPins(now = new Date()) {
  const rows = [];
  for (const pin of await shippedPins()) {
    let source;
    try {
      source = pinSourceFor(pin.name);
    } catch (e) {
      if (e instanceof UnknownPinError) {
        rows.push({ ...pin, latest: '?', state: 'NO SOURCE', detail: e.message });
        continue;
      }
      throw e;
    }

    try {
      const { latest, dated } = await lookup(source);
      const cmp = source.kind === 'github-branch'
        ? await branchCmp(source, pin.version, latest)
        : compareVersions(pin.version, latest);
      // A pin ahead of upstream is not good news — it means this source is not
      // authoritative for that artifact, so its "ok" verdicts are worthless too.
      // Both sources first tried for lombok (since dropped) failed exactly that way.
      if (cmp > 0) { rows.push({ ...pin, latest, state: 'AHEAD?' }); continue; }
      if (cmp === 0) { rows.push({ ...pin, latest, state: 'ok' }); continue; }

      const manual = manualReason(source);
      if (manual || !dated) {
        rows.push({ ...pin, latest, state: 'MANUAL', manual: manual ?? 'no release dates' });
        continue;
      }
      const { eligible, waitingUntil } = pickEligible(dated, pin.version, now);
      if (!eligible) {
        rows.push({ ...pin, latest, state: 'COOLDOWN', waitingUntil });
        continue;
      }
      rows.push({
        ...pin, latest, state: 'BEHIND',
        target: eligible.version, targetDate: eligible.date, targetUrl: eligible.url,
        bump: bumpType(pin.version, eligible.version),
      });
    } catch (e) {
      rows.push({ ...pin, latest: '—', state: 'LOOKUP FAILED', detail: e.message });
    }
  }
  return rows;
}

// Commit SHAs shortened so tables keep their columns.
export const short = s => /^[0-9a-f]{40}$/.test(String(s)) ? String(s).slice(0, 10) : String(s);
export const day = d => d.toISOString().slice(0, 10);
