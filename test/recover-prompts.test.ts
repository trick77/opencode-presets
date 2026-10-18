import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverPromptValues } from '../src/recover-prompts.js';

const tuple = [['pkg@0.6.0', { url: '{{prompt:url}}', token: '{{prompt:token}}' }]];

test('append: reads answers from the entry the install supersedes', () => {
  const root = { plugin: ['other@1.0.0', ['pkg@0.5.0', { url: 'https://bb', token: 't' }]] };
  assert.deepEqual(recoverPromptValues(root, 'plugin', tuple, 'append'), { url: 'https://bb', token: 't' });
});

test('append: unrelated entries yield nothing', () => {
  const root = { plugin: [['nope@1.0.0', { url: 'https://bb', token: 't' }]] };
  assert.deepEqual(recoverPromptValues(root, 'plugin', tuple, 'append'), {});
});

test('replace: captures around literal text', () => {
  const root = { mcp: { x: { url: 'https://host.example/api/v1', key: 'Bearer abc' } } };
  const tpl = { url: 'https://{{prompt:host}}/api/v1', key: 'Bearer {{prompt:key}}' };
  assert.deepEqual(recoverPromptValues(root, 'mcp.x', tpl, 'replace'), { host: 'host.example', key: 'abc' });
});

test('conflicting values for one prompt yield nothing for it', () => {
  const root = { x: { a: 'one', b: 'two', c: 'k' } };
  const tpl = { a: '{{prompt:v}}', b: '{{prompt:v}}', c: '{{prompt:k}}' };
  assert.deepEqual(recoverPromptValues(root, 'x', tpl, 'merge'), { k: 'k' });
});

test('adjacent placeholders and prompted paths are not guessed', () => {
  assert.deepEqual(recoverPromptValues({ x: 'ab' }, 'x', '{{prompt:a}}{{prompt:b}}', 'replace'), {});
  assert.deepEqual(recoverPromptValues({ x: { y: 1 } }, 'x.{{prompt:n}}', { v: '{{prompt:v}}' }, 'replace'), {});
});

test('missing path yields nothing', () => {
  assert.deepEqual(recoverPromptValues({}, 'plugin', tuple, 'append'), {});
});
