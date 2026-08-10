import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { parseConf } from '../src/parse-conf.js';
import { PIN_SOURCES, pinSourceFor, compareVersions, latestSemverTag, UnknownPinError } from '../src/pin-sources.js';

async function shippedPins(): Promise<{ name: string; version: string; preset: string }[]> {
  const dir = resolve(process.cwd(), 'presets');
  const files = (await readdir(dir)).filter(n => n.endsWith('.conf')).sort();
  const pins = [];
  for (const file of files) {
    const { meta } = await parseConf(resolve(dir, file));
    for (const pin of meta.pins) pins.push({ ...pin, preset: meta.name });
  }
  return pins;
}

describe('pin drift sources', () => {
  // The offline half of the drift check. scripts/check-pins.mjs does the network
  // lookups on a schedule; this fails a PR the moment a new @pins lands without
  // a way to look it up, which is when it is cheap to fix.
  test('every shipped @pins has a registered version source', async () => {
    for (const pin of await shippedPins()) {
      assert.doesNotThrow(
        () => pinSourceFor(pin.name),
        `${pin.preset}: @pins ${pin.name} has no entry in PIN_SOURCES`,
      );
    }
  });

  test('no PIN_SOURCES entry is left over from a pin that is gone', async () => {
    const pinned = new Set((await shippedPins()).map(p => p.name));
    for (const name of Object.keys(PIN_SOURCES)) {
      assert.ok(pinned.has(name), `PIN_SOURCES has "${name}", which no shipped preset pins`);
    }
  });

  test('an unregistered name reports how to fix it', () => {
    assert.throws(
      () => pinSourceFor('not-a-real-pin'),
      (e: unknown) => e instanceof UnknownPinError && /add one to src\/pin-sources\.ts/.test((e as Error).message),
    );
  });

  test('lombok is looked up by git tag, not Maven Central or the download page', () => {
    // Central reported 1.18.38 as latest while 1.18.46 was downloadable; the
    // download page only linked jars to 1.18.44, making the pin look ahead.
    assert.deepEqual(PIN_SOURCES['lombok'], { kind: 'github-tags', repo: 'projectlombok/lombok' });
  });
});

describe('latestSemverTag', () => {
  // GitHub returns tags in no documented order, so "first one" is a coin flip.
  test('picks the newest, not the first', () => {
    assert.equal(latestSemverTag(['v1.18.40', 'v1.18.46', 'v1.18.4', 'v1.18.44']), '1.18.46');
  });

  test('drops tags that are not plain versions', () => {
    assert.equal(latestSemverTag(['v1.18.44', 'edge-2026-01', 'v2.0.0-rc1', 'nightly']), '1.18.44');
  });

  test('returns null when nothing looks like a version', () => {
    assert.equal(latestSemverTag(['edge', 'latest']), null);
    assert.equal(latestSemverTag([]), null);
  });
});

describe('compareVersions', () => {
  test('orders by numeric segment, not lexically', () => {
    assert.ok(compareVersions('0.0.9', '0.0.10') < 0);
    assert.ok(compareVersions('1.18.46', '1.18.38') > 0);
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  });

  test('treats a missing segment as zero', () => {
    assert.equal(compareVersions('1.2', '1.2.0'), 0);
    assert.ok(compareVersions('1.2.1', '1.2') > 0);
  });

  test('sorts a list newest-last', () => {
    const sorted = ['1.18.4', '1.18.46', '1.18.38', '1.18.9'].sort(compareVersions);
    assert.equal(sorted.at(-1), '1.18.46');
  });
});
