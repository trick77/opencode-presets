import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
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
  const preset = resolve(process.cwd(), 'presets/plugin-litellm-pricing.conf');

  const { meta, body } = await parseConf(preset);

  assert.equal(meta.name, 'plugin-litellm-pricing');
  assert.equal(meta.path, 'plugin');
  assert.equal(meta.mode, 'append');
  assert.deepEqual(body, ['opencode-litellm-pricing@0.2.0']);
});

test('ships a litellm provider preset that points at a proxy URL, no models', async () => {
  const preset = resolve(process.cwd(), 'presets/provider-litellm.conf');

  const { meta, body } = await parseConf(preset);

  assert.equal(meta.name, 'provider-litellm');
  assert.equal(meta.path, 'provider.litellm');
  assert.equal(meta.mode, 'replace');

  // The key is prompted for as a secret (hidden input) and written into the
  // config, matching how mcp-http handles header credentials.
  assert.deepEqual(
    meta.prompts.map((p) => ({ name: p.name, type: p.type })),
    [
      { name: 'baseURL', type: 'text' },
      { name: 'apiKey', type: 'secret' },
    ],
  );

  // No `models` block — the plugin discovers models at runtime.
  // Body keeps the {{prompt:...}} placeholders until install-time expansion.
  assert.deepEqual(body, {
    npm: '@ai-sdk/openai-compatible',
    name: 'LiteLLM (proxy)',
    options: {
      baseURL: '{{prompt:baseURL}}',
      apiKey: '{{prompt:apiKey}}',
    },
  });
});

test('ships a litellm MCP gateway preset with a static path and hardcoded auth header', async () => {
  const preset = resolve(process.cwd(), 'presets/mcp-litellm.conf');

  const { meta, body } = await parseConf(preset);

  assert.equal(meta.name, 'mcp-litellm');
  assert.equal(meta.mode, 'replace');

  // Static path, unlike mcp-http's mcp.{{prompt:name}} — so `remove` works.
  assert.equal(meta.path, 'mcp.litellm');

  assert.deepEqual(
    meta.prompts.map((p) => ({ name: p.name, type: p.type, default: p.default })),
    [
      { name: 'url', type: 'text', default: 'http://localhost:4000/mcp/' },
      { name: 'apiKey', type: 'secret', default: undefined },
    ],
  );

  // The header name is not prompted: LiteLLM reserves Authorization for OAuth.
  // "Bearer " lives in the body so the prompt takes a bare sk-... key.
  assert.deepEqual(body, {
    type: 'remote',
    url: '{{prompt:url}}',
    enabled: true,
    headers: {
      'x-litellm-api-key': 'Bearer {{prompt:apiKey}}',
    },
  });
});

test('ships a litellm passthrough-header preset that writes a single header value', async () => {
  const preset = resolve(process.cwd(), 'presets/mcp-litellm-passthrough.conf');

  const { meta, body } = await parseConf(preset);

  assert.equal(meta.name, 'mcp-litellm-passthrough');
  assert.equal(meta.mode, 'replace');

  // Bracket-quoted segment so header names survive parsePath even with a dot.
  assert.equal(meta.path, 'mcp.litellm.headers["{{prompt:headerName}}"]');

  assert.deepEqual(
    meta.prompts.map((p) => ({ name: p.name, type: p.type })),
    [
      { name: 'headerName', type: 'text' },
      { name: 'headerValue', type: 'secret' },
    ],
  );

  // Scalar body: applyAtPath creates mcp.litellm.headers if it isn't there yet.
  assert.equal(body, '{{prompt:headerValue}}');
});

test('records the pinned third-party version of every preset that installs one', async () => {
  const expected: Record<string, Array<{ name: string; version: string }>> = {
    'jdtls-lombok': [{ name: 'lombok', version: '1.18.46' }],
    'mcp-playwright': [{ name: '@playwright/mcp', version: '0.0.78' }],
    'plugin-litellm-pricing': [{ name: 'opencode-litellm-pricing', version: '0.2.0' }],
    'plugin-superpowers': [{ name: 'superpowers', version: '6.2.0' }],
  };

  for (const [name, pins] of Object.entries(expected)) {
    const { meta } = await parseConf(resolve(process.cwd(), `presets/${name}.conf`));
    assert.deepEqual(meta.pins, pins, `${name} pins`);
  }
});

test('every @pins version actually appears in the body or fetch it describes', async () => {
  for (const file of await shippedPresets()) {
    const { meta, body } = await parseConf(file);
    const haystack = JSON.stringify(body) +
      meta.fetch.map((f) => f.url + f.dest).join('');

    for (const pin of meta.pins) {
      assert.ok(
        haystack.includes(pin.version),
        `${meta.name}: @pins says ${pin.name} ${pin.version}, but that version ` +
        'appears nowhere in the body or @fetch lines — one side was bumped without the other',
      );
    }
  }
});

test('every @fetch destination is actually referenced by the preset it feeds', async () => {
  for (const file of await shippedPresets()) {
    const { meta, body } = await parseConf(file);
    const haystack = JSON.stringify(body) + meta.path;

    for (const f of meta.fetch) {
      assert.ok(
        haystack.includes(f.dest),
        `${meta.name}: @fetch writes ${f.dest}, but nothing in the body or @path ` +
        'points at it — the fetch was bumped without the reference that uses it',
      );
    }
  }
});

test('keeps shipped descriptions short enough to read at the install prompt', async () => {
  const MAX = 450;

  for (const file of await shippedPresets()) {
    const { meta } = await parseConf(file);
    assert.ok(
      meta.description.length <= MAX,
      `${meta.name}: description is ${meta.description.length} chars, max is ${MAX}`,
    );
  }
});

async function shippedPresets(): Promise<string[]> {
  const dir = resolve(process.cwd(), 'presets');
  const entries = await readdir(dir);
  return entries.filter((n) => n.endsWith('.conf')).sort().map((n) => resolve(dir, n));
}
