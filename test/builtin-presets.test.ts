import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { parseConf } from '../src/parse-conf.js';

test('ships a preset that makes webfetch ask before use', async () => {
  const preset = resolve(process.cwd(), 'presets/permissions-webfetch-ask.conf');

  const { meta, body } = await parseConf(preset);

  assert.equal(meta.name, 'permissions-webfetch-ask');
  assert.equal(meta.path, 'permission');
  assert.equal(meta.mode, 'merge');
  assert.deepEqual(body, {
    webfetch: 'ask',
  });
});

test('ships a runaway guard preset with step limits for built-in agents', async () => {
  const preset = resolve(process.cwd(), 'presets/agent-runaway-guard.conf');

  const { meta, body } = await parseConf(preset);

  assert.equal(meta.name, 'agent-runaway-guard');
  assert.equal(meta.path, 'agent');
  assert.equal(meta.mode, 'merge');
  assert.deepEqual(body, {
    build: {
      steps: 50,
    },
    plan: {
      steps: 20,
    },
    general: {
      steps: 15,
    },
    explore: {
      steps: 10,
    },
  });
});

test('ships a litellm plugin preset that appends the runtime-discovery plugin', async () => {
  const preset = resolve(process.cwd(), 'presets/plugin-litellm.conf');

  const { meta, body } = await parseConf(preset);

  assert.equal(meta.name, 'plugin-litellm');
  assert.equal(meta.path, 'plugin');
  assert.equal(meta.mode, 'append');
  assert.deepEqual(body, ['opencode-plugin-litellm@0.5.0']);
});

test('ships a litellm provider preset that points at a proxy URL, no models', async () => {
  const preset = resolve(process.cwd(), 'presets/provider-litellm.conf');

  const { meta, body } = await parseConf(preset);

  assert.equal(meta.name, 'provider-litellm');
  assert.equal(meta.path, 'provider.litellm');
  assert.equal(meta.mode, 'replace');

  // Only the base URL is prompted; the key comes from $LITELLM_API_KEY.
  assert.deepEqual(
    meta.prompts.map((p) => ({ name: p.name, type: p.type })),
    [{ name: 'baseURL', type: 'text' }],
  );

  // No `models` block — the plugin discovers models at runtime.
  // Body keeps the {{prompt:...}} placeholder until install-time expansion.
  assert.deepEqual(body, {
    npm: '@ai-sdk/openai-compatible',
    name: 'LiteLLM (proxy)',
    options: {
      baseURL: '{{prompt:baseURL}}',
      apiKey: '{env:LITELLM_API_KEY}',
    },
  });
});
