import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';
import { expandIncludes, IncludeCycleError } from '../src/expand-includes.js';

const HEADER = (name: string) =>
  `// @name: ${name}\n// @description: d\n// @author: a\n// @version: 0.1.0\n`;

function leaf(name: string): string {
  return HEADER(name) + `// @path: permission.bash\n// @mode: merge\n{ "${name} *": "allow" }\n`;
}

function bundle(name: string, includes: string[]): string {
  return HEADER(name) + includes.map(i => `// @include: ${i}\n`).join('');
}

async function withDir(files: Record<string, string>, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(resolve(tmpdir(), 'expand-includes-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(resolve(dir, name + '.conf'), content);
    }
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Mirrors the CLI resolver: bare names come from the file's own directory.
const resolver = async (ref: string, fromFile: string) =>
  ref.includes('/') || ref.endsWith('.conf')
    ? resolve(dirname(fromFile), ref)
    : resolve(dirname(fromFile), ref + '.conf');

const names = (paths: string[]) => paths.map(p => basename(p, '.conf'));

describe('expandIncludes', () => {
  test('a plain module expands to itself', async () => {
    await withDir({ a: leaf('a') }, async (dir) => {
      const out = await expandIncludes([resolve(dir, 'a.conf')], resolver);
      assert.deepEqual(names(out), ['a']);
    });
  });

  test('a bundle expands to its leaves and contributes nothing itself', async () => {
    await withDir({
      a: leaf('a'), b: leaf('b'), c: leaf('c'),
      pack: bundle('pack', ['a', 'b', 'c']),
    }, async (dir) => {
      const out = await expandIncludes([resolve(dir, 'pack.conf')], resolver);
      assert.deepEqual(names(out), ['a', 'b', 'c']);
      assert.ok(!names(out).includes('pack'));
    });
  });

  // Order carries meaning: opencode is last-match-wins and `merge` appends, so
  // a bundle listing denies last is what keeps them from being shadowed.
  test('preserves declaration order across nesting', async () => {
    await withDir({
      a: leaf('a'), b: leaf('b'), deny: leaf('deny'),
      inner: bundle('inner', ['a', 'b']),
      outer: bundle('outer', ['inner', 'deny']),
    }, async (dir) => {
      const out = await expandIncludes([resolve(dir, 'outer.conf')], resolver);
      assert.deepEqual(names(out), ['a', 'b', 'deny']);
    });
  });

  test('a leaf reached twice is applied once, at its first position', async () => {
    await withDir({
      a: leaf('a'), b: leaf('b'),
      one: bundle('one', ['a', 'b']),
      two: bundle('two', ['b', 'a']),
    }, async (dir) => {
      const out = await expandIncludes([resolve(dir, 'one.conf'), resolve(dir, 'two.conf')], resolver);
      assert.deepEqual(names(out), ['a', 'b']);
    });
  });

  test('bundles and plain modules mix in one invocation', async () => {
    await withDir({
      a: leaf('a'), b: leaf('b'), extra: leaf('extra'),
      pack: bundle('pack', ['a', 'b']),
    }, async (dir) => {
      const out = await expandIncludes(
        [resolve(dir, 'pack.conf'), resolve(dir, 'extra.conf')], resolver);
      assert.deepEqual(names(out), ['a', 'b', 'extra']);
    });
  });

  // A bundle is expanded away before anything else sees it, so this callback is
  // the only chance its @description — where it says what it is not — has to
  // reach the user before they confirm.
  test('reports each bundle it expands, so its description can be shown', async () => {
    await withDir({
      a: leaf('a'), b: leaf('b'),
      inner: bundle('inner', ['a', 'b']),
      outer: bundle('outer', ['inner']),
    }, async (dir) => {
      const seen: string[] = [];
      await expandIncludes([resolve(dir, 'outer.conf')], resolver, m => seen.push(m.name));
      assert.deepEqual(seen, ['outer', 'inner']);
    });
  });

  test('reports nothing for a plain preset', async () => {
    await withDir({ a: leaf('a') }, async (dir) => {
      const seen: string[] = [];
      await expandIncludes([resolve(dir, 'a.conf')], resolver, m => seen.push(m.name));
      assert.deepEqual(seen, []);
    });
  });

  test('rejects a direct cycle', async () => {
    await withDir({ loop: bundle('loop', ['loop']) }, async (dir) => {
      await assert.rejects(
        () => expandIncludes([resolve(dir, 'loop.conf')], resolver),
        (e: unknown) => e instanceof IncludeCycleError && /loop → loop/.test((e as Error).message),
      );
    });
  });

  test('rejects an indirect cycle', async () => {
    await withDir({
      x: bundle('x', ['y']),
      y: bundle('y', ['z']),
      z: bundle('z', ['x']),
    }, async (dir) => {
      await assert.rejects(
        () => expandIncludes([resolve(dir, 'x.conf')], resolver),
        (e: unknown) => e instanceof IncludeCycleError && /x → y → z → x/.test((e as Error).message),
      );
    });
  });

  // A diamond is not a cycle — both paths reach the same leaf, which dedupes.
  test('accepts a diamond', async () => {
    await withDir({
      shared: leaf('shared'),
      left: bundle('left', ['shared']),
      right: bundle('right', ['shared']),
      top: bundle('top', ['left', 'right']),
    }, async (dir) => {
      const out = await expandIncludes([resolve(dir, 'top.conf')], resolver);
      assert.deepEqual(names(out), ['shared']);
    });
  });
});
