#!/usr/bin/env node
// Open one PR per pin that check-pins reports BEHIND (newer upstream release
// past the cooldown, not MANUAL). Patch/minor PRs get auto-merge; a major is
// opened for a human. auto-release.yaml cuts a release once a pins/* PR merges.
//
//   node scripts/bump-pins.mjs [--dry-run]
//
// Needs a clean tree and, unless --dry-run, GH_TOKEN with contents +
// pull-requests write that is NOT the workflow GITHUB_TOKEN: a PR opened with
// that token never triggers ci.yaml, so the required checks never report and
// auto-merge waits forever. --dry-run applies each bump, runs npm test, prints
// the diff and restores the files; no branch, push or PR.
//
// Exit 1 = some bump could not be applied or failed its tests (a preset's
// shape changed — bump it by hand).

import { execFileSync } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { rewriteConf, rewriteReadmeRow, rewriteExpectedPins } from '../dist/src/pin-bump.js';
import { collectPins, REPO_ROOT, PRESET_DIR, day } from './pins-lib.mjs';

const DRY = process.argv.includes('--dry-run');
const BASE_BRANCH = 'master';
const README = resolve(REPO_ROOT, 'README.md');
const PINS_TEST = resolve(REPO_ROOT, 'test/builtin-presets.test.ts');

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8', ...opts });
const git = (...args) => run('git', args).trim();
const gh = (...args) => run('gh', args).trim();

if (!DRY && !process.env.GH_TOKEN) {
  console.error('GH_TOKEN missing. Set the PINS_TOKEN secret (fine-grained PAT, this repo, ' +
    'Contents + Pull requests read/write); the workflow token cannot trigger CI on its PRs.');
  process.exit(1);
}
if (git('status', '--porcelain')) {
  console.error('working tree not clean — bump-pins switches branches and restores files');
  process.exit(1);
}

const todo = (await collectPins()).filter(r => r.state === 'BEHIND');
if (todo.length === 0) {
  console.log('nothing to bump');
  process.exit(0);
}

const base = git('rev-parse', 'HEAD');
const summary = [];
let failed = false;

async function edit(file, fn) {
  await writeFile(file, fn(await readFile(file, 'utf8')));
}

for (const r of todo) {
  const change = { preset: r.preset, name: r.name, from: r.version, to: r.target };
  const branch = `pins/${r.preset}`;
  const title = `deps(${r.preset}): bump ${r.name} to ${r.target}`;
  const body = `${r.name} ${r.version} → ${r.target} (${r.bump}), released ${day(r.targetDate)}: ${r.targetUrl}` +
    (r.bump === 'major' ? '\n\nMajor: not auto-merged.' : '');
  const conf = resolve(PRESET_DIR, r.file);
  const touched = [conf, README, PINS_TEST];

  // A PR for this exact bump closed unmerged = a human said no. Don't reopen
  // it every Monday; a newer upstream release gets a new title and a new PR.
  if (!DRY) {
    const closed = JSON.parse(gh('pr', 'list', '--head', branch, '--state', 'closed', '--json', 'title,mergedAt'));
    if (closed.some(p => p.title === title && !p.mergedAt)) {
      summary.push(`skipped ${title}: closed unmerged before`);
      continue;
    }
  }

  try {
    if (!DRY) git('checkout', '-B', branch, base);
    await edit(conf, t => rewriteConf(t, change, r.bump));
    await edit(README, t => rewriteReadmeRow(t, [r.preset, r.partOf].filter(Boolean), r.version, r.target));
    await edit(PINS_TEST, t => rewriteExpectedPins(t, change));
    run('npm', ['test'], { stdio: 'inherit' });

    if (DRY) {
      console.log(`\n=== ${title}\n${body}\n`);
      console.log(git('diff'));
      summary.push(`dry-run: ${title}`);
      continue;
    }

    git('commit', '--quiet', '-am', title, '-m', body);

    // Same content already on the remote branch → leave the PR alone instead
    // of re-running its CI every week.
    const remote = git('ls-remote', 'origin', `refs/heads/${branch}`).split(/\s/)[0];
    let same = false;
    if (remote) {
      git('fetch', '--quiet', 'origin', branch);
      same = git('rev-parse', 'FETCH_HEAD^{tree}') === git('rev-parse', 'HEAD^{tree}');
    }
    if (!same) git('push', '--quiet', '--force', 'origin', `HEAD:refs/heads/${branch}`);

    const open = JSON.parse(gh('pr', 'list', '--head', branch, '--state', 'open', '--json', 'url'));
    let url = open[0]?.url;
    if (url) {
      gh('pr', 'edit', url, '--title', title, '--body', body);
    } else {
      url = gh('pr', 'create', '--base', BASE_BRANCH, '--head', branch, '--title', title, '--body', body);
    }
    if (r.bump !== 'major') gh('pr', 'merge', url, '--auto', '--squash');
    summary.push(`${title}: ${url}${r.bump === 'major' ? ' (major, review by hand)' : ' (auto-merge)'}`);
  } catch (e) {
    failed = true;
    summary.push(`FAILED ${title}: ${e.message.split('\n')[0]}`);
    console.error(`::error title=${r.preset}::${e.message.split('\n')[0]} — bump by hand`);
  } finally {
    if (DRY) {
      git('restore', '--source=HEAD', '--worktree', '--', ...touched);
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
