import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfString } from '../src/parse-conf.js';

const minimalHeader = `// @name: foo
// @description: a thing
// @author: someone
// @version: 0.1.0
// @path: a.b.c
`;

describe('parseConfString — required headers', () => {
  test('parses a minimal valid module', () => {
    const { meta, body } = parseConfString(minimalHeader + '\n{ "x": 1 }');
    assert.equal(meta.name, 'foo');
    assert.equal(meta.description, 'a thing');
    assert.equal(meta.author, 'someone');
    assert.equal(meta.version, '0.1.0');
    assert.equal(meta.path, 'a.b.c');
    assert.equal(meta.target, 'config');
    assert.equal(meta.mode, 'replace');
    assert.deepEqual(meta.fetch, []);
    assert.deepEqual(meta.prompts, []);
    assert.deepEqual(meta.pins, []);
    assert.deepEqual(body, { x: 1 });
  });

  for (const k of ['name', 'description', 'author', 'version', 'path']) {
    test(`throws when @${k} is missing`, () => {
      const broken = minimalHeader.replace(new RegExp(`// @${k}:.*\n`), '') + '\n{}';
      assert.throws(() => parseConfString(broken), new RegExp(`missing required header @${k}`));
    });
  }
});

describe('parseConfString — @target', () => {
  test('accepts config and tui targets', () => {
    for (const target of ['config', 'tui']) {
      const src = minimalHeader + `// @target: ${target}\n\n{ "x": 1 }`;
      const { meta } = parseConfString(src);
      assert.equal(meta.target, target);
    }
  });

  test('rejects unknown target', () => {
    const src = minimalHeader + '// @target: bogus\n\n{}';
    assert.throws(() => parseConfString(src), /@target must be/);
  });
});

describe('parseConfString — multi-line description', () => {
  test('concatenates continuation lines with single spaces', () => {
    const src = `// @name: foo
// @description: line one
//   line two
//   line three
// @author: a
// @version: 0.1.0
// @path: x

{ "x": 1 }`;
    const { meta } = parseConfString(src);
    assert.equal(meta.description, 'line one line two line three');
  });
});

describe('parseConfString — @include', () => {
  const bundleHeader = `// @name: pack
// @description: a bundle
// @author: someone
// @version: 0.1.0
`;

  test('accumulates repeated @include lines', () => {
    const src = bundleHeader + '// @include: a\n// @include: b\n';
    const { meta, body } = parseConfString(src);
    assert.deepEqual(meta.includes, ['a', 'b']);
    assert.equal(body, null);
  });

  test('a bundle needs no @path', () => {
    const src = bundleHeader + '// @include: a\n';
    assert.equal(parseConfString(src).meta.path, '');
  });

  test('a plain module has no includes', () => {
    assert.deepEqual(parseConfString(minimalHeader + '\n{}').meta.includes, []);
  });

  // Both guards keep a bundle from ever carrying an appliable payload: with an
  // empty @path, applyAtPath would treat the whole config as the leaf.
  test('rejects a bundle that also sets @path', () => {
    const src = bundleHeader + '// @path: a.b.c\n// @include: a\n';
    assert.throws(() => parseConfString(src), /must not set @path/);
  });

  test('rejects a bundle that also has a body', () => {
    const src = bundleHeader + '// @include: a\n\n{ "x": "allow" }';
    assert.throws(() => parseConfString(src), /must not have a body/);
  });

  // These would be dropped on the floor: a bundle never reaches an applier.
  test('rejects a bundle that sets @fetch, @prompt, @pins or @requires-bin', () => {
    const cases: [string, RegExp][] = [
      ['// @fetch: https://x/y.jar -> {{cache}}/y.jar\n', /must not set @fetch/],
      ['// @prompt: url | text | where\n', /must not set @prompt/],
      ['// @pins: lombok 1.18.46\n', /must not set @pins/],
      ['// @requires-bin: dcg\n', /must not set @requires-bin/],
    ];
    for (const [directive, re] of cases) {
      assert.throws(() => parseConfString(bundleHeader + directive + '// @include: a\n'), re);
    }
  });

  test('rejects an empty @include', () => {
    assert.throws(() => parseConfString(bundleHeader + '// @include:\n'), /needs a preset name or path/);
  });

  test('still requires the other headers', () => {
    const src = '// @name: pack\n// @author: someone\n// @version: 0.1.0\n// @include: a\n';
    assert.throws(() => parseConfString(src), /missing required header @description/);
  });
});

describe('parseConfString — @pins', () => {
  test('parses a scoped package name and version', () => {
    const src = minimalHeader + '// @pins: @playwright/mcp 0.0.78\n\n{}';
    const { meta } = parseConfString(src);
    assert.deepEqual(meta.pins, [{ name: '@playwright/mcp', version: '0.0.78' }]);
  });

  test('accumulates repeated @pins lines', () => {
    const src = minimalHeader + '// @pins: lombok 1.18.46\n// @pins: superpowers 6.2.0\n\n{}';
    const { meta } = parseConfString(src);
    assert.deepEqual(meta.pins, [
      { name: 'lombok', version: '1.18.46' },
      { name: 'superpowers', version: '6.2.0' },
    ]);
  });

  test('rejects a name without a version', () => {
    const src = minimalHeader + '// @pins: lombok\n\n{}';
    assert.throws(() => parseConfString(src), /@pins must be "name version"/);
  });

  test('rejects more than two fields', () => {
    const src = minimalHeader + '// @pins: lombok 1.18.46 extra\n\n{}';
    assert.throws(() => parseConfString(src), /@pins must be "name version"/);
  });
});

describe('parseConfString — @mode', () => {
  test('accepts replace, merge, merge-overwrite, append', () => {
    for (const mode of ['replace', 'merge', 'merge-overwrite', 'append']) {
      const body = mode === 'append' ? '[]' : '{}';
      const src = minimalHeader + `// @mode: ${mode}\n\n${body}`;
      const { meta } = parseConfString(src);
      assert.equal(meta.mode, mode);
    }
  });

  test('rejects unknown mode', () => {
    const src = minimalHeader + '// @mode: bogus\n\n{}';
    assert.throws(() => parseConfString(src), /@mode must be/);
  });

  test('merge mode requires object body', () => {
    const src = minimalHeader + '// @mode: merge\n\n[1,2,3]';
    assert.throws(() => parseConfString(src), /requires the body to be a JSON object/);
  });

  test('append mode requires array body', () => {
    const src = minimalHeader + '// @mode: append\n\n{}';
    assert.throws(() => parseConfString(src), /requires the body to be a JSON array/);
  });

  test('replace mode accepts array, scalar, object', () => {
    for (const body of ['[1,2,3]', 'false', '"hello"', '{"x": 1}']) {
      const src = minimalHeader + '\n' + body;
      assert.doesNotThrow(() => parseConfString(src));
    }
  });
});

describe('parseConfString — @fetch', () => {
  test('parses url and dest', () => {
    const src = minimalHeader + '// @fetch: https://example.com/x.jar -> /tmp/x.jar\n\n{}';
    const { meta } = parseConfString(src);
    assert.deepEqual(meta.fetch, [{ url: 'https://example.com/x.jar', dest: '/tmp/x.jar', sha256: null }]);
  });

  test('parses inline sha256', () => {
    const src = minimalHeader + '// @fetch: https://example.com/x.jar -> /tmp/x.jar sha256=ABC123\n\n{}';
    const { meta } = parseConfString(src);
    assert.equal(meta.fetch[0].sha256, 'abc123');
  });

  test('multiple @fetch lines accumulate', () => {
    const src = minimalHeader +
      '// @fetch: https://a.com/1 -> /tmp/1\n' +
      '// @fetch: https://b.com/2 -> /tmp/2\n\n{}';
    const { meta } = parseConfString(src);
    assert.equal(meta.fetch.length, 2);
    assert.equal(meta.fetch[0].url, 'https://a.com/1');
    assert.equal(meta.fetch[1].url, 'https://b.com/2');
  });

  test('rejects @fetch without arrow', () => {
    const src = minimalHeader + '// @fetch: https://example.com/x.jar\n\n{}';
    assert.throws(() => parseConfString(src), /@fetch must be/);
  });
});

describe('parseConfString — @prompt', () => {
  test('parses name | type | help', () => {
    const src = minimalHeader + '// @prompt: token | secret | bearer auth\n\n{}';
    const { meta } = parseConfString(src);
    assert.deepEqual(meta.prompts, [{ name: 'token', type: 'secret', help: 'bearer auth' }]);
  });

  test('parses without help (optional)', () => {
    const src = minimalHeader + '// @prompt: name | text\n\n{}';
    const { meta } = parseConfString(src);
    assert.deepEqual(meta.prompts[0], { name: 'name', type: 'text', help: '' });
  });

  test('rejects bad name', () => {
    const src = minimalHeader + '// @prompt: 1bad | text\n\n{}';
    assert.throws(() => parseConfString(src), /alphanumeric/);
  });

  test('rejects bad type', () => {
    const src = minimalHeader + '// @prompt: x | bogus\n\n{}';
    assert.throws(() => parseConfString(src), /type must be/);
  });

  test('parses name | type | help | default', () => {
    const src = minimalHeader + '// @prompt: port | text | server port | 64342\n\n{}';
    const { meta } = parseConfString(src);
    assert.deepEqual(meta.prompts[0], { name: 'port', type: 'text', help: 'server port', default: '64342' });
  });

  test('parses default with empty help', () => {
    const src = minimalHeader + '// @prompt: port | text |  | 64342\n\n{}';
    const { meta } = parseConfString(src);
    assert.deepEqual(meta.prompts[0], { name: 'port', type: 'text', help: '', default: '64342' });
  });

  test('rejects default on secret', () => {
    const src = minimalHeader + '// @prompt: token | secret | bearer | hunter2\n\n{}';
    assert.throws(() => parseConfString(src), /not allowed for type "secret"/);
  });

  test('rejects more than 5 fields', () => {
    const src = minimalHeader + '// @prompt: a | text | b | c | d | e\n\n{}';
    assert.throws(() => parseConfString(src), /@prompt must be/);
  });

  test('parses a setup hint as the fifth field', () => {
    const src = minimalHeader + '// @prompt: clone | dir | where | /opt/x | git clone https://example.com/r\n\n{}';
    const { meta } = parseConfString(src);
    assert.deepEqual(meta.prompts[0], {
      name: 'clone', type: 'dir', help: 'where',
      default: '/opt/x', setup: 'git clone https://example.com/r',
    });
  });

  // The common shape: something to clone, and no sensible default to clone it
  // to. The default field has to be skippable or the hint cannot be reached.
  test('an empty default field means no default, not an empty one', () => {
    const src = minimalHeader + '// @prompt: clone | dir | where | | git clone https://example.com/r\n\n{}';
    const { meta } = parseConfString(src);
    assert.equal(meta.prompts[0].default, undefined);
    assert.equal(meta.prompts[0].setup, 'git clone https://example.com/r');
  });

  test('a real default on secret is still rejected with a setup hint after it', () => {
    const src = minimalHeader + '// @prompt: token | secret | bearer | hunter2 | go get one\n\n{}';
    assert.throws(() => parseConfString(src), /not allowed for type "secret"/);
  });

  test('an empty default field on secret is not a default, so it passes', () => {
    const src = minimalHeader + '// @prompt: token | secret | bearer | | go get one\n\n{}';
    const { meta } = parseConfString(src);
    assert.equal(meta.prompts[0].default, undefined);
  });

  test('no setup hint leaves the field unset', () => {
    const src = minimalHeader + '// @prompt: clone | dir | where\n\n{}';
    const { meta } = parseConfString(src);
    assert.equal(meta.prompts[0].setup, undefined);
  });

  test('parses the dir type', () => {
    const src = minimalHeader + '// @prompt: clone | dir | where you cloned it\n\n{}';
    const { meta } = parseConfString(src);
    assert.deepEqual(meta.prompts[0], { name: 'clone', type: 'dir', help: 'where you cloned it' });
  });

  test('allows a default on dir', () => {
    const src = minimalHeader + '// @prompt: clone | dir | where | /opt/x\n\n{}';
    const { meta } = parseConfString(src);
    assert.deepEqual(meta.prompts[0], { name: 'clone', type: 'dir', help: 'where', default: '/opt/x' });
  });
});

describe('parseConfString — @requires-bin', () => {
  test('parses a binary name', () => {
    const src = minimalHeader + '// @requires-bin: dcg\n\n{}';
    const { meta } = parseConfString(src);
    assert.deepEqual(meta.requiresBin, [{ bin: 'dcg' }]);
  });

  test('is repeatable', () => {
    const src = minimalHeader + '// @requires-bin: dcg\n// @requires-bin: jq\n\n{}';
    const { meta } = parseConfString(src);
    assert.deepEqual(meta.requiresBin, [{ bin: 'dcg' }, { bin: 'jq' }]);
  });

  test('defaults to empty', () => {
    const { meta } = parseConfString(minimalHeader + '\n{}');
    assert.deepEqual(meta.requiresBin, []);
  });

  // A path would make the check pass on the author's machine and fail on
  // everyone else's; the whole point is a name resolved against PATH.
  test('rejects a path rather than a name', () => {
    for (const bad of ['/usr/local/bin/dcg', './dcg', 'bin/dcg']) {
      assert.throws(
        () => parseConfString(minimalHeader + `// @requires-bin: ${bad}\n\n{}`),
        /must be an executable name on PATH/,
        bad,
      );
    }
  });

  test('rejects an empty value', () => {
    assert.throws(
      () => parseConfString(minimalHeader + '// @requires-bin:\n\n{}'),
      /needs an executable name/,
    );
  });
});

describe('parseConfString — body and unknowns', () => {
  test('rejects unknown @key', () => {
    const src = minimalHeader + '// @bogus: foo\n\n{}';
    assert.throws(() => parseConfString(src), /unknown header key @bogus/);
  });

  test('rejects empty body', () => {
    const src = minimalHeader + '\n';
    assert.throws(() => parseConfString(src), /no body/);
  });

  test('rejects non-JSON body', () => {
    const src = minimalHeader + '\nthis is not json';
    assert.throws(() => parseConfString(src), /not valid JSON/);
  });

  test('accepts JSONC body with comments', () => {
    const src = minimalHeader + '\n{ /* a comment */ "x": 1 // line\n}';
    const { body } = parseConfString(src);
    assert.deepEqual(body, { x: 1 });
  });

  test('does not expand {{cache}} placeholders (parser only)', () => {
    const src = minimalHeader + '\n{ "p": "{{cache}}/x" }';
    const { body } = parseConfString(src);
    assert.deepEqual(body, { p: '{{cache}}/x' });
  });
});
