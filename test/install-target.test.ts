import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
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
