import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

test('install routes tui presets to OPENCODE_TUI_CONFIG', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-presets-target-'));
  const cacheDir = join(dir, 'cache');
  const opencodeConfig = join(dir, 'opencode.json');
  const tuiConfig = join(dir, 'tui.json');
  const preset = join(dir, 'tui-disable-mouse.conf');

  await writeFile(preset, `// @name: tui-disable-mouse
// @description: Disable mouse capture in the OpenCode TUI.
// @author: test
// @version: 0.1.0
// @target: tui
// @path: mouse

false
`, 'utf8');

  const result = await runCli(['install', preset], {
    OPENCODE_CONFIG: opencodeConfig,
    OPENCODE_TUI_CONFIG: tuiConfig,
    OPENCODE_PRESETS_CACHE: cacheDir,
  }, 'y\n');

  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.match(result.stdout, new RegExp(`Target.*${escapeRegExp(tuiConfig)}`));
  assert.deepEqual(JSON.parse(await readFile(tuiConfig, 'utf8')), {
    '$schema': 'https://opencode.ai/tui.json',
    mouse: false,
  });

  await assert.rejects(() => stat(opencodeConfig), /ENOENT/);
});

test('install proceeds when existing schema errors are unchanged by the preset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-presets-invalid-existing-'));
  const cacheDir = join(dir, 'cache');
  const opencodeConfig = join(dir, 'opencode.json');
  const tuiConfig = join(dir, 'tui.json');

  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(cacheDir, 'schema.json'), JSON.stringify(minimalConfigSchema(), null, 2), 'utf8');
  await writeFile(opencodeConfig, JSON.stringify({
    '$schema': 'https://opencode.ai/config.json',
    mcp: {
      playwright: {
        type: 'local',
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
      },
    },
  }, null, 2) + '\n', 'utf8');

  const result = await runCli(['install', 'permissions-webfetch-ask'], {
    OPENCODE_CONFIG: opencodeConfig,
    OPENCODE_TUI_CONFIG: tuiConfig,
    OPENCODE_PRESETS_CACHE: cacheDir,
  }, 'y\n');

  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.match(result.stderr, /target file is already invalid against the opencode schema/);
  assert.deepEqual(JSON.parse(await readFile(opencodeConfig, 'utf8')), {
    '$schema': 'https://opencode.ai/config.json',
    mcp: {
      playwright: {
        type: 'local',
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
      },
    },
    permission: {
      webfetch: 'ask',
    },
  });
});

test('install reports existing schema errors before the user approves changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-presets-invalid-preflight-'));
  const cacheDir = join(dir, 'cache');
  const opencodeConfig = join(dir, 'opencode.json');
  const tuiConfig = join(dir, 'tui.json');
  const original = {
    '$schema': 'https://opencode.ai/config.json',
    mcp: {
      playwright: {
        type: 'local',
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
      },
    },
  };

  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(cacheDir, 'schema.json'), JSON.stringify(minimalConfigSchema(), null, 2), 'utf8');
  await writeFile(opencodeConfig, JSON.stringify(original, null, 2) + '\n', 'utf8');

  const result = await runCli(['install', 'permissions-webfetch-ask'], {
    OPENCODE_CONFIG: opencodeConfig,
    OPENCODE_TUI_CONFIG: tuiConfig,
    OPENCODE_PRESETS_CACHE: cacheDir,
  }, 'n\n');

  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.match(result.stderr, /target file is already invalid against the opencode schema/);
  assert.match(result.stderr, /where: \/mcp\/playwright/);
  assert.match(result.stderr, /what:\s+must NOT have additional properties/);
  assert.match(result.stdout, /declined/);
  assert.deepEqual(JSON.parse(await readFile(opencodeConfig, 'utf8')), original);
});

test('validate checks config and tui targets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-presets-validate-valid-'));
  const cacheDir = join(dir, 'cache');
  const opencodeConfig = join(dir, 'opencode.json');
  const tuiConfig = join(dir, 'tui.json');

  await writeSchemas(cacheDir);
  await writeFile(opencodeConfig, JSON.stringify({
    '$schema': 'https://opencode.ai/config.json',
    permission: {
      webfetch: 'ask',
    },
  }, null, 2) + '\n', 'utf8');
  await writeFile(tuiConfig, JSON.stringify({
    '$schema': 'https://opencode.ai/tui.json',
    mouse: false,
  }, null, 2) + '\n', 'utf8');

  const result = await runCli(['validate'], {
    OPENCODE_CONFIG: opencodeConfig,
    OPENCODE_TUI_CONFIG: tuiConfig,
    OPENCODE_PRESETS_CACHE: cacheDir,
  }, '');

  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /config: valid/);
  assert.match(result.stdout, /tui: valid/);
});

test('validate skips missing files in all mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-presets-validate-missing-'));
  const cacheDir = join(dir, 'cache');
  const opencodeConfig = join(dir, 'opencode.json');
  const tuiConfig = join(dir, 'tui.json');

  const result = await runCli(['validate', 'all'], {
    OPENCODE_CONFIG: opencodeConfig,
    OPENCODE_TUI_CONFIG: tuiConfig,
    OPENCODE_PRESETS_CACHE: cacheDir,
  }, '');

  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /config: missing/);
  assert.match(result.stdout, /tui: missing/);
});

test('validate reports where and what for invalid config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-presets-validate-invalid-'));
  const cacheDir = join(dir, 'cache');
  const opencodeConfig = join(dir, 'opencode.json');
  const tuiConfig = join(dir, 'tui.json');

  await writeSchemas(cacheDir);
  await writeFile(opencodeConfig, JSON.stringify({
    '$schema': 'https://opencode.ai/config.json',
    mcp: {
      playwright: {
        type: 'local',
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
      },
    },
  }, null, 2) + '\n', 'utf8');

  const result = await runCli(['validate', 'config'], {
    OPENCODE_CONFIG: opencodeConfig,
    OPENCODE_TUI_CONFIG: tuiConfig,
    OPENCODE_PRESETS_CACHE: cacheDir,
  }, '');

  assert.equal(result.code, 1, result.stderr + result.stdout);
  assert.match(result.stdout, /config: invalid/);
  assert.match(result.stderr, /where: \/mcp\/playwright/);
  assert.match(result.stderr, /what:\s+must NOT have additional properties/);
  assert.match(result.stderr, /detail: \{"additionalProperty":"args"\}/);
});

function runCli(
  args: string[],
  env: Record<string, string>,
  input: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const bin = resolve(import.meta.dirname, '../bin/opencode-presets.js');
    const child = spawn(process.execPath, [bin, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', rejectPromise);
    child.on('close', code => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function writeSchemas(cacheDir: string): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(cacheDir, 'schema.json'), JSON.stringify(minimalConfigSchema(), null, 2), 'utf8');
  await writeFile(join(cacheDir, 'tui-schema.json'), JSON.stringify(minimalTuiSchema(), null, 2), 'utf8');
}

function minimalConfigSchema(): object {
  return {
    '$schema': 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      '$schema': { type: 'string' },
      permission: {
        type: 'object',
        additionalProperties: { enum: ['allow', 'ask', 'deny'] },
      },
      mcp: {
        type: 'object',
        additionalProperties: {
          anyOf: [
            {
              type: 'object',
              properties: {
                type: { const: 'local' },
                command: {
                  type: 'array',
                  items: { type: 'string' },
                },
                enabled: { type: 'boolean' },
              },
              required: ['type', 'command'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                type: { const: 'remote' },
                url: { type: 'string' },
                enabled: { type: 'boolean' },
              },
              required: ['type', 'url'],
              additionalProperties: false,
            },
          ],
        },
      },
    },
    additionalProperties: true,
  };
}

function minimalTuiSchema(): object {
  return {
    '$schema': 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      '$schema': { type: 'string' },
      mouse: { type: 'boolean' },
    },
    additionalProperties: false,
  };
}
