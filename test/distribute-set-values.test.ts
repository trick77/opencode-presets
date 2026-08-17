import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { distributeSetValues } from '../src/batch.js';
import type { BatchModule } from '../src/batch.js';
import type { SetValue } from '../src/cli-args.js';
import type { ConfMeta } from '../src/parse-conf.js';

function mod(name: string, prompts: string[]): BatchModule {
  const meta: ConfMeta = {
    name,
    description: '',
    author: '',
    version: '0.0.0',
    target: 'config',
    path: 'x',
    mode: 'replace',
    fetch: [],
    prompts: prompts.map(p => ({ name: p, type: 'text' as const, help: '' })),
    pins: [],
    requiresBin: [],
    includes: [],
  };
  return { confPath: `${name}.conf`, meta, body: {} };
}

const sv = (name: string, value: string, scope?: string): SetValue =>
  ({ scope, name, value });

describe('distributeSetValues', () => {
  test('routes unscoped value to the only module that declares it', () => {
    const m = mod('mcp-http', ['name', 'url']);
    distributeSetValues([m], [sv('name', 'openrag'), sv('url', 'https://x')]);
    assert.deepEqual(m.promptValues, { name: 'openrag', url: 'https://x' });
  });

  test('scoped value targets the named module', () => {
    const a = mod('mcp-http', ['name']);
    const b = mod('other', ['name']);
    distributeSetValues([a, b], [sv('name', 'openrag', 'mcp-http')]);
    assert.deepEqual(a.promptValues, { name: 'openrag' });
    assert.equal(b.promptValues, undefined);
  });

  test('rejects unknown prompt name', () => {
    const m = mod('mcp-http', ['name']);
    assert.throws(
      () => distributeSetValues([m], [sv('typo', 'x')]),
      /no installed preset declares a prompt/,
    );
  });

  test('rejects scoped value when scope does not match', () => {
    const m = mod('mcp-http', ['name']);
    assert.throws(
      () => distributeSetValues([m], [sv('name', 'x', 'other')]),
      /no preset named "other"/,
    );
  });

  test('rejects ambiguous unscoped value across modules', () => {
    const a = mod('mcp-http', ['name']);
    const b = mod('mcp-http-noauth', ['name']);
    assert.throws(
      () => distributeSetValues([a, b], [sv('name', 'x')]),
      /ambiguous/,
    );
  });

  test('rejects duplicate assignment to the same prompt', () => {
    const m = mod('mcp-http', ['name']);
    assert.throws(
      () => distributeSetValues([m], [sv('name', 'a'), sv('name', 'b')]),
      /provided more than once/,
    );
  });

  test('no-op when setValues is empty', () => {
    const m = mod('mcp-http', ['name']);
    distributeSetValues([m], []);
    assert.equal(m.promptValues, undefined);
  });
});
