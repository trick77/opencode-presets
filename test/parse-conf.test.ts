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
    assert.equal(meta.mode, 'replace');
    assert.deepEqual(meta.fetch, []);
    assert.deepEqual(meta.prompts, []);
    assert.deepEqual(body, { x: 1 });
  });

  for (const k of ['name', 'description', 'author', 'version', 'path']) {
    test(`throws when @${k} is missing`, () => {
      const broken = minimalHeader.replace(new RegExp(`// @${k}:.*\n`), '') + '\n{}';
      assert.throws(() => parseConfString(broken), new RegExp(`missing required header @${k}`));
    });
  }
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

  test('rejects more than 4 fields', () => {
    const src = minimalHeader + '// @prompt: a | text | b | c | d\n\n{}';
    assert.throws(() => parseConfString(src), /@prompt must be/);
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
