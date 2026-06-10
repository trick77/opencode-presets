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
