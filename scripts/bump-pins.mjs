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
// Each major gets its own `pins/<preset>` PR with auto-merge off.
//
// Hands off a PR a human has touched: auto-merge is only enabled on creation
// (disable it and it stays off), a branch carrying non-bot commits is never
// force-pushed, and a bump whose PR was closed unmerged is not reopened.
//
// Needs a clean tree and, unless --dry-run, GH_TOKEN with contents +
// pull-requests write that is NOT the workflow GITHUB_TOKEN: a PR opened with
// that token never triggers ci.yaml, so the required checks never report and
// auto-merge waits forever. --dry-run applies the bumps, runs npm test, prints
// the diff and restores the files; no branch, push or PR.
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

const base = git('rev-parse', 'HEAD');
const summary = [];
let failed = false;
const fail = (title, msg) => {
  failed = true;
  summary.push(`FAILED ${title}: ${msg}`);
  console.error(`::error title=${title}::${msg} — bump by hand`);
};

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

for (const unit of units) {
  const { branch } = unit;
  let items = unit.items;
  const titleOf = list => list.length === 1
    ? `deps(${list[0].preset}): bump ${list[0].name} to ${list[0].target}`
    : `deps(pins): bump ${list.map(r => `${r.name} to ${r.target}`).join(', ')}`;

  try {
    if (!DRY) git('checkout', '--quiet', '-B', branch, base);
    const applied = [];
    for (const r of items) {
      try {
        await applyPin(r);
        applied.push(r);
      } catch (e) {
        fail(titleOf([r]), firstLine(e));
      }
    }
    items = applied;
    if (items.length === 0) continue;

    const title = titleOf(items);
    const body = items.map(r =>
      `${r.name} ${r.version} → ${r.target} (${r.bump}), released ${day(r.targetDate)}: ${r.targetUrl}`).join('\n') +
      (unit.auto ? '' : '\n\nMajor: not auto-merged.');

    try {
      run('npm', ['test'], { stdio: 'inherit' });
    } catch {
      fail(title, 'npm test failed on the bumped presets');
      continue;
    }

    if (DRY) {
      console.log(`\n=== ${branch}: ${title}\n${body}\n`);
      console.log(git('diff'));
      summary.push(`dry-run ${branch}: ${title}`);
      continue;
    }

    // Same bump closed unmerged = a human said no. A newer release changes
    // the title and gets a new PR.
    const closed = JSON.parse(gh('pr', 'list', '--head', branch, '--state', 'closed', '--json', 'title,mergedAt'));
    if (closed.some(p => p.title === title && !p.mergedAt)) {
      summary.push(`skipped ${title}: closed unmerged before`);
      continue;
    }

    git('commit', '--quiet', '-am', title, '-m', body);

    const remote = git('ls-remote', 'origin', `refs/heads/${branch}`).split(/\s/)[0];
    let same = false;
    if (remote) {
      git('fetch', '--quiet', 'origin', branch);
      const authors = git('log', '--format=%ae', `${base}..FETCH_HEAD`).split('\n').filter(Boolean);
      if (authors.some(a => a !== BOT_EMAIL)) {
        summary.push(`skipped ${title}: ${branch} carries commits by a human, not overwriting`);
        console.log(`::warning title=${branch}::has non-bot commits; bump-pins leaves it alone`);
        continue;
      }
      // Same content → leave the PR alone instead of re-running its CI.
      same = git('rev-parse', 'FETCH_HEAD^{tree}') === git('rev-parse', 'HEAD^{tree}');
    }
    if (!same) git('push', '--quiet', '--force', 'origin', `HEAD:refs/heads/${branch}`);

    const open = JSON.parse(gh('pr', 'list', '--head', branch, '--state', 'open', '--json', 'url'));
    let url = open[0]?.url;
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
    fail(branch, firstLine(e));
  } finally {
    if (DRY) {
      git('restore', '--source=HEAD', '--worktree', '--', ...new Set([README, PINS_TEST, ...unit.items.map(r => resolve(PRESET_DIR, r.file))]));
    } else {
      git('checkout', '--quiet', '--force', '--detach', base);
    }
  }
}

console.log(`\n${summary.join('\n')}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Bumps\n\n${summary.map(s => `- ${s}`).join('\n')}\n`);
}
process.exitCode = failed ? 1 : 0;
