import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { parseConf, parseConfString } from '../src/parse-conf.js';
import { pinSourceFor, manualReason } from '../src/pin-sources.js';
import {
  bumpType, nextPresetVersion, pickEligible,
  rewriteConf, rewriteReadmeRow, rewriteExpectedPins,
} from '../src/pin-bump.js';

const DAY = 86_400_000;
const now = new Date('2026-11-02T08:00:00Z');
const ago = (days: number) => new Date(now.getTime() - days * DAY);

describe('bumpType', () => {
  test('first differing segment decides, 0.x included', () => {
    assert.equal(bumpType('0.0.83', '0.0.84'), 'patch');
    assert.equal(bumpType('0.0.83', '0.1.0'), 'minor');
    assert.equal(bumpType('6.4.2', '7.0.0'), 'major');
    assert.equal(bumpType('7.0.0', '7.0.10'), 'patch');
  });

  test('null when not newer', () => {
    assert.equal(bumpType('7.0.1', '7.0.0'), null);
    assert.equal(bumpType('7.0.0', '7.0.0'), null);
  });
});

describe('nextPresetVersion', () => {
  // Matches #140: playwright patch 0.2.3→0.2.4, superpowers major 0.2.2→0.3.0.
  test('patch → patch, minor and major → minor', () => {
    assert.equal(nextPresetVersion('0.2.3', 'patch'), '0.2.4');
    assert.equal(nextPresetVersion('0.2.2', 'major'), '0.3.0');
    assert.equal(nextPresetVersion('1.0.9', 'minor'), '1.1.0');
  });
});

describe('pickEligible', () => {
  test('takes the newest release past the cooldown, not the latest', () => {
    const r = pickEligible([
      { version: '0.0.84', date: ago(10) },
      { version: '0.0.85', date: ago(8) },
      { version: '0.0.86', date: ago(2) },
    ], '0.0.83', now);
    assert.equal(r.eligible?.version, '0.0.85');
    assert.equal(r.waitingUntil?.toISOString(), new Date(ago(2).getTime() + 7 * DAY).toISOString());
  });

  test('nothing ripe → no bump, says when', () => {
    const r = pickEligible([{ version: '7.0.1', date: ago(3) }], '7.0.0', now);
    assert.equal(r.eligible, null);
    assert.equal(r.waitingUntil?.toISOString(), new Date(ago(3).getTime() + 7 * DAY).toISOString());
  });

  test('ignores older, equal and non-plain versions', () => {
    const r = pickEligible([
      { version: '7.0.0', date: ago(30) },
      { version: '6.9.9', date: ago(30) },
      { version: '8.0.0-rc.1', date: ago(30) },
    ], '7.0.0', now);
    assert.deepEqual(r, { eligible: null, waitingUntil: null });
  });
});

const PRESET = `// @name: demo
// @description: Adds demo.
// @author: Jan <jan@trick77.com>
// @version: 0.2.4
// @path: mcp.demo
// @pins: demo 0.0.83
{
  "command": ["npx", "-y", "demo@0.0.83"],
  "note": "not 10.0.83 nor 0.0.831"
}`;

describe('rewriteConf', () => {
  const change = { preset: 'demo', name: 'demo', from: '0.0.83', to: '0.0.84' };

  test('moves @pins, @version and the body, nothing else', () => {
    const out = rewriteConf(PRESET, change, 'patch');
    const { meta, body } = parseConfString(out);
    assert.deepEqual(meta.pins, [{ name: 'demo', version: '0.0.84' }]);
    assert.equal(meta.version, '0.2.5');
    assert.deepEqual((body as { command: string[] }).command, ['npx', '-y', 'demo@0.0.84']);
    assert.match(out, /not 10\.0\.83 nor 0\.0\.831/);
  });

  test('keeps a v prefix', () => {
    const src = PRESET.replace('"demo@0.0.83"', '"git+https://x/demo.git#v0.0.83"');
    assert.match(rewriteConf(src, change, 'patch'), /#v0\.0\.84"/);
  });

  test('refuses a header that mentions the version elsewhere', () => {
    const src = PRESET.replace('Adds demo.', 'Adds demo, pinned to 0.0.83.');
    assert.throws(() => rewriteConf(src, change, 'patch'), /mentions 0\.0\.83 — bump by hand/);
  });

  test('refuses a body that never mentions it', () => {
    const src = PRESET.replace('demo@0.0.83', 'demo@latest');
    assert.throws(() => rewriteConf(src, change, 'patch'), /body never mentions/);
  });

  test('refuses @fetch / @archive presets', () => {
    const src = PRESET.replace('// @path:', '// @fetch: https://x/a -> {{cache}}/a-0.2.4 sha256=' + 'a'.repeat(64) + '\n// @path:');
    assert.throws(() => rewriteConf(src, change, 'patch'), /second source/);
  });
});

describe('rewriteReadmeRow', () => {
  const readme = [
    '| `demo` | MCP | replace | pins `demo` 0.0.83 |',
    '| `other` | MCP | replace | pins 0.0.83 too |',
    '// @pins: demo 0.0.83',
  ].join('\n');

  test('changes only the preset row', () => {
    const out = rewriteReadmeRow(readme, ['demo'], '0.0.83', '0.0.84').split('\n');
    assert.equal(out[0], '| `demo` | MCP | replace | pins `demo` 0.0.84 |');
    assert.equal(out[1], '| `other` | MCP | replace | pins 0.0.83 too |');
    assert.equal(out[2], '// @pins: demo 0.0.83');
  });

  test('falls back to the bundle row', () => {
    const out = rewriteReadmeRow(readme, ['part', 'other'], '0.0.83', '0.0.84');
    assert.match(out, /pins 0\.0\.84 too/);
  });

  test('throws without a row', () => {
    assert.throws(() => rewriteReadmeRow(readme, ['nope'], '0.0.83', '0.0.84'), /no README table row/);
  });
});

describe('rewriteExpectedPins', () => {
  test('throws unless the entry is there exactly once', () => {
    const change = { preset: 'demo', name: 'demo', from: '1.0.0', to: '1.0.1' };
    assert.throws(() => rewriteExpectedPins('', change), /found 0/);
  });
});

// The bot applies these rewrites to the shipped presets. A preset whose shape
// breaks them fails here, at PR time, instead of in the Monday run.
test('every auto-bumpable shipped pin survives a dry bump', async () => {
  const dir = resolve(process.cwd(), 'presets');
  const readme = await readFile(resolve(process.cwd(), 'README.md'), 'utf8');
  const pinsTest = await readFile(resolve(process.cwd(), 'test/builtin-presets.test.ts'), 'utf8');
  let checked = 0;
  for (const file of (await readdir(dir)).filter(n => n.endsWith('.conf'))) {
    const text = await readFile(resolve(dir, file), 'utf8');
    const { meta } = await parseConf(resolve(dir, file));
    for (const pin of meta.pins) {
      if (manualReason(pinSourceFor(pin.name))) continue;
      const to = pin.version.replace(/\d+$/, n => String(Number(n) + 1));
      const change = { preset: meta.name, name: pin.name, from: pin.version, to };
      const conf = parseConfString(rewriteConf(text, change, 'patch'));
      assert.deepEqual(conf.meta.pins, [{ name: pin.name, version: to }], meta.name);
      assert.ok(JSON.stringify(conf.body).includes(to), `${meta.name}: body moved`);
      assert.match(rewriteReadmeRow(readme, [meta.name, meta.partOf].filter(Boolean), pin.version, to), new RegExp(to.replace(/\./g, '\\.')));
      rewriteExpectedPins(pinsTest, change);
      checked++;
    }
  }
  assert.ok(checked >= 3, `only ${checked} auto-bumpable pins found`);
});
