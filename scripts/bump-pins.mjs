#!/usr/bin/env node
// Open PRs for pins that check-pins reports BEHIND (newer upstream release
// past the cooldown, not MANUAL). auto-release.yaml cuts a release once a
// pins/* PR merges.
//
//   node scripts/bump-pins.mjs [--rows rows.json] [--dry-run]
//
// All patch/minor bumps share one PR on `pins/auto`, auto-merge enabled when
// it is opened: they edit neighbouring lines of the README table and the
// expected-pins test, so separate PRs would conflict once the first merged.
// A pin that fails the tests drops out of the group alone. Each major gets
// its own `pins/<preset>` PR with auto-merge off.
//
// Hands off what a human touched: auto-merge is only enabled on creation
// (disable it and it stays off), an open PR's branch carrying non-bot commits
// is never force-pushed, and a bump in a PR closed unmerged is not proposed
// again (a newer upstream release is).
//
// Branches are cut from origin/master whatever was checked out, so a dispatch
// from a feature branch can't smuggle its commits into a bot PR.
//
// Needs a clean tree and, unless --dry-run, GH_TOKEN with contents +
// pull-requests write that is NOT the workflow GITHUB_TOKEN: a PR opened with
// that token never triggers ci.yaml, so the required checks never report and
// auto-merge waits forever. The token is used for the push itself, never
// stored in .git/config where build and test code could read it.
// --dry-run applies the bumps to the working tree, runs npm test, prints the
// diff and restores the files; no fetch, branch, push or PR.
//
// Exit 1 = a bump could not be applied or failed its tests (a preset's shape
// changed — bump it by hand), or GH_TOKEN is missing.

import { execFileSync } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { rewriteConf, rewriteReadmeRow, rewriteExpectedPins } from '../dist/src/pin-bump.js';
import { collectPins, REPO_ROOT, PRESET_DIR, day } from './pins-lib.mjs';

const DRY = process.argv.includes('--dry-run');
const rowsIdx = process.argv.indexOf('--rows');
const BASE_BRANCH = 'master';
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';
const README = resolve(REPO_ROOT, 'README.md');
const PINS_TEST = resolve(REPO_ROOT, 'test/builtin-presets.test.ts');

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8', ...opts });
const git = (...args) => run('git', args).trim();
const gh = (...args) => run('gh', args).trim();
const firstLine = e => String(e?.message ?? e).split('\n')[0];
const testsPass = () => {
  try { run('npm', ['test'], { stdio: 'inherit' }); return true; } catch { return false; }
};

if (!DRY && !process.env.GH_TOKEN) {
  console.error('::error::GH_TOKEN missing. Set the PINS_TOKEN secret (fine-grained PAT, this repo, ' +
    'Contents + Pull requests read/write); the workflow token cannot trigger CI on its PRs.');
  process.exit(1);
}
if (git('status', '--porcelain')) {
  console.error('working tree not clean — bump-pins switches branches and restores files');
  process.exit(1);
}

const rows = rowsIdx !== -1
  ? JSON.parse(await readFile(process.argv[rowsIdx + 1], 'utf8'))
    .map(r => ({ ...r, targetDate: r.targetDate && new Date(r.targetDate) }))
  : await collectPins();
const todo = rows.filter(r => r.state === 'BEHIND');
if (todo.length === 0) {
  console.log('nothing to bump');
  process.exit(0);
}

const units = [];
const minor = todo.filter(r => r.bump !== 'major');
if (minor.length) units.push({ branch: 'pins/auto', items: minor, auto: true });
for (const r of todo.filter(r => r.bump === 'major')) {
  units.push({ branch: `pins/${r.preset}`, items: [r], auto: false });
}

let base = null;
let pushUrl = null;
if (!DRY) {
  git('fetch', '--quiet', 'origin', BASE_BRANCH);
  base = git('rev-parse', 'FETCH_HEAD');
  const repo = process.env.GITHUB_REPOSITORY || gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner');
  pushUrl = `https://x-access-token:${process.env.GH_TOKEN}@github.com/${repo}.git`;
}

const summary = [];
let failed = false;
const fail = (title, msg) => {
  failed = true;
  summary.push(`FAILED ${title}: ${msg}`);
  console.error(`::error title=${title}::${msg} — bump by hand`);
};

// One body line per pin; also how a closed PR's rejection is recognised.
const lineOf = r => `${r.name} ${r.version} → ${r.target} (${r.bump})`;
const titleOf = list => list.length === 1
  ? `deps(${list[0].preset}): bump ${list[0].name} to ${list[0].target}`
  : `deps(pins): bump ${list.map(r => `${r.name} to ${r.target}`).join(', ')}`;

// All three edits of one pin, or none: a half-bumped preset must not reach
// the commit when its README row or test entry no longer matches.
async function applyPin(r) {
  const change = { preset: r.preset, name: r.name, from: r.version, to: r.target };
  const conf = resolve(PRESET_DIR, r.file);
  const [c, rd, t] = await Promise.all([conf, README, PINS_TEST].map(f => readFile(f, 'utf8')));
  const next = [
    [conf, rewriteConf(c, change, r.bump)],
    [README, rewriteReadmeRow(rd, [r.preset, r.partOf].filter(Boolean), r.version, r.target)],
    [PINS_TEST, rewriteExpectedPins(t, change)],
  ];
  for (const [f, text] of next) await writeFile(f, text);
}

// Applies what applies; returns the pins that did.
async function applyAll(items) {
  const applied = [];
  for (const r of items) {
    try {
      await applyPin(r);
      applied.push(r);
    } catch (e) {
      fail(titleOf([r]), firstLine(e));
    }
  }
  return applied;
}

for (const unit of units) {
  const { branch } = unit;
  const touched = [...new Set([README, PINS_TEST, ...unit.items.map(r => resolve(PRESET_DIR, r.file))])];
  const restore = () => git('restore', '--source=HEAD', '--worktree', '--', ...touched);

  try {
    let items = unit.items;
    if (!DRY) {
      const closed = JSON.parse(gh('pr', 'list', '--head', branch, '--state', 'closed',
        '--limit', '50', '--json', 'body,mergedAt'));
      const rejected = closed.filter(p => !p.mergedAt).map(p => p.body ?? '');
      items = items.filter(r => {
        const no = rejected.some(b => b.includes(lineOf(r)));
        if (no) summary.push(`skipped ${lineOf(r)}: in a PR closed unmerged`);
        return !no;
      });
      if (items.length === 0) continue;
      git('checkout', '--quiet', '--force', '-B', branch, base);
    }

    items = await applyAll(items);
    if (items.length === 0) continue;

    if (!testsPass()) {
      // Find the culprit(s) one by one instead of holding back every bump.
      const good = [];
      if (items.length > 1) {
        for (const r of items) {
          restore();
          await applyPin(r);
          if (testsPass()) good.push(r);
          else fail(titleOf([r]), 'npm test fails with this bump');
        }
        restore();
        for (const r of good) await applyPin(r);
        if (good.length && !testsPass()) {
          fail(titleOf(good), 'npm test fails with these bumps together');
          continue;
        }
      } else {
        fail(titleOf(items), 'npm test fails with this bump');
      }
      items = good;
      if (items.length === 0) continue;
    }

    const title = titleOf(items);
    const body = items.map(r => `${lineOf(r)}, released ${day(r.targetDate)}: ${r.targetUrl}`).join('\n') +
      (unit.auto ? '' : '\n\nMajor: not auto-merged.');

    if (DRY) {
      console.log(`\n=== ${branch}: ${title}\n${body}\n`);
      console.log(git('diff'));
      summary.push(`dry-run ${branch}: ${title}`);
      continue;
    }

    git('commit', '--quiet', '-am', title, '-m', body);

    const open = JSON.parse(gh('pr', 'list', '--head', branch, '--state', 'open', '--json', 'url'));
    let url = open[0]?.url;
    const remote = git('ls-remote', 'origin', `refs/heads/${branch}`).split(/\s/)[0];
    let same = false;
    if (url && remote) {
      git('fetch', '--quiet', 'origin', branch);
      // Only while a PR is open: a stale branch from a merged PR must not
      // block every later bump.
      const authors = git('log', '--format=%ae', `${base}..FETCH_HEAD`).split('\n').filter(Boolean);
      if (authors.some(a => a !== BOT_EMAIL)) {
        summary.push(`skipped ${title}: ${url} carries commits by a human, not overwriting`);
        console.log(`::warning title=${branch}::open PR has non-bot commits; bump-pins leaves it alone`);
        continue;
      }
      // Same content → leave the PR alone instead of re-running its CI.
      same = git('rev-parse', 'FETCH_HEAD^{tree}') === git('rev-parse', 'HEAD^{tree}');
    }
    if (!same) git('push', '--quiet', '--force', pushUrl, `HEAD:refs/heads/${branch}`);

    if (url) {
      gh('pr', 'edit', url, '--title', title, '--body', body);
      // A major branch never merges on its own, whatever happened to it before.
      if (!unit.auto && JSON.parse(gh('pr', 'view', url, '--json', 'autoMergeRequest')).autoMergeRequest) {
        gh('pr', 'merge', url, '--disable-auto');
      }
    } else {
      url = gh('pr', 'create', '--base', BASE_BRANCH, '--head', branch, '--title', title, '--body', body);
      if (unit.auto) gh('pr', 'merge', url, '--auto', '--squash');
    }
    summary.push(`${title}: ${url}${unit.auto ? '' : ' (major, review by hand)'}`);
  } catch (e) {
    fail(branch, firstLine(e).replaceAll(process.env.GH_TOKEN || '\0', '***'));
  } finally {
    if (DRY) restore();
    else git('checkout', '--quiet', '--force', '--detach', base);
  }
}

console.log(`\n${summary.join('\n')}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Bumps\n\n${summary.map(s => `- ${s}`).join('\n')}\n`);
}
process.exitCode = failed ? 1 : 0;
