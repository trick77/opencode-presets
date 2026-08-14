import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { parseConf } from '../src/parse-conf.js';
import { expandIncludes } from '../src/expand-includes.js';

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
  assert.deepEqual(body, ['opencode-plugin-litellm-pricing@0.5.0']);
});

test('ships a litellm provider preset that points at a proxy URL, no models', async () => {
  const preset = resolve(process.cwd(), 'presets/provider-litellm.conf');

  const { meta, body } = await parseConf(preset);

  assert.equal(meta.name, 'provider-litellm');
  assert.equal(meta.path, 'provider.litellm');
  assert.equal(meta.mode, 'replace');

  // The key is prompted for as a secret (hidden input) and written into the
  // config, matching how mcp-http handles header credentials. `pricingURL` is
  // the price table the plugin bills against — prompted with LiteLLM's own
  // published file as the default, so anyone serving an enriched copy can
  // point at it instead.
  // Defaults asserted too: `pricingURL`'s default is the whole point of the
  // prompt, and it has to stay byte-identical to the plugin's own
  // DEFAULT_PRICE_TABLE_URL — a typo here silently installs a dead URL that
  // the plugin can no longer fall back from, since a written value wins.
  assert.deepEqual(
    meta.prompts.map((p) => ({ name: p.name, type: p.type, default: p.default })),
    [
      { name: 'baseURL', type: 'text', default: 'http://localhost:4000/v1' },
      { name: 'apiKey', type: 'secret', default: undefined },
      {
        name: 'pricingURL',
        type: 'text',
        default:
          'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
      },
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
      pricingURL: '{{prompt:pricingURL}}',
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
    'mcp-playwright': [{ name: '@playwright/mcp', version: '0.0.79' }],
    'plugin-litellm-pricing': [{ name: 'opencode-plugin-litellm-pricing', version: '0.5.0' }],
    'plugin-superpowers': [{ name: 'superpowers', version: '6.3.0' }],
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

test('ships a recommended bundle that expands to the read-only modules, then the denies', async () => {
  const dir = resolve(process.cwd(), 'presets');
  const { meta, body } = await parseConf(resolve(dir, 'permissions-recommended.conf'));

  assert.equal(body, null, 'a bundle must have no body of its own');
  assert.equal(meta.path, '', 'a bundle must have no @path of its own');
  assert.deepEqual(meta.includes, [
    'permissions-shell-safe',
    'permissions-git-safe',
    'permissions-toolchain-info',
    'permissions-container-info',
    'permissions-deny-destructive',
    'permissions-deny-cluster-write',
  ]);

  const resolveRef = async (ref: string) => resolve(dir, ref + '.conf');
  const expanded = await expandIncludes([resolve(dir, 'permissions-recommended.conf')], resolveRef);

  // Order is load-bearing: last-match-wins plus an appending `merge` means the
  // deny modules have to land after everything they might otherwise be
  // shadowed by.
  const actions = await Promise.all(expanded.map(async (p) => {
    const { body } = await parseConf(p);
    return new Set(Object.values(body as Record<string, string>));
  }));
  const lastAllow = actions.reduce((last, a, i) => (a.has('allow') ? i : last), -1);
  const firstDeny = actions.findIndex((a) => a.has('deny'));
  assert.ok(firstDeny > lastAllow, 'deny modules must expand after every allow module');

  // Nothing the bundle pulls in may execute project code — that would let
  // `python -c` route around the very deny rules the bundle installs.
  assert.ok(
    !expanded.some((p) => p.endsWith('permissions-build-tools.conf')),
    'the recommended bundle must not include permissions-build-tools',
  );
});

test('every @include in a shipped preset points at another shipped preset', async () => {
  const files = await shippedPresets();
  const stems = new Set(files.map((f) => f.replace(/^.*\//, '').replace(/\.conf$/, '')));

  for (const file of files) {
    const { meta } = await parseConf(file);
    for (const ref of meta.includes) {
      assert.ok(
        stems.has(ref),
        `${meta.name}: @include ${JSON.stringify(ref)} does not name a shipped preset`,
      );
    }
  }
});

// opencode evaluates permission rules with last-match-wins, and `merge` appends
// new keys at the end — so install order would silently decide the outcome of any
// deny/allow pair that can match the same command string. Keeping every shipped
// deny disjoint from every shipped allow makes order irrelevant.
test('keeps shipped deny rules disjoint from shipped allow rules', async () => {
  const deny: { name: string; pattern: string }[] = [];
  const allow: { name: string; pattern: string }[] = [];

  for (const file of await shippedPresets()) {
    const { meta, body } = await parseConf(file);
    if (!meta.path.startsWith('permission.')) continue;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) continue;
    for (const [pattern, action] of Object.entries(body as Record<string, unknown>)) {
      if (action === 'deny') deny.push({ name: meta.name, pattern });
      if (action === 'allow') allow.push({ name: meta.name, pattern });
    }
  }

  // Precondition for the key-vs-key check below: it is only a valid proxy for
  // "no command string matches both" when every deny is a literal prefix with
  // at most a trailing wildcard. Any interior `*` breaks it — `oc * --force`
  // neither matches nor is matched by `oc get *`, yet `oc get pods --force`
  // matches both — and so does a leading one.
  for (const rule of deny) {
    const star = rule.pattern.indexOf('*');
    assert.ok(
      star === -1 || star === rule.pattern.length - 1,
      `${rule.name}: deny pattern ${JSON.stringify(rule.pattern)} must have a wildcard only at the end`,
    );
    assert.ok(
      !rule.pattern.includes('?'),
      `${rule.name}: deny pattern ${JSON.stringify(rule.pattern)} must not use "?"`,
    );
  }

  for (const d of deny) {
    for (const a of allow) {
      assert.ok(
        !globMatch(a.pattern, d.pattern),
        `${a.name}'s allow ${JSON.stringify(a.pattern)} shadows ${d.name}'s deny ${JSON.stringify(d.pattern)}`,
      );
      assert.ok(
        !globMatch(d.pattern, a.pattern),
        `${d.name}'s deny ${JSON.stringify(d.pattern)} shadows ${a.name}'s allow ${JSON.stringify(a.pattern)}`,
      );
    }
  }
});

// Whole-line glob, matching opencode's Wildcard.match: `*` is any run of
// characters, `?` is exactly one, everything else is literal.
function globMatch(pattern: string, subject: string): boolean {
  const source = pattern
    .split('')
    .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`).test(subject);
}

async function shippedPresets(): Promise<string[]> {
  const dir = resolve(process.cwd(), 'presets');
  const entries = await readdir(dir);
  return entries.filter((n) => n.endsWith('.conf')).sort().map((n) => resolve(dir, n));
}
