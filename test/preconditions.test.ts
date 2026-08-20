import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { checkDir, findOnPath, formatSetup } from '../src/preconditions.js';

describe('checkDir', () => {
  test('accepts an existing absolute directory and returns it resolved', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'precond-'));
    const r = await checkDir(dir);
    assert.equal(r.ok, true);
    assert.equal(r.path, dir);
  });

  // The failure this whole check exists for: a path that is not there used to
  // be written anyway, and opencode ignores it without a word.
  test('refuses a path that does not exist, and says so', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'precond-'));
    const missing = join(dir, 'not-cloned-yet');
    const r = await checkDir(missing);
    assert.equal(r.ok, false);
    assert.match(r.reason!, /does not exist/);
    assert.ok(r.reason!.includes(missing), 'the message must name the path');
  });

  test('refuses a file where a directory was asked for', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'precond-'));
    const file = join(dir, 'skills');
    await writeFile(file, 'not a dir');
    const r = await checkDir(file);
    assert.equal(r.ok, false);
    assert.match(r.reason!, /is not a directory/);
  });

  // Relative answers are rejected rather than resolved against the cwd: the
  // config is global, and a path that only means something from one directory
  // is a dead entry with extra steps.
  test('refuses a relative path', async () => {
    const r = await checkDir('some/where');
    assert.equal(r.ok, false);
    assert.match(r.reason!, /must be an absolute path/);
  });

  // Prompt answers do not pass through a shell, so ~ arrives literally —
  // from the prompt and from --set alike.
  test('expands a leading ~', async () => {
    const r = await checkDir('~');
    assert.equal(r.ok, true);
    assert.equal(r.path, homedir());
  });

  test('reports the expanded path when a ~ path is missing', async () => {
    const r = await checkDir('~/definitely-not-a-real-dir-9f3a2b');
    assert.equal(r.ok, false);
    assert.ok(r.reason!.includes(homedir()), 'the message must show what ~ became');
  });

  test('collapses .. so the config never carries an unresolved path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'precond-'));
    await mkdir(join(dir, 'a'));
    const r = await checkDir(join(dir, 'a', '..', 'a'));
    assert.equal(r.ok, true);
    assert.equal(r.path, join(dir, 'a'));
  });
});

describe('findOnPath', () => {
  test('finds an executable on the given PATH', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'precond-bin-'));
    const bin = join(dir, 'fakedcg');
    await writeFile(bin, '#!/bin/sh\n');
    await chmod(bin, 0o755);

    assert.equal(await findOnPath('fakedcg', { PATH: dir }), bin);
  });

  test('does not find it when the dir is not on PATH', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'precond-bin-'));
    const bin = join(dir, 'fakedcg');
    await writeFile(bin, '#!/bin/sh\n');
    await chmod(bin, 0o755);

    assert.equal(await findOnPath('fakedcg', { PATH: '/nonexistent-dir-9f3a2b' }), null);
  });

  // Present but not runnable is the same as absent for our purposes: the
  // plugin would still fail to invoke it.
  test('does not accept a file that is not executable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'precond-bin-'));
    await writeFile(join(dir, 'fakedcg'), '#!/bin/sh\n');
    await chmod(join(dir, 'fakedcg'), 0o644);

    assert.equal(await findOnPath('fakedcg', { PATH: dir }), null);
  });

  test('survives an empty or unset PATH', async () => {
    assert.equal(await findOnPath('fakedcg', { PATH: '' }), null);
    assert.equal(await findOnPath('fakedcg', {}), null);
  });
});

describe('formatSetup', () => {
  test('indents a single-line hint', () => {
    assert.deepEqual(formatSetup('brew install x'), ['  brew install x']);
  });

  test('keeps a multi-step hint as separate lines', () => {
    assert.deepEqual(formatSetup('git clone https://x/y\ncd y && make'), [
      '  git clone https://x/y',
      '  cd y && make',
    ]);
  });

  // No hint must produce no lines at all, not a stray indented blank: the
  // caller prints these straight under its error.
  test('produces nothing without a hint', () => {
    assert.deepEqual(formatSetup(undefined), []);
    assert.deepEqual(formatSetup(''), []);
    assert.deepEqual(formatSetup('   \n  \n'), []);
  });
});
