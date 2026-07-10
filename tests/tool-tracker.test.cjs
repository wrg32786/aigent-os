'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyBash,
  formatCapture,
  redact,
} = require('../hooks/tool-tracker.js');

const fixedTime = new Date('2026-07-10T12:34:56Z');

test('redacts common credentials', () => {
  const value = 'Authorization: Bearer abc.def.ghi password=hunter2 ghp_abcdefghijklmnopqrstuvwxyz';
  const output = redact(value);
  assert.equal(output.includes('hunter2'), false);
  assert.equal(output.includes('ghp_abcdefghijklmnopqrstuvwxyz'), false);
  assert.equal(output.includes('abc.def.ghi'), false);
});

test('classifies bash without retaining the command', () => {
  const command = 'curl -H "Authorization: Bearer secret-token" https://example.com';
  const output = formatCapture({ tool_name: 'Bash', tool_input: { command } }, {}, fixedTime);
  assert.match(output, /network command$/);
  assert.equal(output.includes('secret-token'), false);
  assert.equal(output.includes('example.com'), false);
});

test('records only MCP server and action, not query data', () => {
  const output = formatCapture({
    tool_name: 'mcp__gmail__search',
    tool_input: { query: 'password reset for alice@example.com', channel_id: 'private-channel' },
  }, {}, fixedTime);
  assert.match(output, /gmail\/search$/);
  assert.equal(output.includes('alice@example.com'), false);
  assert.equal(output.includes('private-channel'), false);
});

test('unknown tools are not serialized into memory', () => {
  const output = formatCapture({
    tool_name: 'UnknownDangerousTool',
    tool_input: { token: 'sk-super-secret', payload: 'private data' },
  }, {}, fixedTime);
  assert.equal(output, '');
});

test('write events store a relative path only', () => {
  const output = formatCapture({
    tool_name: 'Write',
    tool_input: { file_path: '/workspace/project/docs/readme.md', content: 'secret body' },
  }, { AIGENT_ROOT: '/workspace/project' }, fixedTime);
  assert.match(output, /docs\/readme\.md$/);
  assert.equal(output.includes('secret body'), false);
});

test('bash classifier covers major command classes', () => {
  assert.equal(classifyBash('git status'), 'version-control command');
  assert.equal(classifyBash('npm install'), 'package/build command');
  assert.equal(classifyBash('pytest -q'), 'test command');
  assert.equal(classifyBash('rm -rf build'), 'filesystem command');
});
