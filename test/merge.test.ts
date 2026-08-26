import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyAtPath, removeAtPath, getAtPath } from '../src/merge.js';

describe('applyAtPath — replace mode', () => {
  test('creates a value at a fresh deep path', () => {
    const { next, stats } = applyAtPath({}, 'a.b.c', 42, 'replace');
    assert.deepEqual(next, { a: { b: { c: 42 } } });
    assert.equal(stats.replaced, true);
  });

  test('replaces an existing value wholesale', () => {
    const root = { a: { b: { c: [1, 2, 3] } } };
    const { next } = applyAtPath(root, 'a.b.c', 'new', 'replace');
    assert.equal((next as any).a.b.c, 'new');
  });

  test('idempotent re-application reports replaced=false', () => {
    const { next: r1 } = applyAtPath({}, 'x.y', 'v', 'replace');
    const { stats } = applyAtPath(r1, 'x.y', 'v', 'replace');
    assert.equal(stats.replaced, false);
  });

  test('does not mutate the input root', () => {
    const root = { a: 1 };
    applyAtPath(root, 'a', 2, 'replace');
    assert.deepEqual(root, { a: 1 });
  });
});

describe('applyAtPath — merge mode (additive)', () => {
  test('adds missing keys', () => {
    const { next, stats } = applyAtPath({}, 'p', { a: 1, b: 2 }, 'merge');
    assert.deepEqual((next as any).p, { a: 1, b: 2 });
    assert.equal(stats.added, 2);
    assert.equal(stats.preserved, 0);
  });

  test('preserves existing keys (never overwrites)', () => {
    const root = { p: { a: 'old' } };
    const { next, stats } = applyAtPath(root, 'p', { a: 'new', b: 'added' }, 'merge');
    assert.equal((next as any).p.a, 'old');     // preserved
    assert.equal((next as any).p.b, 'added');   // added
    assert.equal(stats.added, 1);
    assert.equal(stats.preserved, 1);
    assert.equal(stats.overwritten, 0);
  });

  test('rejects non-object body', () => {
    assert.throws(() => applyAtPath({}, 'p', [1, 2], 'merge'), /JSON object/);
  });

  test('idempotent: re-applying yields preserved=N, added=0', () => {
    const { next: r1 } = applyAtPath({}, 'p', { a: 1, b: 2 }, 'merge');
    const { stats } = applyAtPath(r1, 'p', { a: 1, b: 2 }, 'merge');
    assert.equal(stats.added, 0);
    assert.equal(stats.preserved, 2);
  });
});

describe('applyAtPath — merge-overwrite mode', () => {
  test('overwrites overlapping keys with different values', () => {
    const root = { p: { a: 'old', b: 'kept' } };
    const { next, stats } = applyAtPath(
      root,
      'p',
      { a: 'new', b: 'kept', c: 'added' },
      'merge-overwrite'
    );
    assert.equal((next as any).p.a, 'new');
    assert.equal((next as any).p.b, 'kept');
    assert.equal((next as any).p.c, 'added');
    assert.equal(stats.added, 1);
    assert.equal(stats.preserved, 1);   // b matches, treated as preserved
    assert.equal(stats.overwritten, 1); // a was different
  });
});

describe('applyAtPath — append mode', () => {
  test('creates an array at a fresh path', () => {
    const { next, stats } = applyAtPath({}, 'plugin', ['a'], 'append');
    assert.deepEqual((next as any).plugin, ['a']);
    assert.equal(stats.added, 1);
    assert.equal(stats.preserved, 0);
  });

  test('appends missing values and preserves existing values', () => {
    const root = { plugin: ['a'] };
    const { next, stats } = applyAtPath(root, 'plugin', ['a', 'b'], 'append');
    assert.deepEqual((next as any).plugin, ['a', 'b']);
    assert.equal(stats.added, 1);
    assert.equal(stats.preserved, 1);
  });

  test('deduplicates objects by deep equality', () => {
    const root = { plugin: [['pkg', { enabled: true }]] };
    const { next, stats } = applyAtPath(root, 'plugin', [['pkg', { enabled: true }]], 'append');
    assert.deepEqual((next as any).plugin, [['pkg', { enabled: true }]]);
    assert.equal(stats.added, 0);
    assert.equal(stats.preserved, 1);
  });

  // opencode loads every entry in `plugin`, so leaving an old `pkg@0.8.1`
  // behind next to a new `pkg@0.9.0` loads the plugin twice at two versions.
  test('supersedes an older version of the same package instead of stacking it', () => {
    const root = { plugin: ['opencode-plugin-dcg@0.2.0', 'pricing@0.8.1'] };
    const { next, stats } = applyAtPath(root, 'plugin', ['pricing@0.9.0'], 'append');
    assert.deepEqual((next as any).plugin, ['opencode-plugin-dcg@0.2.0', 'pricing@0.9.0']);
    assert.equal(stats.added, 0);
    assert.equal(stats.superseded, 1);
  });

  test('collapses a config that already stacked several versions, keeping position', () => {
    const root = { plugin: ['pricing@0.7.0', 'dcg@0.2.0', 'pricing@0.8.0', 'pricing@0.8.1'] };
    const { next, stats } = applyAtPath(root, 'plugin', ['pricing@0.9.0'], 'append');
    assert.deepEqual((next as any).plugin, ['pricing@0.9.0', 'dcg@0.2.0']);
    assert.equal(stats.superseded, 3);
  });

  test('reinstalling the same version stays a preserved no-op', () => {
    const root = { plugin: ['pricing@0.9.0'] };
    const { next, stats } = applyAtPath(root, 'plugin', ['pricing@0.9.0'], 'append');
    assert.deepEqual((next as any).plugin, ['pricing@0.9.0']);
    assert.equal(stats.preserved, 1);
    assert.equal(stats.superseded, 0);
  });

  // The upgrade path from a config the old code stacked: the newest version is
  // already present next to a stale one, so an equality-first check would call
  // this a preserved no-op and leave the plugin loading twice.
  test('collapses a stale sibling even when the incoming version is already present', () => {
    const root = { plugin: ['pricing@0.8.1', 'pricing@0.9.0'] };
    const { next, stats } = applyAtPath(root, 'plugin', ['pricing@0.9.0'], 'append');
    assert.deepEqual((next as any).plugin, ['pricing@0.9.0']);
    assert.equal(stats.added, 0);
    assert.equal(stats.superseded, 2); // stale entry replaced, exact duplicate dropped
  });

  test('matches scoped packages and git specs on the package name', () => {
    const scoped = applyAtPath({ plugin: ['@scope/pkg@1.0.0'] }, 'plugin', ['@scope/pkg@2.0.0'], 'append');
    assert.deepEqual((scoped.next as any).plugin, ['@scope/pkg@2.0.0']);

    const git = applyAtPath(
      { plugin: ['superpowers@git+https://github.com/obra/superpowers.git#v6.3.0'] },
      'plugin',
      ['superpowers@git+https://github.com/obra/superpowers.git#v6.4.0'],
      'append'
    );
    assert.deepEqual((git.next as any).plugin, ['superpowers@git+https://github.com/obra/superpowers.git#v6.4.0']);
  });

  // Only `name@spec` entries carry a package identity. A fetched skill path or
  // a prompted directory must keep the plain additive behaviour, or unrelated
  // entries sharing a prefix would silently delete each other.
  test('leaves non-package entries to plain append', () => {
    const root = { skill: ['{{cache}}/planify-skills-0.3.2'] };
    const { next, stats } = applyAtPath(root, 'skill', ['{{cache}}/planify-skills-0.4.0'], 'append');
    assert.deepEqual((next as any).skill, ['{{cache}}/planify-skills-0.3.2', '{{cache}}/planify-skills-0.4.0']);
    assert.equal(stats.added, 1);
    assert.equal(stats.superseded, 0);
  });

  // `git+https://user@host/...` has a trailing `@` that does not split a
  // package name; splitting there would key on a URL fragment.
  test('ignores a git spec whose URL carries credentials', () => {
    const root = { plugin: ['pkg@git+https://user@host/a.git#v1'] };
    const { next, stats } = applyAtPath(root, 'plugin', ['pkg@git+https://user@host/a.git#v2'], 'append');
    assert.equal((next as any).plugin.length, 2);
    assert.equal(stats.added, 1);
    assert.equal(stats.superseded, 0);
  });

  test('rejects non-array body', () => {
    assert.throws(() => applyAtPath({}, 'plugin', { a: 1 }, 'append'), /JSON array/);
  });

  test('rejects existing non-array target', () => {
    assert.throws(() => applyAtPath({ plugin: {} }, 'plugin', ['a'], 'append'), /existing value at path/);
  });
});

describe('removeAtPath — replace mode', () => {
  test('deletes the leaf and prunes empty parents', () => {
    const root = { a: { b: { c: 'x' } }, other: 1 };
    const { next, stats } = removeAtPath(root, 'a.b.c', undefined, 'replace');
    assert.deepEqual(next, { other: 1 });
    assert.equal(stats.removed, 1);
    assert.equal(stats.missing, false);
  });

  test('keeps non-empty siblings of pruned parents', () => {
    const root = { a: { b: { c: 'x', d: 'y' } } };
    const { next } = removeAtPath(root, 'a.b.c', undefined, 'replace');
    assert.deepEqual(next, { a: { b: { d: 'y' } } });
  });

  test('reports missing for non-existent paths', () => {
    const { stats } = removeAtPath({ a: 1 }, 'x.y.z', undefined, 'replace');
    assert.equal(stats.missing, true);
    assert.equal(stats.removed, 0);
  });
});

describe('removeAtPath — merge mode', () => {
  test('removes only matching keys, keeps divergent ones', () => {
    const root = { p: { a: 'allow', b: 'allow', c: 'deny' } };
    const body = { a: 'allow', b: 'allow', c: 'allow' };  // c diverges
    const { next, stats } = removeAtPath(root, 'p', body, 'merge');
    assert.deepEqual((next as any).p, { c: 'deny' });
    assert.equal(stats.removed, 2);
    assert.equal(stats.kept, 1);
  });

  test('prunes parent when removal empties it', () => {
    const root = { p: { a: 'allow' } };
    const { next } = removeAtPath(root, 'p', { a: 'allow' }, 'merge');
    assert.deepEqual(next, {});
  });

  test('keeps parent when divergent keys remain', () => {
    const root = { p: { a: 'allow', b: 'deny' } };
    const { next } = removeAtPath(root, 'p', { a: 'allow', b: 'allow' }, 'merge');
    assert.deepEqual((next as any).p, { b: 'deny' });
  });
});

describe('removeAtPath — append mode', () => {
  test('removes matching array entries only', () => {
    const root = { plugin: ['a', 'b', 'c'] };
    const { next, stats } = removeAtPath(root, 'plugin', ['b'], 'append');
    assert.deepEqual((next as any).plugin, ['a', 'c']);
    assert.equal(stats.removed, 1);
  });

  test('prunes parent when removal empties array', () => {
    const root = { plugin: ['a'] };
    const { next } = removeAtPath(root, 'plugin', ['a'], 'append');
    assert.deepEqual(next, {});
  });
});

describe('getAtPath', () => {
  test('reads a deep dotted path', () => {
    assert.equal(getAtPath({ a: { b: { c: 7 } } }, 'a.b.c'), 7);
  });

  test('returns undefined for missing path', () => {
    assert.equal(getAtPath({}, 'a.b.c'), undefined);
  });

  test('handles bracketed quoted segments', () => {
    const root = { a: { 'weird key': { c: 1 } } };
    assert.equal(getAtPath(root, 'a["weird key"].c'), 1);
    assert.equal(getAtPath(root, "a['weird key'].c"), 1);
  });

  test('throws on malformed brackets', () => {
    assert.throws(() => getAtPath({}, 'a[unquoted]'), /quoted string/);
    assert.throws(() => getAtPath({}, 'a["unterminated'), /unterminated/);
  });
});
