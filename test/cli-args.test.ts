import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstallArgs, validateInstallPolicy, CliArgsError } from '../src/cli-args.js';

describe('parseInstallArgs — existing behavior', () => {
  test('plain conf paths', () => {
    const r = parseInstallArgs(['foo', 'bar.conf', './baz/qux.conf']);
    assert.deepEqual(r.resets, []);
    assert.deepEqual(r.setValues, []);
    assert.deepEqual(r.confPaths, ['foo', 'bar.conf', './baz/qux.conf']);
  });

  test('--reset two-arg form', () => {
    const r = parseInstallArgs(['--reset', 'mcp.foo', 'bar']);
    assert.deepEqual(r.resets, ['mcp.foo']);
    assert.deepEqual(r.confPaths, ['bar']);
  });

  test('--reset=path form', () => {
    const r = parseInstallArgs(['--reset=mcp.foo', 'bar']);
    assert.deepEqual(r.resets, ['mcp.foo']);
  });

  test('--reset without value throws', () => {
    assert.throws(() => parseInstallArgs(['--reset']), CliArgsError);
  });
});

describe('parseInstallArgs — --set', () => {
  test('plain NAME=VALUE', () => {
    const r = parseInstallArgs(['mcp-http', '--set', 'name=openrag']);
    assert.deepEqual(r.confPaths, ['mcp-http']);
    assert.deepEqual(r.setValues, [{ scope: undefined, name: 'name', value: 'openrag' }]);
  });

  test('--set=NAME=VALUE attached form', () => {
    const r = parseInstallArgs(['--set=url=https://x/y']);
    assert.deepEqual(r.setValues, [{ scope: undefined, name: 'url', value: 'https://x/y' }]);
  });

  test('value containing = is preserved verbatim', () => {
    const r = parseInstallArgs(['--set', 'headerValue=token=with=equals']);
    assert.equal(r.setValues[0].value, 'token=with=equals');
  });

  test('scoped <preset>.<name>=value', () => {
    const r = parseInstallArgs(['--set', 'mcp-http.name=openrag']);
    assert.deepEqual(r.setValues, [{ scope: 'mcp-http', name: 'name', value: 'openrag' }]);
  });

  test('--set without value throws', () => {
    assert.throws(() => parseInstallArgs(['--set']), CliArgsError);
  });

  test('--set with no = throws', () => {
    assert.throws(() => parseInstallArgs(['--set', 'foo']), CliArgsError);
  });

  test('--set with empty name throws', () => {
    assert.throws(() => parseInstallArgs(['--set', '=value']), CliArgsError);
  });

  test('--set with invalid name throws', () => {
    assert.throws(() => parseInstallArgs(['--set', '1bad=value']), CliArgsError);
  });

  test('empty value is allowed', () => {
    const r = parseInstallArgs(['--set', 'name=']);
    assert.equal(r.setValues[0].value, '');
  });

  test('multiple --set accumulate', () => {
    const r = parseInstallArgs([
      'mcp-http',
      '--set', 'name=openrag',
      '--set', 'url=https://x',
      '--set=headerName=X-Bitbucket-Token',
    ]);
    assert.equal(r.setValues.length, 3);
    assert.deepEqual(r.setValues.map(s => s.name), ['name', 'url', 'headerName']);
  });
});

describe('parseInstallArgs — --set-env', () => {
  test('reads from process.env', () => {
    process.env.OPENCODE_TEST_TOKEN = 'sekret';
    try {
      const r = parseInstallArgs(['--set-env', 'headerValue=OPENCODE_TEST_TOKEN']);
      assert.deepEqual(r.setValues, [{ scope: undefined, name: 'headerValue', value: 'sekret' }]);
    } finally {
      delete process.env.OPENCODE_TEST_TOKEN;
    }
  });

  test('unset env var throws', () => {
    delete process.env.OPENCODE_DEFINITELY_NOT_SET;
    assert.throws(
      () => parseInstallArgs(['--set-env', 'x=OPENCODE_DEFINITELY_NOT_SET']),
      CliArgsError,
    );
  });

  test('invalid env var name throws', () => {
    assert.throws(() => parseInstallArgs(['--set-env', 'x=not a var']), CliArgsError);
  });

  test('--set-env=NAME=VAR attached form', () => {
    process.env.OPENCODE_TEST_TOKEN2 = 'v';
    try {
      const r = parseInstallArgs(['--set-env=headerValue=OPENCODE_TEST_TOKEN2']);
      assert.equal(r.setValues[0].value, 'v');
    } finally {
      delete process.env.OPENCODE_TEST_TOKEN2;
    }
  });

  test('empty env var value throws', () => {
    process.env.OPENCODE_TEST_EMPTY = '';
    try {
      assert.throws(
        () => parseInstallArgs(['--set-env', 'x=OPENCODE_TEST_EMPTY']),
        /is empty/,
      );
    } finally {
      delete process.env.OPENCODE_TEST_EMPTY;
    }
  });
});

describe('parseInstallArgs — mixed', () => {
  test('resets, sets, and confs interleaved', () => {
    const r = parseInstallArgs([
      '--reset', 'mcp.foo',
      'mcp-http',
      '--set', 'name=openrag',
      'permissions-git-safe',
      '--set=url=https://x',
    ]);
    assert.deepEqual(r.resets, ['mcp.foo']);
    assert.deepEqual(r.confPaths, ['mcp-http', 'permissions-git-safe']);
    assert.equal(r.setValues.length, 2);
  });
});

describe('validateInstallPolicy', () => {
  test('null when no --set is used (any number of presets)', () => {
    assert.equal(validateInstallPolicy(parseInstallArgs(['a', 'b', 'c'])), null);
    assert.equal(validateInstallPolicy(parseInstallArgs([])), null);
  });

  test('null when --set targets exactly one preset', () => {
    const r = parseInstallArgs(['mcp-http', '--set', 'name=x']);
    assert.equal(validateInstallPolicy(r), null);
  });

  test('null when --set + one preset + --reset', () => {
    const r = parseInstallArgs(['--reset', 'mcp.foo', 'mcp-http', '--set', 'name=x']);
    assert.equal(validateInstallPolicy(r), null);
  });

  test('errors when --set is used with multiple presets', () => {
    const r = parseInstallArgs(['mcp-http', 'mcp-http-noauth', '--set', 'name=x']);
    const err = validateInstallPolicy(r);
    assert.ok(err, 'expected an error');
    assert.match(err!, /exactly one preset/);
  });

  test('errors when --set is used with no presets', () => {
    const r = parseInstallArgs(['--set', 'name=x']);
    const err = validateInstallPolicy(r);
    assert.ok(err, 'expected an error');
    assert.match(err!, /requires a preset/);
  });
});
