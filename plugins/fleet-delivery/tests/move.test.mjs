// Runs the MOVE one-liner for real (the hooks test sandbox cannot spawn
// processes): node --test plugins/fleet-delivery/tests/move.test.mjs
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// register.ts is TypeScript and CI's node may not strip types, so the one-liner
// is read from its source: the exported MOVE literal, as the mod runs it.
const source = readFileSync(new URL('../hooks/register.ts', import.meta.url), 'utf8')
const MOVE = /export const MOVE =\s*'([^'\r\n]*)'/.exec(source)?.[1]
assert.ok(MOVE, 'MOVE literal not found in register.ts')
const argvFor = (from, to) => ['-e', MOVE, '--', from, to]
const run = (from, to) => spawnSync('node', argvFor(from, to), { encoding: 'utf8' })
const runAsync = (from, to) =>
  new Promise(done => {
    let stderr = ''
    const child = spawn('node', argvFor(from, to))
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('close', status => done({ status, stderr }))
  })

test('MOVE against real files: moves, refuses to overwrite, reports a missing source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-delivery-move-'))
  try {
    const src = join(dir, 'inbox', 'a.json')
    const dst = join(dir, 'claimed', 'a.json')
    mkdirSync(join(dir, 'inbox'))
    // Success: the destination folder is created.
    writeFileSync(src, 'one')
    const moved = run(src, dst)
    assert.deepEqual([moved.status, existsSync(src), readFileSync(dst, 'utf8')], [0, false, 'one'])
    // EEXIST: both files stay as they were.
    writeFileSync(src, 'two')
    const blocked = run(src, dst)
    assert.deepEqual([blocked.status, blocked.stderr, readFileSync(src, 'utf8'), readFileSync(dst, 'utf8')], [1, 'EEXIST', 'two', 'one'])
    // ENOENT: a missing source.
    const missing = run(join(dir, 'inbox', 'nope.json'), join(dir, 'claimed', 'nope.json'))
    assert.deepEqual([missing.status, missing.stderr], [1, 'ENOENT'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MOVE with two movers racing for one source: exactly one wins and the file ends in exactly one place', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-delivery-race-'))
  try {
    for (let round = 0; round < 8; round++) {
      const src = join(dir, `src-${round}.json`)
      const claimed = join(dir, 'claimed', `m-${round}.json`)
      const processed = join(dir, 'processed', `m-${round}.json`)
      writeFileSync(src, 'the message')
      // The claim and room_drain's own move race for the same inbox file.
      const results = await Promise.all([runAsync(src, claimed), runAsync(src, processed)])
      const wins = results.filter(result => result.status === 0)
      const losses = results.filter(result => result.status !== 0)
      assert.equal(wins.length, 1, `round ${round}: one winner`)
      assert.equal(losses.length, 1)
      // The loser exits non-zero; the exact code is the platform's.
      assert.notEqual(losses[0].status, 0)
      // Two names would be a double delivery: the message is in exactly one place and the source is gone.
      assert.equal(existsSync(src), false)
      assert.equal([claimed, processed].filter(path => existsSync(path)).length, 1, `round ${round}: one destination`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
