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
