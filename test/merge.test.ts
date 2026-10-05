import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join, sep } from 'node:path';
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
    const root = { plugin: ['superpowers@6.3.0', 'pricing@0.8.1'] };
    const { next, stats } = applyAtPath(root, 'plugin', ['pricing@0.9.0'], 'append');
    assert.deepEqual((next as any).plugin, ['superpowers@6.3.0', 'pricing@0.9.0']);
    assert.equal(stats.added, 0);
    assert.equal(stats.superseded, 1);
  });

  test('collapses a config that already stacked several versions, keeping position', () => {
    const root = { plugin: ['pricing@0.7.0', 'superpowers@6.3.0', 'pricing@0.8.0', 'pricing@0.8.1'] };
    const { next, stats } = applyAtPath(root, 'plugin', ['pricing@0.9.0'], 'append');
    assert.deepEqual((next as any).plugin, ['pricing@0.9.0', 'superpowers@6.3.0']);
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

  // `[name@spec, {options}]` is the same package as the plain string, so
  // switching between a preset with plugin options and one without must not
  // leave the plugin loading twice.
  test('a plugin tuple with options and a plain spec supersede each other', () => {
    const toTuple = applyAtPath(
      { plugin: ['superpowers@6.3.0', 'pricing@0.8.1'] },
      'plugin',
      [['pricing@0.9.0', { token: 't' }]],
      'append'
    );
    assert.deepEqual((toTuple.next as any).plugin, ['superpowers@6.3.0', ['pricing@0.9.0', { token: 't' }]]);
    assert.equal(toTuple.stats.superseded, 1);

    const toPlain = applyAtPath({ plugin: [['pricing@0.9.0', { token: 't' }]] }, 'plugin', ['pricing@0.9.0'], 'append');
    assert.deepEqual((toPlain.next as any).plugin, ['pricing@0.9.0']);
    assert.equal(toPlain.stats.superseded, 1);
  });

  test('a plugin tuple with changed options replaces the old tuple', () => {
    const root = { plugin: [['pricing@0.9.0', { token: 'old' }]] };
    const { next, stats } = applyAtPath(root, 'plugin', [['pricing@0.9.0', { token: 'new' }]], 'append');
    assert.deepEqual((next as any).plugin, [['pricing@0.9.0', { token: 'new' }]]);
    assert.equal(stats.added, 0);
    assert.equal(stats.superseded, 1);
  });

  // A versioned `@fetch` dest is a new path on every bump; opencode loads every
  // `instructions` and `skills.paths` entry, so the old one must go.
  describe('versioned cache paths', () => {
    const cacheDir = join(sep, 'home', 'u', '.cache', 'opencode-presets');
    const at = (p: string) => join(cacheDir, p);
    const opts = { cacheDir };

    test('supersede an older version in place', () => {
      const root = { skills: { paths: ['/home/u/diagram-design', at('planify-skills-0.3.2')] } };
      const { next, stats } = applyAtPath(root, 'skills.paths', [at('planify-skills-0.4.0')], 'append', opts);
      assert.deepEqual((next as any).skills.paths, ['/home/u/diagram-design', at('planify-skills-0.4.0')]);
      assert.equal(stats.added, 0);
      assert.equal(stats.superseded, 1);
    });

    test('collapse a config that already stacked several versions', () => {
      const root = { instructions: [at('planify-rules-0.3.1.md'), '/x/AGENTS.md', at('planify-rules-0.3.2.md')] };
      const { next } = applyAtPath(root, 'instructions', [at('planify-rules-0.4.0.md')], 'append', opts);
      assert.deepEqual((next as any).instructions, [at('planify-rules-0.4.0.md'), '/x/AGENTS.md']);
    });

    test('reinstalling the same version stays a preserved no-op', () => {
      const root = { instructions: [at('planify-rules-0.4.0.md')] };
      const { next, stats } = applyAtPath(root, 'instructions', [at('planify-rules-0.4.0.md')], 'append', opts);
      assert.deepEqual((next as any).instructions, [at('planify-rules-0.4.0.md')]);
      assert.equal(stats.preserved, 1);
      assert.equal(stats.superseded, 0);
    });

    test('different families in the cache dir do not touch each other', () => {
      const root = { p: [at('planify-rules-0.4.0.md')] };
      const { next } = applyAtPath(root, 'p', [at('planify-skills-0.4.0')], 'append', opts);
      assert.deepEqual((next as any).p, [at('planify-rules-0.4.0.md'), at('planify-skills-0.4.0')]);
    });

    // Outside the cache dir a path is the user's (a prompted dir, a hand-added
    // entry); a version-looking name there is no evidence it is ours to delete.
    test('leave versioned paths outside the cache dir to plain append', () => {
      const root = { p: ['/home/u/tools-1.0.0'] };
      const { next, stats } = applyAtPath(root, 'p', ['/home/u/tools-2.0.0'], 'append', opts);
      assert.deepEqual((next as any).p, ['/home/u/tools-1.0.0', '/home/u/tools-2.0.0']);
      assert.equal(stats.superseded, 0);
    });

    test('leave unversioned cache paths to plain append', () => {
      const root = { p: [at('rules-a.md')] };
      const { next } = applyAtPath(root, 'p', [at('rules-b.md')], 'append', opts);
      assert.deepEqual((next as any).p, [at('rules-a.md'), at('rules-b.md')]);
    });

    test('a sibling dir sharing the cache dir as a name prefix is not the cache', () => {
      const root = { p: [join(cacheDir + '-old', 'x-1.0.0')] };
      const { next } = applyAtPath(root, 'p', [join(cacheDir + '-old', 'x-2.0.0')], 'append', opts);
      assert.equal((next as any).p.length, 2);
    });

    test('a pre-release keeps the extension and supersedes both ways', () => {
      const up = applyAtPath({ p: [at('rules-0.4.0.md')] }, 'p', [at('rules-0.5.0-rc.1.md')], 'append', opts);
      assert.deepEqual((up.next as any).p, [at('rules-0.5.0-rc.1.md')]);
      const down = applyAtPath(up.next, 'p', [at('rules-0.5.0.md')], 'append', opts);
      assert.deepEqual((down.next as any).p, [at('rules-0.5.0.md')]);
    });

    test('same version, different platform suffix, are different entries', () => {
      const root = { p: [at('tool-1.0.0-linux.tar')] };
      const { next, stats } = applyAtPath(root, 'p', [at('tool-1.0.0-darwin.tar')], 'append', opts);
      assert.deepEqual((next as any).p, [at('tool-1.0.0-linux.tar'), at('tool-1.0.0-darwin.tar')]);
      assert.equal(stats.superseded, 0);
    });

    // `{{cache}}/x` is plain substitution, so the separator after the cache
    // dir is always `/`, whatever the platform separator is.
    test('a `/` after the cache dir matches regardless of platform', () => {
      const root = { p: [cacheDir + '/rules-0.3.2.md'] };
      const { next } = applyAtPath(root, 'p', [cacheDir + '/rules-0.4.0.md'], 'append', opts);
      assert.deepEqual((next as any).p, [cacheDir + '/rules-0.4.0.md']);
    });

    test('without a cacheDir, paths keep plain append', () => {
      const root = { p: [at('planify-skills-0.3.2')] };
      const { next } = applyAtPath(root, 'p', [at('planify-skills-0.4.0')], 'append');
      assert.equal((next as any).p.length, 2);
    });
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
