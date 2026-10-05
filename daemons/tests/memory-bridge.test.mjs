import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBridge, retain, recall, rank, reflect } from '../memory-bridge.mjs';

test('the opt-in memory bridge exposes the requested operations', () => {
  for (const operation of [loadBridge, retain, recall, rank, reflect]) assert.equal(typeof operation, 'function');
});
