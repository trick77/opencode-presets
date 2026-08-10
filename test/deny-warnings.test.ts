import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findShadowedDenies, agentOverrideWarnings } from '../src/batch.js';
import type { ConfMeta } from '../src/parse-conf.js';

function meta(path: string): ConfMeta {
  return {
    name: 'm', description: '', author: '', version: '0.0.0',
    target: 'config', path, mode: 'merge',
    fetch: [], prompts: [], pins: [], includes: [],
  };
}

describe('findShadowedDenies', () => {
  test('names a deny that an existing allow keeps out', () => {
    const found = findShadowedDenies({ 'rm -rf /': 'deny' }, { 'rm -rf /': 'allow' });
    assert.deepEqual(found, [{ key: 'rm -rf /', current: 'allow' }]);
  });

  test('names a deny that an existing ask keeps out', () => {
    const found = findShadowedDenies({ 'sudo *': 'deny' }, { 'sudo *': 'ask' });
    assert.deepEqual(found, [{ key: 'sudo *', current: 'ask' }]);
  });

  test('says nothing when the key is already denied', () => {
    assert.deepEqual(findShadowedDenies({ 'dd *': 'deny' }, { 'dd *': 'deny' }), []);
  });

  test('says nothing when the key is absent — the deny will apply', () => {
    assert.deepEqual(findShadowedDenies({ 'dd *': 'deny' }, { 'ls': 'allow' }), []);
  });

  // A preserved allow is the normal, uninteresting case; only denies warn.
  test('ignores a preserved allow', () => {
    assert.deepEqual(findShadowedDenies({ 'ls': 'allow' }, { 'ls': 'ask' }), []);
  });

  test('reports every shadowed deny, in body order', () => {
    const found = findShadowedDenies(
      { 'sudo *': 'deny', 'dd *': 'deny', 'rm -rf /': 'deny' },
      { 'rm -rf /': 'allow', 'sudo *': 'ask' },
    );
    assert.deepEqual(found.map(f => f.key), ['sudo *', 'rm -rf /']);
  });

  test('tolerates a non-object body or target', () => {
    assert.deepEqual(findShadowedDenies('scalar', { a: 'allow' }), []);
    assert.deepEqual(findShadowedDenies({ 'a': 'deny' }, undefined), []);
    assert.deepEqual(findShadowedDenies({ 'a': 'deny' }, 'ask'), []);
  });
});

describe('agentOverrideWarnings', () => {
  const permModule = [{ meta: meta('permission.bash') }];

  test('warns about agents that set their own permission rules', () => {
    const out = agentOverrideWarnings(permModule, {
      agent: { build: { permission: { bash: { '*': 'allow' } } } },
    });
    assert.match(out[0], /build/);
    // The warning has to say what to do about it, not just that it happened.
    assert.match(out.join('\n'), /fix:/);
    assert.match(out.join('\n'), /agent\.build\.permission/);
  });

  test('ignores agents that configure something else', () => {
    const out = agentOverrideWarnings(permModule, { agent: { plan: { temperature: 0.1 } } });
    assert.deepEqual(out, []);
  });

  test('lists every overriding agent', () => {
    const out = agentOverrideWarnings(permModule, {
      agent: {
        build: { permission: { bash: {} } },
        plan: { temperature: 0.1 },
        general: { permission: { edit: 'deny' } },
      },
    });
    assert.match(out[0], /build, general/);
  });

  test('stays quiet when no module writes permissions', () => {
    const out = agentOverrideWarnings([{ meta: meta('lsp.jdtls') }], {
      agent: { build: { permission: { bash: { '*': 'allow' } } } },
    });
    assert.deepEqual(out, []);
  });

  test('fires for the bare permission path too, not just permission.bash', () => {
    const out = agentOverrideWarnings([{ meta: meta('permission') }], {
      agent: { build: { permission: { bash: {} } } },
    });
    assert.ok(out.length > 0);
    assert.match(out[0], /build/);
  });

  test('stays quiet with no config, or no agent block', () => {
    assert.deepEqual(agentOverrideWarnings(permModule, null), []);
    assert.deepEqual(agentOverrideWarnings(permModule, { theme: 'x' }), []);
  });
});
