import './direct-hooks.mts'
// Drives the real register.ts tick against temp directories with a fake engine.
// node --test plugins/fleet-delivery/tests/supervisor-hold.test.mjs  (needs a node that strips types)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { stripTypeScriptTypes } from 'node:module'

const { logLine, UNLINK, MOVE, WRITE, OWNER_PID, PID_DEAD, safeName } = await import('../hooks/register.ts')

const SEAT = 'testseat'
const LEG = '[refresh-cycle] Run the fleet resume lifecycle verb now. Load the newest valid capsule.\nROOM-LIFECYCLE resume-done 20260101-0000-aaaaaaaa'
const CAPSULE_REQUEST = '[refresh-cycle] Run the fleet capsule lifecycle verb now, the full contract in order. Only after the sync verifies, send yourself the locked line.\nROOM-LIFECYCLE capsule-done <capsule-id>'
const CAPSULE_NUDGE = '[refresh-cycle] The capsule announcement is missing after the seat stalled. Finish the fleet capsule lifecycle verb once.'
const sleep = ms => new Promise(done => setTimeout(done, ms))
const ls = dir => (existsSync(dir) ? readdirSync(dir) : [])
const ticketName = (base, ticket) => `${base.startsWith('job-') ? base.slice(0, -5) : base}.${ticket.attempt}.json`
const ticketMatches = (path, base) => path.replaceAll('\\', '/').split('/').at(-1).startsWith(`${base.startsWith('job-') ? base.slice(0, -5) : base}.`) && path.endsWith('.json')

let moduleId = 0
async function rig({ cycle = 'idle', noRoom = false, noPid = false, entries = [], jobs = [], submitTimeoutMinutes, inspect = false, seat = SEAT } = {}) {
  const module = inspect ? await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(
    readFileSync(new URL('../hooks/register.ts', import.meta.url), 'utf8') + `
export const inspection = { tick, pointerHold, findPointers, pointerChecks, mutex: typeof promiseMutex === 'function' ? promiseMutex : undefined, serialMarker, serialized, resetTurnState, resumeTick: () => { isTicking = false }, waitForSubmit, mainTurns, turnEndWaiters, admissionTurns, promptAdmissions, tickOwned,
  runtime: () => ({ timeout: config.submitTimeoutMs, timer, isTicking, promptSeq,
    admissions: [...promptAdmissions], owned: [...tickOwned] }),
  token: e => promptTokens.get(e), suppressTick: () => { isTicking = true },
  claim: ($, w, item) => moveRoom($, w, item, [inboxFile, claimedFile], undefined, false, 'quiet', false)
};
// rig ${++moduleId}`)).toString('base64')) : await import(`../hooks/register.ts?rig=${++moduleId}`)
  const { register } = module
  const base = mkdtempSync(join(tmpdir(), 'fd-hold-'))
  const root = join(base, 'install')
  const room = join(base, 'room')
  const memory = join(root, 'memory')
  const admit = join(room, 'state', 'admit', SEAT)
  const holdPath = join(room, 'state', 'holds', `${SEAT}.json`)
  for (const dir of [join(root, '.aigent'), join(memory, 'runtime'), join(room, 'inbox', SEAT), join(room, 'state', 'holds')]) mkdirSync(dir, { recursive: true })
  if (jobs.length) {
    mkdirSync(join(root, 'daemons'))
    writeFileSync(join(root, 'daemons', 'job-results.mjs'), '')
  }
  writeFileSync(join(root, '.aigent', 'delivery-owner.json'), JSON.stringify({ owner: { [SEAT]: 'mod' } }))
  writeFileSync(join(memory, 'runtime', 'auto-clear-cycle.json'), JSON.stringify({ state: cycle }))
  writeFileSync(join(memory, 'runtime', `mod-delivery-ledger.${SEAT}.jsonl`), `${logLine({ id: 'seed', source: 'seed', at: '', status: 'seed' })}\n`)
  const logPath = join(memory, 'runtime', `mod-delivery-ledger.${SEAT}.jsonl`)
  writeFileSync(logPath, readFileSync(logPath, 'utf8') + entries.map(e => `${logLine(e)}\n`).join(''))
  const state = new Map()
  const submitted = []
  // One-shot hooks: preparation, the final hold's existence/read await, and submit.
  const hooks = {}
  const fire = async name => { const f = hooks[name]; delete hooks[name]; if (f) await f() }
  const statuses = []
  const holdSamples = []
  const tickets = () => ls(admit)
  const ticketFile = file => {
    const matches = tickets().filter(name => ticketMatches(name, file))
    assert.equal(matches.length, 1, `one attempt for ${file}`)
    return matches[0]
  }
  let holdLookups = 0
  const runs = []
  const order = []
  const writes = []
  const logs = []
  let now = Date.parse('2026-10-24T12:00:00Z')
  const $ = {
    clock: {
      now: async () => now,
      after: (ms, fn) => { if (hooks.timeout && ms !== 60 * 60_000) { delete hooks.timeout; queueMicrotask(fn) } return { cancel() {} } },
      every: () => ({ cancel() {} }),
    },
    env: { get: async () => undefined },
    session: { root: async () => root },
    fs: {
      exists: async p => {
        if (hooks.ticketExistsThrows && p.endsWith('.json') && p.replaceAll('\\', '/').includes('/state/admit/')) throw new Error('EIO')
        const present = existsSync(p)
        if (p.replaceAll('\\', '/') === holdPath.replaceAll('\\', '/') && ++holdLookups === 2) {
          holdSamples.push({ kind: 'exists', present, tickets: tickets() })
          await fire('finalLookup')
        }
        return present
      },
      read: async p => {
        if (hooks.ticketUnreadable && p.replaceAll('\\', '/').includes('/state/admit/')) throw new Error('EACCES')
        if (p.replaceAll('\\', '/').includes('/state/admit/')) await fire('ticketRead')
        if (p.replaceAll('\\', '/') === holdPath.replaceAll('\\', '/') && holdLookups === 2) {
          holdSamples.push({ kind: 'read', tickets: tickets() })
          await fire('finalRead')
        }
        return readFileSync(p, 'utf8')
      },
      write: async (p, t) => { writes.push(p); if (p.includes('mod-delivery-ledger') && t.includes('"status":"submitting"')) await fire('write'); writeFileSync(p, t) },
      stat: async p => { const s = statSync(p); return { size: s.size, mtimeMs: s.mtimeMs, kind: s.isDirectory() ? 'dir' : 'file', isLink: false } },
      list: async d => readdirSync(d, { withFileTypes: true }).map(e => ({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file' })),
    },
    process: {
      run: async argv => {
        runs.push(argv)
        order.push({ kind: 'run', argv })
        if (argv[2] === WRITE && hooks.writeHost) {
          const answer = await hooks.writeHost(argv)
          if (answer) return answer
        }
        if (argv[1]?.endsWith('/daemons/job-results.mjs')) return { exitCode: 0, stdout: JSON.stringify(jobs), stderr: '' }
        if (argv[2] === OWNER_PID && hooks.ownerProbe) return hooks.ownerProbe()
        if (argv[2] === OWNER_PID && noPid) return { exitCode: 1, stdout: '', stderr: 'unavailable' }
        if (argv[2] === PID_DEAD && hooks.pidProbe) return hooks.pidProbe(argv.at(-1))
        if (argv.some(a => /inbox/.test(a))) await fire('run')
        if (argv[2] === UNLINK) await fire('beforeUnlink')
        if (argv[2] === UNLINK && hooks.failUnlink) {
          delete hooks.failUnlink
          return { exitCode: 1, stdout: '', stderr: 'EPERM' }
        }
        const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' })
        if (r.status === 0 && argv[2] === WRITE && argv[4].endsWith('.json')) await fire('published')
        if (r.status === 0 && argv.at(-1).replaceAll('\\', '/') === logPath.replaceAll('\\', '/')) {
          order.push({ kind: 'ledger', entry: JSON.parse(readFileSync(logPath, 'utf8').trim().split('\n').at(-1).replace(/^\d+ /, '')) })
        }
        return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr }
      },
    },
    state: {
      get: async key => state.get(key.key) ?? { value: undefined, version: 0 },
      set: async (key, value, opt) => {
        const held = state.get(key.key) ?? { value: undefined, version: 0 }
        if (opt?.ifVersion !== undefined && opt.ifVersion !== held.version) return { isSet: false }
        state.set(key.key, { value, version: held.version + 1 })
        if (hooks.stateSet) await hooks.stateSet(key, value)
        return { isSet: true }
      },
    },
    store: { get: async () => undefined, delete: async () => {} },
    prompt: {
      read: async () => { await fire('read'); return { text: '' } },
      submit: async ({ text }) => {
        await fire('submit')
        if (hooks.reject) { delete hooks.reject; throw new Error('transient') }
        submitted.push(text)
        if (hooks.pending) { const pending = hooks.pending; delete hooks.pending; return pending }
        return {}
      },
    },
    ui: { status: s => statuses.push(s), log: s => logs.push(s) },
    command: { register: async () => {} },
  }
  const handlers = {}
  const catches = {}
  const install = register => register((name, ...rest) => {
    handlers[name] = rest.at(-1)
    return { catch(handler) { catches[name] = handler } }
  }, { installRoot: root, roomRoot: noRoom ? undefined : room, seat, submitTimeoutMinutes, ...(jobs.length ? { jobSeat: SEAT } : {}) })
  install(register)
  const tick = async () => {
    holdLookups = 0
    const before = statuses.length
    await handlers['turn.complete']($, { agentId: undefined }, async () => {})
    // The tick runs detached: wait for its first status, then for quiet.
    for (let i = 0; i < 300 && statuses.length === before; i++) await sleep(100)
    for (let seen = -1; seen !== statuses.length + submitted.length; ) {
      seen = statuses.length + submitted.length
      await sleep(700)
    }
  }
  const drop = (name, from, body, priority) =>
    writeFileSync(join(room, 'inbox', SEAT, `${name}.json`), JSON.stringify({ from, to: SEAT, ts: '2026-10-24T11:59:00Z', parts: [{ text: body }], ...(priority ? { priority } : {}) }))
  // `phase` is the newer supervisor's optional label; omitted, the file has the older shape.
  const freeze = (ts, phase) => writeFileSync(join(room, 'state', 'holds', `${SEAT}.json`), JSON.stringify({ version: 1, seat: SEAT, ts: new Date(ts ?? now).toISOString(), ...(phase ? { phase } : {}) }))
  const thaw = () => rmSync(join(room, 'state', 'holds', `${SEAT}.json`), { force: true })
  const ledger = () =>
    Object.fromEntries(
      readFileSync(join(memory, 'runtime', `mod-delivery-ledger.${SEAT}.jsonl`), 'utf8')
        .split('\n').filter(Boolean).map(l => JSON.parse(l.replace(/^\d+ /, ''))).filter(l => l.id.startsWith('room:')).map(l => [l.id, l.status]),
    )
  return {
    submitted, statuses, hooks, tick, drop, freeze, thaw, ledger, admit, tickets, ticketFile, clock: $.clock,
    inspection: module.inspection, engine: $, handlers, catches, where: { root, memory, seat: SEAT },
    recoverPid: () => { noPid = false },
    reconcile: args => handlers['command.run']($, { args }), holdSamples, runs, order, writes, logs,
    reload: async () => install((await import(`../hooks/register.ts?rig=${++moduleId}`)).register),
    held: id => state.get('ledger')?.value?.[SEAT]?.[id],
    supersede: () => {
      const held = state.get('generation')
      state.set('generation', { value: held.value + 1, version: held.version + 1 })
    },
    ticket: file => JSON.parse(readFileSync(join(admit, ticketFile(file)), 'utf8')),
    advance: ms => { now += ms },
    logText: () => readFileSync(join(memory, 'runtime', `mod-delivery-ledger.${SEAT}.jsonl`), 'utf8'),
    inbox: () => ls(join(room, 'inbox', SEAT)),
    claimed: () => ls(join(room, 'claimed', SEAT)),
    processed: () => ls(join(room, 'processed', SEAT)),
    last: () => statuses.at(-1),
    done: () => rmSync(base, { recursive: true, force: true }),
  }
}

test('(a) frozen seat: an ordinary message is deferred, not acked, still queued', async () => {
  const r = await rig()
  try {
    r.freeze()
    r.drop('2026-10-24T11-59-00-aaaa', 'peer', 'hello there')
    await r.tick()
    assert.deepEqual(r.submitted, [])
    assert.equal(r.ledger()['room:testseat:2026-10-24T11-59-00-aaaa.json'], 'deferred:supervisor-hold')
    assert.equal(r.inbox().length, 1)
    assert.equal(r.claimed().length + r.processed().length, 0)
    assert.match(r.last(), /supervisor-hold, 1 deferred/)
  } finally { r.done() }
})

test('(b) frozen seat: the supervisor resume leg is delivered', async () => {
  const r = await rig()
  try {
    r.freeze()
    r.drop('2026-10-24T11-59-00-bbbb', `${SEAT}-supervisor`, LEG)
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.match(r.submitted[0], /Run the fleet resume lifecycle verb/)
    assert.equal(r.ledger()['room:testseat:2026-10-24T11-59-00-bbbb.json'], 'submitted')
  } finally { r.done() }
})

test('(c) an ordinary sender imitating a lifecycle line is still deferred; so is the supervisor with another body', async () => {
  const r = await rig()
  try {
    r.freeze()
    r.drop('2026-10-24T11-59-00-cccc', 'peer', LEG)
    r.drop('2026-10-24T11-59-01-dddd', `${SEAT}-supervisor`, 'ordinary text from the supervisor name')
    r.drop('2026-10-24T11-59-02-eeee', 'otherseat-supervisor', LEG)
    await r.tick()
    assert.deepEqual(r.submitted, [])
    assert.equal(r.inbox().length, 3)
    assert.deepEqual(Object.values(r.ledger()), Array(3).fill('deferred:supervisor-hold'))
  } finally { r.done() }
})

test('(d) after release the deferred message delivers once with exactly one ack', async () => {
  const r = await rig()
  try {
    r.freeze()
    r.drop('2026-10-24T11-59-00-ffff', 'peer', 'hold this')
    await r.tick()
    assert.deepEqual(r.submitted, [])
    r.thaw()
    await r.tick()
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.match(r.submitted[0], /hold this/)
    const acks = r.logText().split(String.fromCharCode(10)).filter(l => l.includes('"status":"submitted"') && l.includes('ffff'))
    assert.equal(acks.length, 1)
    assert.equal(r.processed().length, 1)
    assert.equal(r.inbox().length + r.claimed().length, 0)
  } finally { r.done() }
})

test('stale or unreadable freeze fails closed for everything, with a named reason', async () => {
  const r = await rig()
  try {
    r.freeze(Date.parse('2026-10-24T12:00:00Z') - 31 * 60_000)
    r.drop('2026-10-24T11-59-00-1111', `${SEAT}-supervisor`, LEG)
    r.drop('2026-10-24T11-59-01-2222', 'peer', 'plain')
    await r.tick()
    assert.deepEqual(r.submitted, [])
    assert.deepEqual(Object.values(r.ledger()), Array(2).fill('deferred:supervisor-hold-stale'))
    assert.match(r.last(), /supervisor-hold-stale/)
  } finally { r.done() }
})

test('(e) the runner cycle hold still holds everything, supervisor legs included', async () => {
  const r = await rig({ cycle: 'CLEAR_PENDING' })
  try {
    r.drop('2026-10-24T11-59-00-3333', `${SEAT}-supervisor`, LEG)
    r.drop('2026-10-24T11-59-01-4444', 'peer', 'plain')
    await r.tick()
    assert.deepEqual(r.submitted, [])
    assert.deepEqual(Object.values(r.ledger()), Array(2).fill('deferred:refresh-hold'))
  } finally { r.done() }
})

test('a control self-line stays skipped:control during a freeze', async () => {
  const r = await rig()
  try {
    r.freeze()
    r.drop('2026-10-24T11-59-00-5555', SEAT, 'ROOM-LIFECYCLE resume-done 20260101-0000-aaaaaaaa')
    await r.tick()
    assert.deepEqual(r.submitted, [])
    assert.equal(r.ledger()['room:testseat:2026-10-24T11-59-00-5555.json'], 'skipped:control')
  } finally { r.done() }
})

test('capsule window to resume-done: ordinary item queued and unacked throughout, delivered once at release', async () => {
  const r = await rig()
  try {
    const ORD = 'room:testseat:2026-10-24T11-59-00-9999.json'
    // Capsule request goes out: the supervisor has written the hold (phase capsule) first.
    r.freeze(undefined, 'capsule')
    r.drop('2026-10-24T11-59-00-9999', 'peer', 'ordinary mid-capsule message')
    r.drop('2026-10-24T11-59-01-c0c0', `${SEAT}-supervisor`, CAPSULE_REQUEST)
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.match(r.submitted[0], /Run the fleet capsule lifecycle verb/)
    assert.equal(r.ledger()['room:testseat:2026-10-24T11-59-01-c0c0.json'], 'submitted')
    assert.equal(r.ledger()[ORD], 'deferred:supervisor-hold')
    assert.deepEqual(r.inbox(), ['2026-10-24T11-59-00-9999.json'], 'ordinary item still in inbox/')
    assert.equal(r.processed().includes('2026-10-24T11-59-00-9999.json'), false, 'ordinary item not processed')
    assert.equal(r.claimed().length, 0)

    // A stalled seat gets the nudge: also a lifecycle leg, also delivered. Still holding the ordinary item.
    r.advance(10 * 60_000)
    r.freeze(undefined, 'capsule')
    r.drop('2026-10-24T11-59-02-c1c1', `${SEAT}-supervisor`, CAPSULE_NUDGE)
    await r.tick()
    assert.equal(r.submitted.length, 2)
    assert.match(r.submitted[1], /capsule announcement is missing/)
    assert.deepEqual(r.inbox(), ['2026-10-24T11-59-00-9999.json'])

    // Clear submitted: the supervisor re-stamps (phase resume). A capsule phase longer than the fuse
    // measured from the first stamp must not fail the resume leg closed.
    r.advance(25 * 60_000)
    r.freeze(undefined, 'resume')
    r.drop('2026-10-24T11-59-03-c2c2', `${SEAT}-supervisor`, LEG)
    await r.tick()
    assert.equal(r.submitted.length, 3)
    assert.match(r.submitted[2], /Run the fleet resume lifecycle verb/)
    assert.equal(r.ledger()[ORD], 'deferred:supervisor-hold', 'still the fresh hold, not stale')
    assert.deepEqual(r.inbox(), ['2026-10-24T11-59-00-9999.json'])

    // resume-done: the supervisor removes the file. The ordinary item delivers once; a re-tick adds nothing.
    r.thaw()
    await r.tick()
    assert.equal(r.submitted.length, 4)
    assert.match(r.submitted[3], /ordinary mid-capsule message/)
    await r.tick()
    assert.equal(r.submitted.length, 4, 'a re-tick delivers nothing more')
    const acks = r.logText().split(String.fromCharCode(10)).filter(l => l.includes('"status":"submitted"') && l.includes('9999'))
    assert.equal(acks.length, 1, 'exactly one ack')
    assert.equal(r.processed().filter(n => n.includes('9999')).length, 1)
    assert.equal(r.inbox().length + r.claimed().length, 0)
  } finally { r.done() }
})

test('a capsule-phase hold the supervisor stopped re-stamping goes stale and fails closed, legs included', async () => {
  const r = await rig()
  try {
    r.freeze(Date.parse('2026-10-24T12:00:00Z') - 31 * 60_000, 'capsule')
    r.drop('2026-10-24T11-59-00-7777', `${SEAT}-supervisor`, CAPSULE_NUDGE)
    await r.tick()
    assert.deepEqual(r.submitted, [])
    assert.equal(r.ledger()['room:testseat:2026-10-24T11-59-00-7777.json'], 'deferred:supervisor-hold-stale')
  } finally { r.done() }
})

// Urgent mail was delivered before the capsule window was held, so it still passes pre-submit only.
for (const [label, phase, urgentDelivered] of [['phase capsule', 'capsule', true], ['phase resume', 'resume', false], ['no phase (older supervisor)', undefined, false]]) {
  test(`urgent vs ordinary under ${label}`, async () => {
    const r = await rig()
    try {
      r.freeze(undefined, phase)
      r.drop('2026-10-24T11-59-00-u001', 'peer', 'urgent text', 'urgent')
      r.drop('2026-10-24T11-59-01-o002', 'peer', 'ordinary text')
      await r.tick()
      const U = 'room:testseat:2026-10-24T11-59-00-u001.json'
      const O = 'room:testseat:2026-10-24T11-59-01-o002.json'
      assert.equal(r.ledger()[O], 'deferred:supervisor-hold', 'ordinary is held in every phase')
      assert.deepEqual(r.inbox().filter(n => n.includes('o002')).length, 1)
      if (urgentDelivered) {
        assert.equal(r.ledger()[U], 'submitted')
        assert.equal(r.submitted.length, 1)
        assert.match(r.submitted[0], /urgent text/)
      } else {
        assert.equal(r.ledger()[U], 'deferred:supervisor-hold')
        assert.deepEqual(r.submitted, [])
      }
    } finally { r.done() }
  })
}

test('urgent mail does not pass a stale capsule-phase hold', async () => {
  const r = await rig()
  try {
    r.freeze(Date.parse('2026-10-24T12:00:00Z') - 31 * 60_000, 'capsule')
    r.drop('2026-10-24T11-59-00-u003', 'peer', 'urgent text', 'urgent')
    await r.tick()
    assert.deepEqual(r.submitted, [])
    assert.equal(r.ledger()['room:testseat:2026-10-24T11-59-00-u003.json'], 'deferred:supervisor-hold-stale')
  } finally { r.done() }
})

// The hold is read at the start of the tick; these change it during preparation, at each await before
// the submit. The recheck must catch each one, leave the item in inbox/, and a thaw must deliver once.
for (const point of ['read', 'run', 'write']) {
  test(`hold appears during preparation (${point}): ordinary item not submitted, stays queued, delivered once after thaw`, async () => {
    const r = await rig()
    try {
      const ID = 'room:testseat:2026-10-24T11-59-00-p001.json'
      r.drop('2026-10-24T11-59-00-p001', 'peer', 'prepared text')
      r.hooks[point] = () => r.freeze(undefined, 'capsule')
      await r.tick()
      assert.deepEqual(r.submitted, [], 'not submitted')
      assert.equal(r.ledger()[ID], 'deferred:supervisor-hold')
      assert.deepEqual(r.inbox(), ['2026-10-24T11-59-00-p001.json'], 'back in inbox/')
      assert.equal(r.claimed().length + r.processed().length, 0)
      r.thaw()
      await r.tick()
      await r.tick()
      assert.equal(r.submitted.length, 1)
      assert.match(r.submitted[0], /prepared text/)
      assert.equal(r.processed().length, 1)
      assert.equal(r.ledger()[ID], 'submitted')
    } finally { r.done() }
  })
}

test('urgent admitted under phase capsule, hold flips to resume during preparation: not submitted, delivered once after thaw', async () => {
  const r = await rig()
  try {
    const ID = 'room:testseat:2026-10-24T11-59-00-p002.json'
    r.freeze(undefined, 'capsule')
    r.drop('2026-10-24T11-59-00-p002', 'peer', 'urgent prepared', 'urgent')
    r.hooks.read = () => r.freeze(undefined, 'resume')
    await r.tick()
    assert.deepEqual(r.submitted, [])
    assert.equal(r.ledger()[ID], 'deferred:supervisor-hold')
    assert.equal(r.inbox().length, 1)
    r.thaw()
    await r.tick()
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.equal(r.processed().length, 1)
  } finally { r.done() }
})

test('a hold that stays unchanged through preparation does not block delivery (recheck control)', async () => {
  const r = await rig()
  try {
    r.freeze(undefined, 'capsule')
    r.drop('2026-10-24T11-59-00-p003', 'peer', 'urgent ok', 'urgent')
    r.hooks.read = () => r.freeze(undefined, 'capsule')
    await r.tick()
    assert.equal(r.submitted.length, 1)
  } finally { r.done() }
})

test('recheck deferrals do not count against the retry cap: a later transient rejection is still retried', async () => {
  const r = await rig()
  try {
    const ID = 'room:testseat:2026-10-24T11-59-00-p004.json'
    r.drop('2026-10-24T11-59-00-p004', 'peer', 'cap text')
    for (let i = 0; i < 3; i++) {
      r.hooks.read = () => r.freeze(undefined, 'capsule')
      await r.tick()
      assert.equal(r.ledger()[ID], 'deferred:supervisor-hold')
      r.thaw()
    }
    assert.deepEqual(r.submitted, [])
    r.hooks.reject = true
    await r.tick()
    assert.equal(r.ledger()[ID], 'deferred:submit-rejected', 'retried, not terminal')
    await r.tick()
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.equal(r.ledger()[ID], 'submitted')
  } finally { r.done() }
})

test('urgent capsule item sees resume published during the final hold read await, then delivers once after thaw', async () => {
  const r = await rig()
  try {
    const file = '2026-10-24T11-59-00-a001.json'
    const id = `room:${SEAT}:${file}`
    r.freeze(undefined, 'capsule')
    r.drop(file.slice(0, -5), 'peer', 'urgent boundary', 'urgent')
    let ticketAtTransition
    r.hooks.finalRead = async () => {
      ticketAtTransition = r.ticket(file)
      r.freeze(undefined, 'resume')
    }
    await r.tick()
    assert.equal(ticketAtTransition.item, id)
    assert.deepEqual(r.submitted, [])
    assert.deepEqual(r.tickets(), [])
    assert.equal(r.ledger()[id], 'deferred:supervisor-hold')
    assert.deepEqual(r.inbox(), [file])
    assert.equal(r.claimed().length + r.processed().length, 0)
    assert.deepEqual(r.holdSamples.find(s => s.kind === 'read').tickets, [ticketName(file, ticketAtTransition)])
    r.thaw()
    await r.tick()
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.deepEqual(r.processed(), [file])
    assert.equal(r.logText().split('\n').filter(l => l.includes(id) && l.includes('"status":"submitted"')).length, 1)
  } finally { r.done() }
})

test('hold published after the final absence sample admits the already ticketed ordinary submit', async () => {
  const r = await rig()
  try {
    const file = '2026-10-24T11-59-00-a002.json'
    r.drop(file.slice(0, -5), 'peer', 'ordinary boundary')
    let ticketBeforeHold
    r.hooks.finalLookup = async () => {
      ticketBeforeHold = r.ticket(file)
      r.freeze(undefined, 'capsule')
    }
    await r.tick()
    assert.equal(ticketBeforeHold.item, `room:${SEAT}:${file}`)
    assert.deepEqual(r.holdSamples, [{ kind: 'exists', present: false, tickets: [ticketName(file, ticketBeforeHold)] }])
    assert.equal(r.submitted.length, 1)
    assert.equal(r.ledger()[`room:${SEAT}:${file}`], 'submitted')
    assert.deepEqual(r.tickets(), [])
    await r.tick()
    assert.equal(r.submitted.length, 1)
  } finally { r.done() }
})

for (const outcome of ['resolve', 'reject', 'timeout']) {
  test(`admission ticket is present during submit and ${outcome === 'timeout' ? 'retained after timeout' : `removed after ${outcome}`}`, async () => {
    const r = await rig()
    try {
      const file = '2026-10-24T11-59-00-a003.json'
      const id = `room:${SEAT}:${file}`
      r.drop(file.slice(0, -5), 'peer', 'ticket lifetime')
      let during
      r.hooks.submit = () => { during = r.ticket(file) }
      if (outcome === 'reject') r.hooks.reject = true
      let finish
      if (outcome === 'timeout') {
        r.hooks.pending = new Promise(resolve => { finish = resolve })
        r.hooks.timeout = true
      }
      await r.tick()
      assert.deepEqual(during, { version: 1, seat: SEAT, item: id, attempt: during.attempt, pid: process.pid, ts: '2026-10-24T12:00:00.000Z' })
      assert.match(during.attempt, new RegExp(`^${process.pid}-[0-9]+-[0-9]+-[0-9]+-[0-9a-f]{6}$`))
      assert.deepEqual(r.tickets(), outcome === 'timeout' ? [ticketName(file, during)] : [])
      const status = { resolve: 'submitted', reject: 'deferred:submit-rejected', timeout: 'submitting:unresolved' }[outcome]
      assert.equal(r.ledger()[id], status)
      const recorded = r.order.findIndex(e => e.kind === 'ledger' && e.entry.id === id && e.entry.status === status)
      const unlinked = r.order.findIndex(e => e.kind === 'run' && e.argv[2] === UNLINK && ticketMatches(e.argv.at(-1), file))
      if (outcome === 'timeout') assert.equal(unlinked, -1, 'timeout is not settlement evidence')
      else assert.ok(recorded >= 0 && unlinked > recorded, 'settlement ledger line precedes ticket UNLINK')
      if (outcome === 'resolve') {
        const finished = r.order.findIndex(e => e.kind === 'run' && e.argv[2] === MOVE && e.argv.at(-1).includes('/processed/'))
        assert.ok(finished > recorded && unlinked > finished, 'finishRoomFile precedes ticket UNLINK')
      }
      if (outcome === 'timeout') {
        r.advance(31 * 60_000)
        await r.tick()
        assert.deepEqual(r.tickets(), [ticketName(file, during)], 'age and a later sweep do not release an unresolved submit')
        assert.equal(r.submitted.length, 1, 'unknown outcome is never retried')
        finish({})
        for (let i = 0; i < 100 && r.tickets().length; i++) await sleep(100)
        assert.equal(r.ledger()[id], 'submitted', 'late start still settles the ledger')
        assert.deepEqual(r.processed(), [file])
        assert.deepEqual(r.tickets(), [])
      }
    } finally { r.done() }
  })
}

test('the first ticket atomically creates an absent admission directory and submits', async () => {
  const r = await rig()
  try {
    assert.equal(existsSync(r.admit), false)
    r.drop('first-ticket', 'peer', 'create admission directory')
    r.hooks.submit = () => {
      assert.equal(r.ticket('first-ticket.json').item, `room:${SEAT}:first-ticket.json`)
      assert.deepEqual(r.tickets(), [r.ticketFile('first-ticket.json')], 'no temporary file remains after publication')
    }
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.equal(r.runs.filter(argv => argv[2] === WRITE).length, 1)
    assert.equal(r.writes.some(p => p.includes('/state/admit/')), false)
    assert.deepEqual(r.tickets(), [])
  } finally { r.done() }
})

test('an item-specific admission failure consumes retries and lets the next item submit in the same tick', async () => {
  const r = await rig()
  try {
    const file = 'a-bad-ticket.json'
    const id = `room:${SEAT}:${file}`
    // Only this ticket's write fails permanently. The directory accepts the probe.
    r.hooks.writeHost = argv => ticketMatches(argv[4], file) ? { exitCode: 1, stdout: '', stderr: 'EACCES' } : null
    r.drop(file.slice(0, -5), 'peer', 'bad ticket destination')
    r.drop('b-good-ticket', 'peer', 'good ticket destination')
    await r.tick()
    assert.equal(r.ledger()[id], 'deferred:admission-unwritable')
    assert.equal(r.submitted.length, 1)
    assert.match(r.submitted[0], /good ticket destination/)
    assert.deepEqual(r.inbox(), [file])
    assert.deepEqual(r.processed(), ['b-good-ticket.json'])
    const lines = () => r.logText().split('\n').filter(l => l.includes(id)).map(l => JSON.parse(l.replace(/^\d+ /, '')))
    assert.equal(lines().at(-1).attempts, 1)
    assert.equal(r.runs.filter(argv => argv[2] === WRITE && argv[4].includes('/.probe-')).length, 1)
    assert.deepEqual(r.tickets(), [], 'no ticket lands and the successful probe is removed')
    await r.tick()
    assert.equal(lines().at(-1).attempts, 2)
    assert.equal(r.ledger()[id], 'deferred:admission-unwritable')
    await r.tick()
    assert.equal(lines().at(-1).attempts, 3)
    assert.equal(r.ledger()[id], 'error:admission-unwritable')
    assert.deepEqual(r.inbox(), [file])
    const writes = r.runs.filter(argv => argv[2] === WRITE).length
    await r.tick()
    assert.equal(r.runs.filter(argv => argv[2] === WRITE).length, writes, 'retry cap stops attempts')
    assert.equal(r.submitted.length, 1)
  } finally { r.done() }
})

test('job admission filenames sanitize colons and distinguish ids with the same sanitized text', async () => {
  const id = 'nightly:2026-10-27'
  assert.match(safeName(id), /^nightly_2026-10-27-[0-9a-f]{8}$/)
  assert.notEqual(safeName(id), safeName('nightly_2026-10-27'))
  assert.match(safeName('a:/\\?* b'), /^a______b-[0-9a-f]{8}$/)
  const r = await rig({ jobs: [{ id, job: 'nightly' }] })
  try {
    const file = `job-${safeName(id)}.json`
    r.hooks.submit = () => {
      assert.deepEqual(r.tickets(), [r.ticketFile(file)])
      assert.equal(r.ticket(file).item, `job:${id}`)
    }
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.match(r.logText(), /"status":"submitted"/)
    assert.deepEqual(r.tickets(), [])
  } finally { r.done() }
})

test('tick start removes all probe leftovers and leaves other non-ticket names untouched', async () => {
  const r = await rig()
  try {
    mkdirSync(r.admit, { recursive: true })
    const foreign = `.probe-${process.pid + 1}`
    writeFileSync(join(r.admit, `.probe-${process.pid}`), '')
    writeFileSync(join(r.admit, '.probe-null'), '')
    writeFileSync(join(r.admit, foreign), '')
    writeFileSync(join(r.admit, 'other.tmp'), JSON.stringify({ pid: process.pid, id: 'job:other' }))
    r.drop('after-probe', 'peer', 'probe swept before submit')
    r.hooks.submit = () => assert.deepEqual(r.tickets(), [r.ticketFile('after-probe.json'), 'other.tmp'].sort())
    await r.tick()
    assert.deepEqual(r.tickets(), ['other.tmp'])
    assert.equal(r.submitted.length, 1)
  } finally { r.done() }
})

test('an unwritable admission directory defers, restores the Room file, and does not consume retries', async () => {
  const r = await rig()
  try {
    const file = '2026-10-24T11-59-00-a004.json'
    const id = `room:${SEAT}:${file}`
    mkdirSync(dirname(r.admit), { recursive: true })
    writeFileSync(r.admit, 'not a directory')
    r.drop(file.slice(0, -5), 'peer', 'unwritable ticket')
    await r.tick()
    assert.deepEqual(r.submitted, [])
    assert.equal(r.ledger()[id], 'deferred:admission-unwritable')
    assert.deepEqual(r.inbox(), [file])
    assert.equal(r.claimed().length + r.processed().length, 0)
    const lines = r.logText().split('\n').filter(l => l.includes(id)).map(l => JSON.parse(l.replace(/^\d+ /, '')))
    assert.deepEqual(lines.map(l => l.status), ['deferred:admission-unwritable'])
    assert.equal(lines.at(-1).attempts ?? 0, 0)
    assert.match(lines.at(-1).detail, /EEXIST|ENOTDIR/)
    assert.ok(lines.at(-1).detail.length <= 160)
    // Once the failure is known, even new items defer without a claim move.
    const other = '2026-10-24T11-59-01-a004.json'
    const otherId = `room:${SEAT}:${other}`
    r.drop(other.slice(0, -5), 'peer', 'also waiting')
    const moves = () => r.runs.filter(argv => argv[2] === MOVE).length
    const probes = () => r.runs.filter(argv => argv[2] === WRITE && argv[4].includes('/.probe-')).length
    const beforeMoves = moves()
    assert.equal(probes(), 1, 'directory failure probes immediately')
    await r.tick()
    assert.equal(moves(), beforeMoves)
    assert.equal(probes(), 2)
    assert.equal(r.ledger()[otherId], 'deferred:admission-unwritable')
    for (const queuedId of [id, otherId]) {
      assert.equal(r.logText().split('\n').filter(l => l.includes(queuedId) && l.includes('deferred:admission-unwritable')).length, 1)
    }
    const heldLog = r.logText()
    await r.tick()
    assert.equal(probes(), 3)
    assert.equal(moves(), beforeMoves)
    assert.equal(r.logText(), heldLog)
    assert.deepEqual(r.submitted, [])
    rmSync(r.admit)
    await r.tick()
    assert.equal(probes(), 4)
    assert.equal(r.runs.filter(argv => argv[2] === UNLINK && argv.at(-1).includes('/.probe-')).length, 1)
    await r.tick()
    assert.equal(r.submitted.length, 2)
    assert.deepEqual(r.tickets(), [])
  } finally { r.done() }
})

test('tick start preserves own and live foreign tickets and removes only dead owners', async () => {
  const r = await rig()
  try {
    mkdirSync(r.admit, { recursive: true })
    r.hooks.pidProbe = pid => ({ exitCode: Number(pid) === process.pid + 2 ? 0 : 1 })
    for (const [file, pid] of [['own.json', process.pid], ['foreign.json', process.pid + 1], ['dead.json', process.pid + 2]]) {
      writeFileSync(join(r.admit, file), JSON.stringify({ version: 1, seat: SEAT, item: `room:${SEAT}:${file}`, pid, ts: '2026-10-24T12:00:00.000Z' }))
    }
    await r.tick()
    assert.deepEqual(r.tickets(), ['foreign.json', 'own.json'])
    assert.deepEqual(r.submitted, [])
  } finally { r.done() }
})

test('a failed own-ticket removal logs one note and later sweeps preserve the leak without resending', async () => {
  const r = await rig()
  try {
    const file = '2026-10-24T11-59-00-a005.json'
    r.drop(file.slice(0, -5), 'peer', 'unlink failure')
    r.hooks.failUnlink = true
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.equal(r.ledger()[`room:${SEAT}:${file}`], 'submitted')
    assert.deepEqual(r.tickets(), [r.ticketFile(file)])
    assert.equal(r.logText().split('\n').filter(l => l.includes('note: admission removal failed: exit 1 EPERM')).length, 1)
    await r.tick()
    assert.deepEqual(r.tickets(), [r.ticketFile(file)])
    assert.equal(r.submitted.length, 1)
  } finally { r.done() }
})

test('an admission ticket already removed at submit settlement is successful cleanup', async () => {
  const r = await rig()
  try {
    const file = '2026-10-24T11-59-00-a006.json'
    r.drop(file.slice(0, -5), 'peer', 'already removed ticket')
    let existed = false
    r.hooks.submit = () => { existed = r.tickets().includes(r.ticketFile(file)); rmSync(join(r.admit, r.ticketFile(file))) }
    await r.tick()
    assert.equal(existed, true)
    assert.equal(r.submitted.length, 1)
    assert.deepEqual(r.tickets(), [])
    assert.doesNotMatch(r.logText(), /admission removal failed/)
    assert.equal(r.logText().split('\n').filter(l => l.includes('note: admission ticket already gone')).length, 1)
    await r.tick()
    assert.equal(r.logText().split('\n').filter(l => l.includes('note: admission ticket already gone')).length, 1)
  } finally { r.done() }
})

for (const status of ['submitting', 'submitting:unresolved']) {
  test(`sweep preserves an old generation's ${status} and final own-pid tickets`, async () => {
    const liveId = `room:${SEAT}:live.json`
    const finalId = `room:${SEAT}:final.json`
    const r = await rig({ entries: [
      { id: liveId, source: 'room', status, at: '2026-10-24T12:00:00.000Z', pid: String(process.pid), gen: 0, attempts: 1 },
      { id: finalId, source: 'room', status: 'submitted', at: '2026-10-24T12:00:00.000Z', pid: String(process.pid), gen: 0, attempts: 1 },
    ] })
    try {
      mkdirSync(r.admit, { recursive: true })
      for (const [file, id] of [['live.json', liveId], ['final.json', finalId]]) {
        writeFileSync(join(r.admit, file), JSON.stringify({ version: 1, seat: SEAT, item: id, pid: process.pid, ts: '2026-10-24T12:00:00.000Z' }))
      }
      await r.tick()
      await r.tick()
      assert.deepEqual(r.tickets(), ['final.json', 'live.json'])
      assert.equal(r.ledger()[liveId], 'submitting:unresolved')
      assert.equal(r.runs.some(argv => argv[2] === UNLINK && argv.at(-1).endsWith('/live.json')), false)
      assert.deepEqual(r.submitted, [])
    } finally { r.done() }
  })
}

test('pid unavailable defers once without admission or retry cost, retries discovery, and resumes', async () => {
  const r = await rig({ noPid: true })
  try {
    r.drop('no-pid', 'peer', 'deliver without pid')
    let during
    r.hooks.submit = () => { during = r.ticket('no-pid.json') }
    await r.tick()
    const id = `room:${SEAT}:no-pid.json`
    const heldLog = r.logText()
    await r.tick()
    await r.tick()
    assert.equal(r.logText(), heldLog)
    assert.equal(heldLog.split('\n').filter(l => l.includes('deferred:admission-no-pid')).length, 1)
    assert.equal(r.held(id).attempts ?? 0, 0)
    assert.equal(r.held(id).status, 'deferred:admission-no-pid')
    assert.match(r.last(), /admission-no-pid, 1 deferred/)
    assert.equal(r.runs.filter(argv => argv[2] === OWNER_PID).length, 3)
    assert.equal(r.runs.some(argv => argv[2] === WRITE), false)
    assert.deepEqual(r.tickets(), [])
    assert.deepEqual(r.submitted, [])
    assert.deepEqual(r.inbox(), ['no-pid.json'])
    assert.deepEqual(r.claimed(), [])
    r.recoverPid()
    await r.tick()
    assert.equal(during.pid, process.pid)
    assert.equal(during.ts, '2026-10-24T12:00:00.000Z')
    assert.equal(r.submitted.length, 1)
    assert.equal(r.ledger()[`room:${SEAT}:no-pid.json`], 'submitted')
    assert.equal(r.held(id).attempts, 1)
    await r.tick()
    assert.equal(r.runs.filter(argv => argv[2] === OWNER_PID).length, 4, 'known pid is cached')
    assert.deepEqual(r.tickets(), [])
  } finally { r.done() }
})

test('a dead-owner ticket without a ledger entry logs an unlink failure only to the UI', async () => {
  const r = await rig()
  try {
    const id = `room:${SEAT}:leaked.json`
    mkdirSync(r.admit, { recursive: true })
    writeFileSync(join(r.admit, 'leaked.json'), JSON.stringify({ version: 1, seat: SEAT, item: id, pid: process.pid + 1, ts: '2026-10-24T12:00:00.000Z' }))
    r.hooks.pidProbe = pid => ({ exitCode: Number(pid) === process.pid ? 1 : 0 })
    r.hooks.failUnlink = true
    await r.tick()
    assert.deepEqual(r.tickets(), ['leaked.json'])
    assert.equal(r.logText().split('\n').some(l => l.includes(id)), false)
    assert.equal(r.ledger()[id], undefined)
    assert.equal(r.logs.filter(l => l.includes('admission removal failed: exit 1 EPERM')).length, 1)
    // The Room file can still arrive and deliver on a later tick.
    r.drop('leaked', 'peer', 'not hidden by a cleanup note')
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.equal(r.ledger()[id], 'submitted')
  } finally { r.done() }
})

test('a swept ticket unlink failure preserves the current final ledger status', async () => {
  const id = `room:${SEAT}:finished.json`
  const r = await rig({ entries: [{ id, source: 'room', status: 'submitted', attempts: 2, at: '2026-10-24T12:00:00.000Z' }] })
  try {
    mkdirSync(r.admit, { recursive: true })
    writeFileSync(join(r.admit, 'finished.json'), JSON.stringify({ version: 1, seat: SEAT, item: id, pid: process.pid + 1, ts: '2026-10-24T12:00:00.000Z' }))
    r.hooks.pidProbe = pid => ({ exitCode: Number(pid) === process.pid ? 1 : 0 })
    r.hooks.failUnlink = true
    await r.tick()
    const lines = r.logText().split('\n').filter(l => l.includes(id)).map(l => JSON.parse(l.replace(/^\d+ /, '')))
    assert.equal(lines.at(-1).status, 'submitted')
    assert.equal(lines.at(-1).attempts, 2)
    assert.match(lines.at(-1).detail, /admission removal failed/)
    await r.tick()
    assert.deepEqual(r.tickets(), [])
    assert.deepEqual(r.submitted, [])
  } finally { r.done() }
})

test('a WRITE timeout after publication proceeds with the landed ticket', async () => {
  const r = await rig()
  try {
    r.drop('landed', 'peer', 'landed before timeout')
    r.hooks.writeHost = argv => {
      const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' })
      assert.equal(result.status, 0)
      throw Object.assign(new Error('host timeout'), { name: 'TimeoutError' })
    }
    r.hooks.submit = () => assert.equal(r.ticket('landed.json').item, `room:${SEAT}:landed.json`)
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.equal(r.ledger()[`room:${SEAT}:landed.json`], 'submitted')
    assert.equal(r.runs.filter(argv => argv[2] === WRITE).length, 1, 'no probe for a landed write')
    assert.deepEqual(r.tickets(), [])
  } finally { r.done() }
})

for (const failure of ['TimeoutError', 'run failed', 'EBUSY', 'EPERM', 'EIO', 'ENOENT', 'EISDIR', 'ENOTDIR', 'EACCES', 'EINVAL', 'ENAMETOOLONG', 'exists-unreadable']) {
  test(`admission WRITE ${failure} charges only confirmed permanent item failures`, async () => {
    const id = `room:${SEAT}:write-failure.json`
    const r = await rig({ entries: [{ id, source: 'room', status: 'deferred:submit-rejected', attempts: 2, at: '2026-10-24T12:00:00.000Z' }] })
    try {
      r.drop('write-failure', 'peer', 'retry accounting')
      r.hooks.ticketExistsThrows = failure === 'exists-unreadable'
      r.hooks.writeHost = argv => {
        if (!argv[4].endsWith('.json')) return null
        if (failure === 'TimeoutError') throw Object.assign(new Error(), { name: failure })
        if (failure === 'run failed') throw {}
        return { exitCode: 1, stdout: '', stderr: failure === 'exists-unreadable' ? 'EACCES' : failure }
      }
      await r.tick()
      const permanent = ['EISDIR', 'ENOTDIR', 'EACCES', 'EINVAL', 'ENAMETOOLONG'].includes(failure)
      const last = r.logText().trim().split('\n').map(l => JSON.parse(l.replace(/^\d+ /, ''))).filter(l => l.id === id).at(-1)
      assert.equal(last.status, `${permanent ? 'error' : 'deferred'}:admission-unwritable`)
      assert.equal(last.attempts, permanent ? 3 : 2)
      assert.match(last.detail, new RegExp(failure === 'exists-unreadable' ? 'EACCES' : failure))
      assert.deepEqual(r.submitted, [])
      assert.deepEqual(r.inbox(), ['write-failure.json'])
      assert.deepEqual(r.tickets(), [])
      assert.equal(r.runs.filter(argv => argv[2] === WRITE && argv[5] === '').length, 1)
    } finally { r.done() }
  })
}

for (const failure of ['EBUSY', 'EPERM', 'EACCES']) {
  test(`admission deferrals bound a tick to three failing jobs (${failure})`, async () => {
    const r = await rig({ jobs: Array.from({ length: 8 }, (_, i) => ({ id: `job-${i}`, job: 'nightly' })) })
    try {
      r.hooks.writeHost = argv => argv[4].endsWith('.json') ? { exitCode: 1, stdout: '', stderr: failure } : null
      await r.tick()
      assert.equal(r.runs.filter(argv => argv[2] === WRITE && argv[4].endsWith('.json')).length, 3)
      assert.equal(r.runs.filter(argv => argv[2] === WRITE && argv[5] === '').length, 3)
      assert.equal(r.logText().split('\n').filter(l => l.includes('"status":"deferred:admission-unwritable"')).length, 3)
      assert.deepEqual(r.submitted, [])
    } finally { r.done() }
  })
}

test('unknown pid retains legacy null-pid tickets and removes probe leftovers', async () => {
  const entries = ['submitting', 'submitting:unresolved', 'submitted'].map(status => ({
    id: `job:${status}`, source: 'job-results', status, attempts: 1, at: '2026-10-24T12:00:00.000Z',
  }))
  const r = await rig({ noPid: true, entries })
  try {
    mkdirSync(r.admit, { recursive: true })
    for (const [file, id, pid] of [
      ['submitting.json', 'job:submitting', null],
      ['unresolved.json', 'job:submitting:unresolved', null],
      ['final.json', 'job:submitted', null],
      ['leaked.json', 'job:leaked', null],
      ['foreign.json', 'job:foreign', process.pid],
    ]) writeFileSync(join(r.admit, file), JSON.stringify({ version: 1, seat: SEAT, item: id, pid, ts: '2026-10-24T12:00:00.000Z' }))
    writeFileSync(join(r.admit, '.probe-null'), '')
    writeFileSync(join(r.admit, `.probe-${process.pid}`), '')
    await r.tick()
    assert.deepEqual(r.tickets(), ['final.json', 'foreign.json', 'leaked.json', 'submitting.json', 'unresolved.json'])
    assert.deepEqual(r.submitted, [])
  } finally { r.done() }
})

for (const minutes of [undefined, 10, 10.5]) {
  test(`submit timeout ${minutes ?? 'default'} warns once about unresolved lifecycle deferral only above 10`, async () => {
    const r = await rig({ submitTimeoutMinutes: minutes })
    try {
      await r.tick()
      await r.tick()
      const warnings = r.logs.filter(line => line.includes('an unresolved submit defers lifecycle transitions'))
      assert.equal(warnings.length, minutes > 10 ? 1 : 0)
      if (warnings.length) assert.match(warnings[0], /warning: submitTimeoutMinutes exceeds 10/)
      if (warnings.length) assert.match(warnings[0], /until its own promise settles or its owning process ends/)
      assert.equal(r.logs.some(line => line.includes('11-minute fuse')), false)
    } finally { r.done() }
  })
}


test('a directory squatting the ticket path exhausts the admission retry cap', async () => {
  const r = await rig()
  try {
    r.hooks.writeHost = argv => {
      if (ticketMatches(argv[4], 'blocked.json')) mkdirSync(argv[4], { recursive: true })
      return null
    }
    r.drop('blocked', 'peer', 'must wait for a real ticket')
    await r.tick()
    assert.deepEqual(r.submitted, [])
    assert.equal(r.ledger()[`room:${SEAT}:blocked.json`], 'deferred:admission-unwritable')
    assert.deepEqual(r.inbox(), ['blocked.json'])
    assert.equal(r.tickets().length, 1, 'failed write cleans up its temporary file and successful probe')
    assert.ok(r.tickets().every(file => ticketMatches(file, 'blocked.json')))
    await r.tick()
    await r.tick()
    assert.equal(r.ledger()[`room:${SEAT}:blocked.json`], 'error:admission-unwritable')
    const log = r.logText()
    const writes = r.runs.filter(argv => argv[2] === WRITE).length
    await r.tick()
    assert.equal(r.logText(), log)
    assert.equal(r.runs.filter(argv => argv[2] === WRITE).length, writes, 'the cap stops retrying')
    assert.deepEqual(r.submitted, [])
    assert.equal(r.tickets().length, 3)
    assert.ok(r.tickets().every(file => ticketMatches(file, 'blocked.json')))
  } finally { r.done() }
})

test('Superseded at the durable claim leaves the successor generation ticket in place', async () => {
  const r = await rig()
  const id = `room:${SEAT}:generation.json`
  const successorReady = Promise.withResolvers()
  let first, successor
  try {
    r.drop('generation', 'peer', 'reload during admission')
    r.hooks.published = () => {
      first = r.ticket('generation.json')
      r.supersede()
      r.hooks.stateSet = async (key, value) => {
        if (key.key !== 'ledger' || value[SEAT]?.[id]?.status === 'submitting') return
        delete r.hooks.stateSet
        try {
          await r.reload()
          r.hooks.pending = new Promise(() => {})
          await r.tick()
          assert.equal(r.tickets().length, 2, 'the successor sweep leaves the old attempt for its own undo cleanup')
          successor = JSON.parse(readFileSync(join(r.admit, r.tickets().find(file => file !== ticketName('generation.json', first))), 'utf8'))
          successorReady.resolve()
        } catch (error) { successorReady.reject(error) }
      }
    }
    await r.tick()
    await successorReady.promise
    await sleep(700) // Let G1 resume its cleanup after the successor tick.
    assert.ok(successor, 'the successor published while G1 undid its reservation')
    assert.equal(first.ts, successor.ts, 'both attempts publish within the same clock tick')
    assert.notEqual(first.attempt, successor.attempt)
    assert.equal(first.pid, successor.pid)
    assert.deepEqual(r.ticket('generation.json'), successor)
    assert.equal(r.held(id).status, 'submitting')
    assert.equal(r.submitted.length, 1, 'only the successor submitted')
    assert.deepEqual(r.tickets(), [ticketName('generation.json', successor)])
    assert.ok(r.runs.filter(argv => argv[2] === UNLINK && ticketMatches(argv.at(-1), 'generation.json')).every(argv => argv.at(-1).endsWith(ticketName('generation.json', first))), 'cleanup can only address the old attempt')
  } finally { r.done() }
})

for (const mismatch of ['ts', 'pid']) {
  for (const outcome of ['resolve', 'reject', 'timeout']) {
    test(`${outcome} cleanup preserves a successor attempt with a different ${mismatch}`, async () => {
      const r = await rig()
      let replacement
      try {
        r.drop('replacement', 'peer', 'ownership must survive settlement')
        r.hooks.submit = () => {
          replacement = r.ticket('replacement.json')
          replacement.attempt += '-successor'
          replacement[mismatch] = mismatch === 'pid' ? process.pid + 1 : '2026-10-24T12:00:01.000Z'
          writeFileSync(join(r.admit, ticketName('replacement.json', replacement)), JSON.stringify(replacement))
        }
        if (outcome === 'reject') r.hooks.reject = true
        if (outcome === 'timeout') {
          r.hooks.pending = new Promise(() => {})
          r.hooks.timeout = true
        }
        await r.tick()
        assert.deepEqual(JSON.parse(readFileSync(join(r.admit, ticketName('replacement.json', replacement)), 'utf8')), replacement)
        assert.equal(r.runs.some(argv => argv[2] === UNLINK && argv.at(-1).endsWith(ticketName('replacement.json', replacement))), false)
      } finally { r.done() }
    })
  }
}

for (const outcome of ['resolve', 'reject', 'timeout']) {
  test(`Superseded during ${outcome} ${outcome === 'timeout' ? 'keeps the unknown admission' : 'still unlinks the admission'}`, async () => {
    const r = await rig()
    try {
      r.drop('superseded', 'peer', 'settlement throws after submit')
      r.hooks.submit = () => {
        assert.equal(r.ticket('superseded.json').pid, process.pid)
        r.supersede()
      }
      if (outcome === 'reject') r.hooks.reject = true
      if (outcome === 'timeout') {
        r.hooks.pending = new Promise(() => {})
        r.hooks.timeout = true
      }
      await r.tick()
      assert.equal(r.ledger()[`room:${SEAT}:superseded.json`], 'submitting', 'Superseded prevents settlement recording')
      assert.equal(r.runs.filter(argv => argv[2] === UNLINK && ticketMatches(argv.at(-1), 'superseded.json')).length, outcome === 'timeout' ? 0 : 1)
      assert.equal(r.tickets().length, outcome === 'timeout' ? 1 : 0)
    } finally { r.done() }
  })
}

for (const mismatch of ['pid', 'item', 'ts', 'attempt']) {
  test(`a failed WRITE preserves a ticket with a foreign ${mismatch}`, async () => {
    const r = await rig()
    try {
      r.drop('foreign', 'peer', 'must not use a foreign ticket')
      let body
      r.hooks.writeHost = argv => {
        if (!ticketMatches(argv[4], 'foreign.json')) return null
        const ticket = JSON.parse(argv[5])
        ticket[mismatch] = { pid: process.pid + 1, item: 'room:testseat:other.json', attempt: 'foreign-attempt', ts: '2026-10-24T11:59:00.000Z' }[mismatch]
        body = JSON.stringify(ticket)
        mkdirSync(r.admit, { recursive: true })
        writeFileSync(argv[4], body)
        return { exitCode: 1, stdout: '', stderr: 'EPERM' }
      }
      await r.tick()
      assert.deepEqual(r.submitted, [])
      assert.equal(r.ledger()[`room:${SEAT}:foreign.json`], 'deferred:admission-unwritable')
      assert.equal(readFileSync(join(r.admit, r.ticketFile('foreign.json')), 'utf8'), body)
      assert.equal(r.runs.some(argv => argv[2] === UNLINK && ticketMatches(argv.at(-1), 'foreign.json')), false)
      const entry = r.logText().trim().split('\n').map(l => JSON.parse(l.replace(/^\d+ /, ''))).at(-1)
      assert.equal(entry.attempts ?? 0, 0)
    } finally { r.done() }
  })
}

test('admission sweep removes abandoned WRITE temps only after the 11-minute mtime fuse', async () => {
  const r = await rig()
  try {
    mkdirSync(r.admit, { recursive: true })
    const now = Date.parse('2026-10-24T12:00:00Z')
    for (const [name, age] of [
      ['old.json.tmp-123', 11 * 60_000 + 1],
      ['.probe-null.tmp-456', 12 * 60_000],
      ['boundary.json.tmp-789', 11 * 60_000],
      ['fresh.json.tmp-123', 60_000],
      ['unrelated.tmp', 12 * 60_000],
    ]) {
      const path = join(r.admit, name)
      writeFileSync(path, 'partial write')
      utimesSync(path, new Date(now - age), new Date(now - age))
    }
    await r.tick()
    assert.deepEqual(r.tickets(), ['boundary.json.tmp-789', 'fresh.json.tmp-123', 'unrelated.tmp'])
    r.advance(11 * 60_000)
    await r.tick()
    assert.deepEqual(r.tickets(), ['unrelated.tmp'])
    assert.deepEqual(r.submitted, [])
  } finally { r.done() }
})

for (const failure of ['TimeoutError', 'run failed', 'EBUSY', 'EPERM']) {
  test(`unchanged admission ${failure} deferrals log once and recover with one submit`, async () => {
    const r = await rig()
    try {
      r.drop('dedupe', 'peer', 'retry without ledger churn')
      const reservations = []
      r.hooks.writeHost = argv => {
        if (!argv[4].endsWith('.json')) return null
        reservations.push({ status: r.held(`room:${SEAT}:dedupe.json`)?.status, log: r.logText() })
        if (failure === 'TimeoutError') throw Object.assign(new Error(), { name: failure })
        if (failure !== 'run failed') return { exitCode: 1, stdout: '', stderr: failure }
        throw {}
      }
      await r.tick()
      const log = r.logText()
      await r.tick()
      await r.tick()
      assert.deepEqual(reservations.map(r => r.status), ['submitting', 'submitting', 'submitting'], 'shared state reserves admission before every WRITE')
      for (const r of reservations) assert.doesNotMatch(r.log, /"status":"submitting"/, 'no durable submit claim before publication')
      assert.equal(r.logText(), log, 'unchanged status and attempts add no ledger lines')
      assert.equal(log.split('\n').filter(l => l.includes('deferred:admission-unwritable')).length, 1)
      assert.deepEqual(r.inbox(), ['dedupe.json'])
      assert.deepEqual(r.submitted, [])
      delete r.hooks.writeHost
      await r.tick()
      assert.equal(r.submitted.length, 1)
      assert.equal(r.ledger()[`room:${SEAT}:dedupe.json`], 'submitted')
      assert.deepEqual(r.tickets(), [])
      const claim = r.order.findIndex(e => e.kind === 'ledger' && e.entry.status === 'submitting')
      const publication = r.order.findLastIndex(e => e.kind === 'run' && e.argv[2] === WRITE && ticketMatches(e.argv[4], 'dedupe.json'))
      assert.ok(claim > publication, 'the durable claim follows successful admission publication')
    } finally { r.done() }
  })
}

for (const outcome of ['resolve', 'reject']) {
  test(`successor published immediately before old ${outcome} unlink survives without an identity read`, async () => {
    const r = await rig()
    try {
      r.drop('unlink-race', 'peer', 'cleanup race')
      let old, successor, successorFile, reads = 0
      r.hooks.submit = () => {
        old = r.ticket('unlink-race.json')
        r.hooks.ticketRead = () => { reads++ }
        r.hooks.beforeUnlink = () => {
          successor = { ...old, attempt: `${old.attempt}-successor` }
          successorFile = ticketName('unlink-race.json', successor)
          writeFileSync(join(r.admit, successorFile), JSON.stringify(successor))
        }
      }
      if (outcome === 'reject') r.hooks.reject = true
      await r.tick()
      assert.equal(reads, 0, 'cleanup never reads admission identity before unlink')
      assert.deepEqual(r.tickets(), [successorFile])
      assert.deepEqual(JSON.parse(readFileSync(join(r.admit, successorFile), 'utf8')), successor)
      assert.equal(r.runs.filter(argv => argv[2] === UNLINK && argv.at(-1).endsWith(ticketName('unlink-race.json', old))).length, 1)
    } finally { r.done() }
  })
}

for (const superseded of [false, true]) {
  test(`late rejection removes a timed-out ticket${superseded ? ' even when settlement throws after reload' : ''}`, async () => {
    const r = await rig()
    const pending = Promise.withResolvers()
    try {
      const id = `room:${SEAT}:late-reject.json`
      r.drop('late-reject', 'peer', 'unknown until host rejects')
      r.hooks.pending = pending.promise
      r.hooks.timeout = true
      await r.tick()
      assert.equal(r.held(id).status, 'submitting:unresolved')
      assert.equal(r.tickets().length, 1)
      if (superseded) r.supersede()
      pending.reject(new Error('late host rejection'))
      for (let i = 0; i < 100 && r.tickets().length; i++) await sleep(100)
      assert.deepEqual(r.tickets(), [])
      assert.equal(r.held(id).status, superseded ? 'submitting:unresolved' : 'deferred:submit-rejected')
      assert.equal(r.held(id).attempts, 1)
    } finally { r.done() }
  })
}

for (const verdict of ['', ' delivered']) {
  for (const outcome of ['resolve', 'reject']) {
    test(`reconcile${verdict || ' not-delivered'} preserves pending tickets until their own ${outcome}`, async () => {
      const r = await rig()
      const pending = Promise.withResolvers()
      try {
        const id = `room:${SEAT}:reconcile.json`
        r.drop('reconcile', 'peer', 'operator reconciliation')
        r.hooks.pending = pending.promise
        r.hooks.timeout = true
        await r.tick()
        const first = r.ticket('reconcile.json')
        r.hooks.pidProbe = () => ({ exitCode: 1 })
        for (const pid of [process.pid + 1, process.pid + 2]) {
          const other = { ...first, pid, attempt: `${first.attempt}-${pid}` }
          writeFileSync(join(r.admit, ticketName('reconcile.json', other)), JSON.stringify(other))
        }
        const unrelated = { ...first, item: 'job:unrelated', attempt: 'unrelated', pid: process.pid + 1 }
        writeFileSync(join(r.admit, 'unrelated.json'), JSON.stringify(unrelated))
        const outstanding = r.tickets()
        r.freeze() // Keep not-delivered retry queued while inspecting reconciliation.
        const answer = await r.reconcile(id + verdict)
        assert.match(answer.text, new RegExp(`is reconciled:${verdict ? 'delivered' : 'not-delivered'}`))
        assert.deepEqual(r.tickets(), outstanding)
        assert.equal(r.held(id).attempts, 1)
        await r.tick()
        assert.deepEqual(r.tickets(), outstanding, 'automatic sweep cannot release reconciled admissions')
        if (outcome === 'resolve') pending.resolve({})
        else pending.reject(new Error('late rejection after reconcile'))
        const ownFile = ticketName('reconcile.json', first)
        for (let i = 0; i < 100 && r.tickets().includes(ownFile); i++) await sleep(100)
        assert.deepEqual(r.tickets(), outstanding.filter(file => file !== ownFile), 'late settlement removes only its own admission')
        assert.equal(r.submitted.length, 1)
      } finally { r.done() }
    })
  }
}

test('late settlement after reconcile cannot remove a retry ticket or overwrite its attempt', async () => {
  const r = await rig()
  const first = Promise.withResolvers()
  const second = Promise.withResolvers()
  try {
    const id = `room:${SEAT}:retry.json`
    r.drop('retry', 'peer', 'two attempts')
    r.hooks.pending = first.promise
    r.hooks.timeout = true
    await r.tick()
    const old = r.ticket('retry.json')
    r.hooks.pending = second.promise
    await r.reconcile(id)
    for (let i = 0; i < 100 && r.submitted.length < 2; i++) await sleep(100)
    assert.equal(r.tickets().length, 2, 'the first submit still owns its ticket after reconciliation')
    const current = JSON.parse(readFileSync(join(r.admit, r.tickets().find(file => file !== ticketName('retry.json', old))), 'utf8'))
    assert.notEqual(current.attempt, old.attempt)
    assert.equal(current.ts, old.ts, 'nonce uniqueness does not depend on advancing time')
    first.resolve({})
    await sleep(300)
    assert.deepEqual(r.ticket('retry.json'), current)
    assert.equal(r.held(id).status, 'submitting')
    assert.equal(r.held(id).attempts, 2)
    assert.match(r.logText(), /late start from attempt 1/)
    second.resolve({})
    for (let i = 0; i < 100 && r.tickets().length; i++) await sleep(100)
    assert.deepEqual(r.tickets(), [])
    assert.equal(r.held(id).status, 'submitted')
    assert.equal(r.held(id).attempts, 2)
  } finally { r.done() }
})

test('sweep preserves all live-owner attempts regardless of ledger status and all corrupt tickets', async () => {
  const entries = [
    { id: 'job:held', source: 'job-results', status: 'submitting:unresolved', attempts: 1, at: '2026-10-24T12:00:00.000Z' },
    { id: 'job:done', source: 'job-results', status: 'submitted', attempts: 1, at: '2026-10-24T12:00:00.000Z' },
  ]
  const r = await rig({ entries })
  try {
    r.hooks.pidProbe = () => ({ exitCode: 1 })
    mkdirSync(r.admit, { recursive: true })
    for (const [name, item, pid, seat] of [
      ['held-a.json', 'job:held', process.pid, SEAT],
      ['held-b.json', 'job:held', process.pid, SEAT],
      ['done-a.json', 'job:done', process.pid, SEAT],
      ['done-b.json', 'job:done', process.pid, SEAT],
      ['foreign-pid.json', 'job:done', process.pid + 1, SEAT],
      ['foreign-seat.json', 'job:done', null, 'another-seat'],
    ]) writeFileSync(join(r.admit, name), JSON.stringify({ item, pid, seat, attempt: name }))
    writeFileSync(join(r.admit, 'malformed.json'), '{')
    writeFileSync(join(r.admit, 'missing-item.json'), JSON.stringify({ pid: process.pid, seat: SEAT }))
    await r.tick()
    assert.deepEqual(r.tickets(), ['done-a.json', 'done-b.json', 'foreign-pid.json', 'foreign-seat.json', 'held-a.json', 'held-b.json', 'malformed.json', 'missing-item.json'])
    assert.deepEqual(r.submitted, [])
  } finally { r.done() }
})

// A legacy null-pid ticket may belong to an older module's still-pending submit
// (hot reload into this head); a damaged owner field proves nothing either way.
// Neither the ledger verdict, nor time, nor whether this process knows its own
// pid releases them: the sweep leaves every invalid-pid ticket in place.
test('legacy null-pid and damaged-owner tickets survive the sweep with either known or unknown owner pid and any ledger status', async () => {
  for (const noPid of [false, true]) {
    const id = 'job:null-pid-sibling'
    const entries = [
      { id, source: 'job-results', status: 'submitted', attempts: 1, at: '2026-10-24T12:00:00.000Z' },
      { id: 'job:pending', source: 'job-results', status: 'submitting:unresolved', attempts: 1, at: '2026-10-24T12:00:00.000Z' },
    ]
    const r = await rig({ noPid, entries })
    try {
      mkdirSync(r.admit, { recursive: true })
      const invalidPids = [null, '4242', 1.5, 0, -1]
      for (const [i, pid] of invalidPids.entries()) {
        writeFileSync(join(r.admit, `legacy-${i}.json`), JSON.stringify({ version: 1, seat: SEAT, item: id, pid, ts: '2000-01-01T00:00:00.000Z' }))
      }
      writeFileSync(join(r.admit, 'pending-legacy.json'), JSON.stringify({ version: 1, seat: SEAT, item: 'job:pending', pid: null, ts: '2000-01-01T00:00:00.000Z' }))
      writeFileSync(join(r.admit, 'no-owner.json'), JSON.stringify({ version: 1, item: id, ts: '2000-01-01T00:00:00.000Z' }))
      writeFileSync(join(r.admit, 'no-seat.json'), JSON.stringify({ version: 1, item: id, pid: null, ts: '2000-01-01T00:00:00.000Z' }))
      writeFileSync(join(r.admit, 'another-seat.json'), JSON.stringify({ seat: 'another-seat', item: id, pid: null }))
      writeFileSync(join(r.admit, 'malformed.json'), '{')
      const expected = ['another-seat.json', ...invalidPids.map((_, i) => `legacy-${i}.json`), 'malformed.json', 'no-owner.json', 'no-seat.json', 'pending-legacy.json'].sort()
      await r.tick()
      await r.tick()
      assert.deepEqual(r.tickets(), expected)
      assert.equal(r.held(id)?.status, 'submitted')
      assert.equal(r.held('job:pending')?.status, 'submitting:unresolved')
      assert.equal(r.runs.filter(argv => argv[2] === UNLINK && argv[4].endsWith('.json')).length, 0, 'no ticket unlink was attempted')
      // Retention is said once per file, not once per tick: the operator learns of the obligation from the seat itself.
      const notes = r.logs.filter(line => line.includes('admission ticket has no valid owner pid'))
      // Every readable ticket in this seat's directory is this seat's obligation, whatever its body's seat field says.
      const noted = expected.filter(name => name !== 'malformed.json')
      assert.equal(notes.length, noted.length, 'one note per retained readable ticket across two ticks')
      for (const name of noted) assert.equal(notes.filter(line => line.includes(name)).length, 1, name)
      assert.equal(notes.filter(line => line.includes('another-seat.json') && line.includes('(body names seat another-seat)')).length, 1)
      assert.deepEqual(r.submitted, [])
    } finally { r.done() }
  }
})

for (const failure of ['EPERM', 'timeout', 'throw']) {
  test(`sweep retains foreign tickets when the owner probe reports ${failure}`, async () => {
    const r = await rig()
    try {
      await r.tick() // Discover this process before faulting the foreign probe.
      mkdirSync(r.admit, { recursive: true })
      writeFileSync(join(r.admit, 'foreign.json'), JSON.stringify({ item: 'job:foreign', pid: process.pid + 1, ts: '2000-01-01T00:00:00Z' }))
      r.hooks.pidProbe = () => {
        if (failure === 'throw') throw new Error('spawn failed')
        return { exitCode: failure === 'EPERM' ? 2 : null, stderr: failure }
      }
      await r.tick()
      assert.deepEqual(r.tickets(), ['foreign.json'])
      assert.equal(r.runs.some(argv => argv[2] === UNLINK), false)
    } finally { r.done() }
  })
}

test('dead-owner sweep removes an unresolved admission regardless of age or ledger verdict', async () => {
  const id = 'job:dead'
  const r = await rig({ entries: [{ id, source: 'job-results', status: 'submitting:unresolved', at: '2026-10-24T12:00:00.000Z', attempts: 1 }] })
  try {
    r.hooks.pidProbe = pid => ({ exitCode: Number(pid) === process.pid ? 1 : 0 })
    mkdirSync(r.admit, { recursive: true })
    writeFileSync(join(r.admit, 'dead.json'), JSON.stringify({ item: id, pid: process.pid + 1, ts: '2026-10-24T12:00:00.000Z' }))
    await r.tick()
    assert.deepEqual(r.tickets(), [])
    assert.equal(r.held(id).status, 'submitting:unresolved')
  } finally { r.done() }
})

test('unreadable admission survives repeated sweeps beyond any age fuse', async () => {
  const r = await rig()
  try {
    mkdirSync(r.admit, { recursive: true })
    writeFileSync(join(r.admit, 'unreadable.json'), JSON.stringify({ item: 'job:unreadable', pid: process.pid + 1, ts: '2000-01-01T00:00:00Z' }))
    r.hooks.ticketUnreadable = true
    await r.tick()
    r.advance(24 * 60 * 60_000)
    await r.tick()
    assert.deepEqual(r.tickets(), ['unreadable.json'])
    assert.equal(r.runs.some(argv => argv[2] === UNLINK), false)
  } finally { r.done() }
})

test('invalid owner pid results never admit, and a later valid probe resumes delivery', async () => {
  const r = await rig()
  try {
    r.drop('invalid-pid', 'peer', 'wait for an actual process id')
    for (const pid of ['0', '9007199254740992', 'not-a-pid']) {
      r.hooks.ownerProbe = () => ({ exitCode: 0, stdout: pid })
      await r.tick()
      assert.deepEqual(r.submitted, [])
      assert.deepEqual(r.tickets(), [])
      assert.equal(r.held(`room:${SEAT}:invalid-pid.json`).status, 'deferred:admission-no-pid')
    }
    assert.equal(r.runs.some(argv => argv[2] === PID_DEAD || argv[2] === WRITE), false)
    delete r.hooks.ownerProbe
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.equal(r.held(`room:${SEAT}:invalid-pid.json`).attempts, 1)
  } finally { r.done() }
})

test('a job is delivered without a Room root when the owner pid is unknown', async () => {
  const r = await rig({ noRoom: true, noPid: true, jobs: [{ id: 'job-without-room', job: 'build' }] })
  try {
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.match(r.submitted[0], /job result job-without-room/)
    assert.equal(r.held('job:job-without-room').status, 'submitted')
    assert.deepEqual(r.tickets(), [])
    assert.equal(r.runs.filter(argv => argv[2] === WRITE).length, 0)
  } finally { r.done() }
})

test('eight admission tickets for one dead pid produce one probe per sweep', async () => {
  const r = await rig()
  try {
    const pid = process.pid + 1
    r.hooks.pidProbe = checked => ({ exitCode: Number(checked) === pid ? 0 : 1 })
    mkdirSync(r.admit, { recursive: true })
    for (let tick = 0; tick < 2; tick++) {
      for (let i = 0; i < 8; i++) {
        writeFileSync(join(r.admit, `dead-${i}.json`), JSON.stringify({ seat: SEAT, item: `job:dead-${i}`, pid }))
      }
      // A dead owner releases a ticket whose item field is damaged too (ESRCH is the release evidence, not the item).
      writeFileSync(join(r.admit, 'dead-no-item.json'), JSON.stringify({ seat: SEAT, pid }))
      await r.tick()
      assert.deepEqual(r.tickets(), [])
      assert.equal(r.runs.filter(argv => argv[2] === UNLINK && argv[4].endsWith('dead-no-item.json')).length, tick + 1)
      assert.equal(r.logs.filter(line => line.includes('dead-no-item.json') && line.includes('dead-owner admission without an item; removing')).length, tick + 1)
      assert.equal(r.runs.filter(argv => argv[2] === PID_DEAD && argv.at(-1) === String(pid)).length, tick + 1)
    }
  } finally { r.done() }
})

test('round19 item 1: an expired window absorbs late rejection and records its ledger outcome', async () => {
  const r = await rig({ submitTimeoutMinutes: 0.05 })
  const pending = Promise.withResolvers()
  const unhandled = []
  const listener = error => unhandled.push(error)
  process.on('unhandledRejection', listener)
  try {
    r.drop('late-window', 'peer', 'late rejection after the window')
    r.hooks.pending = pending.promise
    r.clock.after = (ms, fn) => { if (ms === 3000) queueMicrotask(fn); return { cancel() {} } }
    await r.tick()
    assert.equal(r.held(`room:${SEAT}:late-window.json`).status, 'submitting:unresolved')
    pending.reject(new Error('late window rejection'))
    for (let i = 0; i < 100 && r.tickets().length; i++) await sleep(50)
    await sleep(50)
    assert.deepEqual(unhandled, [])
    assert.equal(r.ledger()[`room:${SEAT}:late-window.json`], 'deferred:submit-rejected')
  } finally {
    process.removeListener('unhandledRejection', listener)
    r.done()
  }
})



// Round 20 uses isolated module state; the normal rig still imports register.ts directly.
const flush20 = async () => { for (let i = 0; i < 100; i++) await Promise.resolve() }
const event20 = (file = 'a.json', extra = {}) => ({ origin: { kind: 'peer' }, text: `Room mail for testseat from peer: ${file}`, ...extra })
const invoke20 = (r, name, event = {}, next = async () => ({})) => r.handlers[name](r.engine, event, next)
const until20 = async predicate => {
  for (let i = 0; i < 200 && !predicate(); i++) await sleep(10)
  assert.ok(predicate(), 'expected state reached')
}

test('round24 item 1 / D: UNKNOWN b leaves UNREAD a admitted in MIXED mail', async () => {
  const r = await rig({ inspect: true })
  try {
    r.inspection.suppressTick()
    r.drop('a', 'peer', 'hello')
    const exists = r.engine.fs.exists
    r.engine.fs.exists = p => p.endsWith('/b.json') ? Promise.reject(Error('sample failed')) : exists(p)
    const pointers = `${event20().text}\n${event20('b.json').text}`
    const event = event20('a.json', { text: `Please reply.\n${pointers}` })
    const result = await invoke20(r, 'prompt.submit', event, async e => { assert.equal(e, event); return { text: e.text } })
    assert.equal(result.text, event.text)
    assert.deepEqual([...r.inspection.admissionTurns.keys()], ['a.json'])
    assert.match((await invoke20(r, 'prompt.submit', event20('a.json', { text: pointers }))).drop, /UNKNOWN/)
  } finally { r.done() }
})

test('round24 item 2 / E: serialization orders claims and samples; ownership persists until released', async t => {
  await t.test('round26 item 1 / E: an admitted pointer blocks the queued claim and delivers only once', async () => {
    const r = await rig({ inspect: true })
    const deferred = Promise.withResolvers()
    let prompt, claim
    try {
      r.inspection.suppressTick()
      r.drop('a', 'peer', 'hello')
      const exists = r.engine.fs.exists
      const order = []
      r.engine.fs.exists = async p => {
        const present = await exists(p)
        if (p.endsWith('/inbox/testseat/a.json')) { order.push('sample'); await deferred.promise; order.push('sample done') }
        return present
      }
      let deliveries = 0
      prompt = invoke20(r, 'prompt.submit', event20(), async () => { deliveries++; return {} })
      await until20(() => order.includes('sample'))
      deferred.resolve()
      await prompt
      claim = r.inspection.claim(r.engine, r.where, { id: 'room:testseat:a.json', source: 'room' }).then(result => { order.push('claim done'); return result })
      assert.equal(await claim, 'admitted')
      assert.deepEqual(order, ['sample', 'sample done', 'claim done'])
      assert.deepEqual(r.inbox(), ['a.json'])
      assert.deepEqual(r.claimed(), [])
      r.inspection.resumeTick()
      await r.inspection.tick(r.engine)
      assert.ok(r.inspection.admissionTurns.has('a.json'))
      assert.deepEqual(r.inbox(), ['a.json'])
      assert.equal(deliveries + r.submitted.length, 1)
    } finally { deferred.resolve(); await Promise.allSettled([prompt, claim]); r.done() }
  })
  await t.test('b: externally restored file stays CLAIMED until the session edge clears ownership', async () => {
    const r = await rig({ inspect: true })
    try {
      r.inspection.suppressTick()
      r.drop('a', 'peer', 'hello')
      await r.inspection.claim(r.engine, r.where, { id: 'room:testseat:a.json', source: 'room' })
      rmSync(join(r.where.root, '..', 'room', 'claimed', SEAT, 'a.json'))
      r.drop('a', 'peer', 'restored')
      let samples = 0
      const exists = r.engine.fs.exists
      r.engine.fs.exists = p => { if (/\/(inbox|claimed)\/testseat\/a.json$/.test(p)) samples++; return exists(p) }
      assert.match((await invoke20(r, 'prompt.submit', event20())).drop, /CLAIMED/)
      assert.equal(r.inspection.admissionTurns.has('a.json'), false)
      assert.equal(samples, 2)
      await invoke20(r, 'session.end')
      assert.equal((await invoke20(r, 'prompt.submit', event20())).drop, undefined)
      assert.ok(r.inspection.admissionTurns.has('a.json'))
    } finally { r.done() }
  })
  await t.test('c: absent re-claim releases previous ownership and reads GONE', async () => {
    const r = await rig({ inspect: true })
    try {
      r.inspection.suppressTick()
      const item = { id: 'room:testseat:a.json', source: 'room' }
      r.drop('a', 'peer', 'hello')
      assert.equal(await r.inspection.claim(r.engine, r.where, item), 'moved')
      rmSync(join(r.where.root, '..', 'room', 'claimed', SEAT, 'a.json'))
      assert.equal(await r.inspection.claim(r.engine, r.where, item), 'absent')
      assert.equal(r.inspection.tickOwned.has('a.json'), false)
      assert.match((await invoke20(r, 'prompt.submit', event20())).drop, /GONE/)
    } finally { r.done() }
  })
})

test('round24 item 3 / J: window two after refusal on an idle seat returns timeout promptly', async () => {
  const r = await rig({ inspect: true })
  const pending = Promise.withResolvers()
  let done
  try {
    const timers = []
    let calls = 0, result
    r.clock.after = (ms, fire) => {
      if (++calls === 2) throw Error('window two unavailable')
      timers.push({ ms, fire })
      return { cancel() {} }
    }
    done = r.inspection.waitForSubmit(r.engine, () => pending.promise).then(value => { result = value })
    await invoke20(r, 'turn.start', { turnId: 'brief' })
    r.inspection.suppressTick()
    await invoke20(r, 'turn.complete', { turnId: 'brief' })
    timers[0].fire()
    await flush20()
    assert.equal(calls, 2)
    assert.equal(result, 'timeout')
    assert.equal(r.inspection.turnEndWaiters.size, 0)
  } finally { pending.resolve('cleanup'); await done; r.done() }
})

test('round24 item 4 / H: seventy throws without catch replay release capacity at completion', async () => {
  const r = await rig({ inspect: true })
  try {
    r.inspection.suppressTick()
    r.drop('a', 'peer', 'hello')
    for (let i = 0; i < 70; i++) {
      const turnId = `turn-${i}`
      await invoke20(r, 'turn.start', { turnId })
      await assert.rejects(invoke20(r, 'prompt.submit', event20('a.json', { turnId }), async () => { throw Error('downstream') }))
      await invoke20(r, 'turn.complete', { turnId })
    }
    assert.equal(r.inspection.promptAdmissions.size, 0)
    await invoke20(r, 'prompt.submit', event20())
    assert.ok(r.inspection.admissionTurns.has('a.json'), '71st pointer still binds')
    assert.equal(r.logs.filter(line => line.includes('cap 64')).length, 0)
    // Overflow warns once, including after a session edge restores capacity.
    for (const edge of ['session.end', 'session.start']) {
      for (let i = 0; i < 66; i++) {
        const attempt = invoke20(r, 'prompt.submit', event20(), async () => { throw Error('downstream') })
        if (i < 64) await assert.rejects(attempt)
        else assert.match((await attempt).drop, /cap 64/)
      }
      assert.equal(r.inspection.promptAdmissions.size, 64)
      assert.equal(r.logs.filter(line => line.includes('cap 64')).length, 1)
      await invoke20(r, edge)
      assert.equal(r.inspection.promptAdmissions.size, 0)
    }
  } finally { r.done() }
})

test('round24 item 5: other-seat and unresolved-seat drop logs name every pointer', async () => {
  for (const unresolved of [false, true]) {
    const r = await rig({ inspect: true, ...(unresolved ? { seat: 'INVALID!' } : {}) })
    try {
      const text = 'Room mail for other from peer: a.json\nRoom mail for third from peer: b.json'
      const result = await invoke20(r, 'prompt.submit', event20('a.json', { text }))
      assert.match(result.drop, unresolved ? /seat unresolved/ : /another seat/)
      assert.ok(r.logs.some(line => line.includes('room:other:a.json') && line.includes('room:third:b.json')))
    } finally { r.done() }
  }
})

test('round24 item 6 / G: private releaseAdmissions is driven by turn.complete', async () => {
  const r = await rig({ inspect: true })
  try {
    r.inspection.suppressTick()
    r.drop('a', 'peer', 'hello')
    await invoke20(r, 'turn.start', { turnId: 'bound' })
    await invoke20(r, 'prompt.submit', event20('a.json', { turnId: 'bound' }))
    await invoke20(r, 'turn.complete', { turnId: 'other' })
    assert.ok(r.inspection.admissionTurns.has('a.json'))
    await invoke20(r, 'turn.complete', { turnId: 'bound' })
    assert.equal(r.inspection.admissionTurns.size, 0)
  } finally { r.done() }
})

test('round25 B: CRLF framing and ordinary mail retain their classification', async () => {
  const { pointerOnly } = await import('../hooks/register.ts')
  assert.equal(pointerOnly(`Another Claude session sent a message:\r\n${event20().text}`), true)
  assert.equal(pointerOnly(`Another Claude session sent a message:\r\nPlease reply\r\n${event20().text}`), false)
})

test('round23 item 1 / B: ordinary prose is MIXED and known engine framings are BARE', async () => {
  const { pointerOnly } = await import('../hooks/register.ts')
  const r = await rig({ inspect: true })
  try {
    for (const lead of ['Reply from beta: yes go ahead', 'Got your message, shipping now', 'Thanks from pheme', 'Approved - proceed with the deploy from main']) {
      const event = event20('gone.json', { text: `${lead}\n${event20('gone.json').text}` })
      assert.equal(pointerOnly(event.text), false, lead)
      assert.deepEqual(await invoke20(r, 'prompt.submit', event, async e => { assert.equal(e, event); return { text: e.text } }), { text: event.text })
    }
    for (const lead of ['Another Claude session sent a message', '[Cross-session message]:']) {
      const event = event20('gone.json', { text: `${lead}\n${event20('gone.json').text}` })
      assert.equal(pointerOnly(event.text), true, lead)
      assert.match((await invoke20(r, 'prompt.submit', event)).drop, /GONE/)
    }
  } finally { r.done() }
})

test('round23 item 2 / D: UNKNOWN samples and thrown checks enter MIXED but drop BARE', async () => {
  const r = await rig({ inspect: true })
  try {
    r.drop('a', 'peer', 'hello')
    r.freeze()
    const exists = r.engine.fs.exists
    for (const thrown of [false, true]) for (const mixed of [true, false]) {
      let failures = 0
      r.engine.fs.exists = p => {
        if (p.replaceAll('\\', '/').endsWith('/claimed/testseat/a.json')) {
          failures++
          if (thrown) throw Error('synchronous check failure')
          return Promise.reject(Error('unreadable sample'))
        }
        return exists(p)
      }
      const event = event20('a.json', { text: `${mixed ? 'Please reply.\n' : ''}${event20().text}` })
      let entered = 0
      const result = await invoke20(r, 'prompt.submit', event, async e => { entered++; assert.equal(e, event); return { text: e.text } })
      assert.equal(failures, 1)
      assert.equal(entered, mixed ? 1 : 0)
      if (mixed) assert.deepEqual(result, { text: event.text })
      else assert.match(result.drop, thrown ? /check failed/ : /UNKNOWN/)
    }
  } finally { r.done() }
})

test('round23 item 3 / J: idle deadline-arm failure times out promptly and releases the tick', async () => {
  const r = await rig({ inspect: true })
  const pending = Promise.withResolvers()
  try {
    r.clock.after = () => { throw Error('deadline unavailable') }
    let result
    void r.inspection.waitForSubmit(r.engine, () => new Promise(() => {})).then(value => { result = value })
    await flush20()
    assert.equal(result, 'timeout')
    assert.equal(r.inspection.turnEndWaiters.size, 0)
    r.hooks.pending = pending.promise
    r.drop('a', 'peer', 'hello')
    await invoke20(r, 'turn.complete', { turnId: 'idle' })
    await until20(() => r.ledger()['room:testseat:a.json'] === 'submitting:unresolved' && !r.inspection.runtime().isTicking)
    assert.equal(r.tickets().length, 1)
    pending.resolve({})
    await until20(() => r.ledger()['room:testseat:a.json'] === 'submitted' && !r.tickets().length)
  } finally { pending.resolve({}); r.done() }
})



test('round23 item 5: both session edges clear all turn state before waking waiters', async () => {
  for (const edge of ['start', 'end']) {
    const r = await rig({ inspect: true })
    try {
      const h = r.inspection
      h.suppressTick()
      await invoke20(r, 'turn.start', { turnId: 'busy' })
      r.drop('a', 'peer', 'hello')
      const event = event20()
      await assert.rejects(invoke20(r, 'prompt.submit', event, async () => { throw Error('pending replay') }))
      h.tickOwned.add('settled.json')
      let wakes = 0
      const wake = reset => {
        wakes++
        assert.equal(reset, edge === 'end')
        assert.equal(h.mainTurns.size, 0)
        assert.equal(h.admissionTurns.size, 0)
        assert.equal(h.promptAdmissions.size, 0)
        assert.equal(h.token(event), undefined)
        assert.equal(h.tickOwned.has('settled.json'), false)
      }
      h.turnEndWaiters.add(wake)
      await invoke20(r, `session.${edge}`)
      assert.equal(wakes, 1)
      h.turnEndWaiters.delete(wake)
    } finally { r.done() }
  }
})



test('round20 item 1: later after refusal preserves pending ticket and engine settlement', async () => {
  for (const refusal of [1, 2]) {
    const r = await rig({ inspect: true, submitTimeoutMinutes: 0.05 })
    const pending = Promise.withResolvers()
    try {
      const timers = []
      let calls = 0
      r.clock.after = (ms, run) => {
        if (++calls === refusal) throw new Error('clock refused')
        const timer = { ms, run, cancelled: false }
        timers.push(timer)
        return { cancel() { timer.cancelled = true } }
      }
      r.hooks.pending = pending.promise
      r.drop('a', 'peer', 'hello')
      await invoke20(r, 'turn.complete')
      await until20(() => r.submitted.length === 1)
      if (refusal === 2) {
        await invoke20(r, 'turn.start', { turnId: 't1' })
        await invoke20(r, 'turn.complete', { turnId: 'other' })
        timers.find(t => t.ms === 3000).run()
      }
      await flush20()
      if (refusal === 1) await until20(() => !r.inspection.runtime().isTicking)
      assert.equal(r.held('room:testseat:a.json').status, refusal === 1 ? 'submitting:unresolved' : 'submitting')
      assert.equal(r.tickets().length, 1)
      pending.resolve({})
      await until20(() => r.ledger()['room:testseat:a.json'] === 'submitted' && !r.tickets().length)
      assert.deepEqual(r.inbox(), [])
      assert.ok(!r.runs.some(a => a[2] === MOVE && a.at(-1).replaceAll('\\', '/').includes('/inbox/')))
      assert.doesNotMatch(r.logText(), /submit-rejected/)
      if (refusal === 1) assert.match(r.logText(), /submitting:unresolved/)
      else assert.doesNotMatch(r.logText(), /submitting:unresolved/)
    } finally { pending.resolve({}); await flush20(); r.done() }
  }
})

test('round21 J: session end bounds discarded submit and frees the tick', async () => {
  for (const inTurn of [false, true]) {
    const r = await rig({ inspect: true, submitTimeoutMinutes: 0.05 })
    const pending = Promise.withResolvers()
    try {
      const timers = []
      r.clock.after = (ms, run) => { const t = { run, cancelled: false }; timers.push(t); return { cancel() { t.cancelled = true } } }
      if (inTurn) await invoke20(r, 'turn.start', { turnId: 't1' })
      r.hooks.pending = pending.promise
      r.drop('a', 'testseat-supervisor', LEG)
      await invoke20(r, 'turn.complete', { turnId: 'other' })
      await until20(() => r.submitted.length === 1)
      await invoke20(r, 'session.end')
      await flush20()
      const armed = timers.length
      r.advance(3 * 60 * 60_000)
      for (const t of timers) if (!t.cancelled) { t.run(); await flush20() }
      await until20(() => r.ledger()['room:testseat:a.json'] === 'submitting:unresolved' && !r.inspection.runtime().isTicking)
      assert.equal(timers.length, armed)
      assert.equal(r.tickets().length, 1)
      pending.resolve({ drop: 'engine discarded at clear' })
      await until20(() => r.ledger()['room:testseat:a.json'] === 'dropped' && !r.tickets().length)
      assert.match(r.logText(), /submitting:unresolved/)
    } finally { pending.resolve({}); await flush20(); r.done() }
  }
})

test('round22 item 1: session.start immediately wakes a lifecycle leg parked in turn WAIT', async () => {
  const r = await rig({ inspect: true, submitTimeoutMinutes: 0.05 })
  const pending = Promise.withResolvers()
  try {
    const timers = []
    r.clock.after = (ms, run) => {
      const t = { ms, run, cancelled: false }; timers.push(t)
      return { cancel() { t.cancelled = true } }
    }
    await invoke20(r, 'turn.start', { turnId: 'lost-turn' })
    r.hooks.pending = pending.promise
    r.drop('a', 'testseat-supervisor', LEG)
    await invoke20(r, 'turn.complete', { turnId: 'other' })
    await until20(() => r.submitted.length === 1)
    assert.deepEqual(timers.map(t => t.ms), [3600000])
    assert.equal(r.inspection.runtime().isTicking, true)
    await invoke20(r, 'session.start')
    await flush20()
    assert.deepEqual(timers.filter(t => !t.cancelled).map(t => t.ms), [3600000, 3000], 'session.start leaves WAIT for a full window and retains the turn-WAIT deadline')
    timers.at(-1).run()
    await until20(() => r.ledger()['room:testseat:a.json'] === 'submitting:unresolved' && !r.inspection.runtime().isTicking)
    pending.resolve({ drop: 'discarded at reload' })
    await until20(() => !r.tickets().length)
  } finally {
    pending.resolve({}); await flush20()
    await until20(() => !r.inspection.runtime().isTicking)
    r.done()
  }
})

test('round22 item 4: MIXED mail quoting only GONE or CLAIMED files enters despite both holds', async () => {
  const r = await rig({ inspect: true, cycle: 'clearing' })
  try {
    r.freeze()
    const reads = []
    const read = r.engine.fs.read
    r.engine.fs.read = async path => { reads.push(path.replaceAll('\\', '/')); return read(path) }
    for (const claimed of [false, true]) {
      if (claimed) r.inspection.tickOwned.add('gone.json')
      const event = event20('gone.json', { text: `Ordinary mail.\n${event20('gone.json').text}` })
      const result = await invoke20(r, 'prompt.submit', event, async e => { assert.equal(e, event); return { text: e.text } })
      assert.equal(result.text, event.text)
      assert.equal(reads.some(p => p.endsWith('/auto-clear-cycle.json')), false)
      assert.equal(reads.some(p => p.includes('/state/holds/')), false)
    }
  } finally { r.done() }
})


test('round20 item 3: unbound P1 survives completion of same-file bound P2', async () => {
  const r = await rig({ inspect: true })
  try {
    r.inspection.suppressTick()
    r.drop('a', 'peer', 'hello')
    await invoke20(r, 'turn.start', { turnId: 't1' })
    await invoke20(r, 'prompt.submit', event20())
    await invoke20(r, 'prompt.submit', event20('a.json', { turnId: 't1' }))
    await invoke20(r, 'turn.complete', { turnId: 't1' })
    assert.ok(r.inspection.admissionTurns.has('a.json'))
    await invoke20(r, 'turn.start', { turnId: 't2' })
    await invoke20(r, 'turn.complete', { turnId: 't2' })
    assert.equal(r.inspection.admissionTurns.size, 0)
  } finally { r.done() }
})

test('round20 item 4: start and end clear live prompt tracking and reset cap capacity', async () => {
  const r = await rig({ inspect: true })
  try {
    r.inspection.suppressTick()
    r.drop('a', 'peer', 'hello')
    r.engine.command.register = async () => {}
    for (const boundary of ['session.end', 'session.start']) {
      const event = event20()
      void invoke20(r, 'prompt.submit', event, () => new Promise(() => {}))
      await flush20()
      assert.equal(r.inspection.promptAdmissions.size, 1)
      await invoke20(r, boundary)
      assert.equal(r.inspection.promptAdmissions.size, 0)
      assert.equal(r.inspection.token(event), undefined)
    }
    for (let i = 0; i < 64; i++) {
      void invoke20(r, 'prompt.submit', event20(), () => new Promise(() => {}))
      await flush20()
    }
    assert.equal(r.inspection.promptAdmissions.size, 64)
    assert.ok(!r.logs.some(line => line.includes('cap 64')))
  } finally { r.done() }
})

test('round20 item 5: seventy mixed prompts with no admits consume no cap entries', async () => {
  const r = await rig({ inspect: true })
  try {
    for (let i = 0; i < 70; i++) {
      const event = event20('gone.json', { text: `Ordinary mixed mail\n${event20('gone.json').text}` })
      void invoke20(r, 'prompt.submit', event, () => new Promise(() => {}))
      await flush20()
      assert.equal(r.inspection.token(event), undefined)
    }
    assert.equal(r.inspection.promptAdmissions.size, 0)
    assert.ok(!r.logs.some(line => line.includes('cap 64')))
  } finally { r.done() }
})

test('round20 item 6: blocked duplicate claim clears ownership while disk still reads CLAIMED', async () => {
  const r = await rig({ inspect: true })
  try {
    const item = { id: 'room:testseat:a.json', source: 'room' }
    r.drop('a', 'peer', 'first')
    assert.equal(await r.inspection.claim(r.engine, r.where, item), 'moved')
    r.drop('a', 'peer', 'rewritten')
    assert.equal(await r.inspection.claim(r.engine, r.where, item), 'blocked')
    assert.equal(r.inspection.tickOwned.has('a.json'), false)
    assert.match((await invoke20(r, 'prompt.submit', event20())).drop, /CLAIMED/)
  } finally { r.done() }
})

test('round20 item 8: a running turn arms only the total deadline', async () => {
  const r = await rig({ inspect: true })
  const pending = Promise.withResolvers()
  try {
    const windows = []
    r.clock.after = (ms, run) => { windows.push(ms); return { cancel() {} } }
    await invoke20(r, 'turn.start', { turnId: 't1' })
    r.hooks.pending = pending.promise
    r.drop('a', 'testseat-supervisor', LEG)
    await invoke20(r, 'turn.complete', { turnId: 'other' })
    await until20(() => r.submitted.length === 1)
    assert.deepEqual(windows, [60 * 60_000])
  } finally {
    pending.resolve({})
    await until20(() => r.ledger()['room:testseat:a.json'] === 'submitted' && !r.tickets().length)
    r.done()
  }
})


test('round21 item 1 / J: full windows, six-window cap, and immediate session teardown', async () => {
  const r = await rig({ inspect: true, submitTimeoutMinutes: 10 })
  try {
    const h = r.inspection
    const run = async ({ busy = true, failAt = 0 } = {}) => {
      h.mainTurns.clear()
      if (busy) h.mainTurns.add('t1')
      const timers = []
      let calls = 0, result
      const pending = Promise.withResolvers()
      r.clock.after = (ms, fire) => {
        if (++calls === failAt) throw Error('clock unavailable')
        const t = { ms, fire, cancelled: false }; timers.push(t)
        return { cancel() { t.cancelled = true } }
      }
      const done = h.waitForSubmit(r.engine, () => pending.promise).then(value => { result = value })
      const wake = (end = false) => { if (end) h.mainTurns.clear(); for (const w of h.turnEndWaiters) w(end) }
      return { timers, pending, done, wake, result: () => result }
    }
    // A 59:50 completion grants ten full minutes even as the WAIT deadline fires.
    let q = await run()
    q.wake(); await flush20()
    assert.deepEqual(q.timers.map(t => t.ms), [3600000, 600000])
    q.timers[0].fire(); await flush20()
    assert.equal(q.result(), undefined)
    q.timers[1].fire(); await flush20()
    assert.equal(q.result(), 'timeout')
    await q.done
    // Initial window plus five completion windows, including simultaneous wakes.
    q = await run({ busy: false })
    for (let i = 0; i < 10; i++) q.wake()
    for (let i = 0; i < 6; i++) { q.timers[i].fire(); await flush20() }
    assert.equal(q.result(), 'timeout')
    assert.deepEqual(q.timers.map(t => t.ms), Array(6).fill(600000))
    await q.done
    for (const busy of [false, true]) {
      q = await run({ busy }); q.wake(true); await flush20()
      assert.equal(q.result(), 'timeout')
      assert.deepEqual(q.timers.filter(t => !t.cancelled), [])
      await q.done
    }
    for (const failAt of [1, 2, 3]) {
      q = await run({ busy: false, failAt })
      for (let arm = 2; arm <= failAt; arm++) { q.wake(); q.timers[arm - 2].fire(); await flush20() }
      q.wake(true); await flush20()
      assert.equal(q.result(), 'timeout')
      await q.done
    }
  } finally { r.done() }
})



test('round22 item 2 / B: only known engine lead-ins are BARE', async () => {
  const { pointerOnly } = await import('../hooks/register.ts')
  const pointer = event20().text
  const leads = ['Another Claude session sent a message', 'Task notification', '[Cross-session message]:']
  for (const lead of leads) {
    assert.equal(pointerOnly(`${lead}\n${pointer}`), true)
  }
  for (const lead of ['Another Claude session (pheme) sent a message:', '[Cross-session message from pheme-2]:', 'x'.repeat(111) + ' message:', 'FYI:', 'x'.repeat(112) + ' message:', 'Message from a.json:', '[Cross-session message from pheme-2]']) {
    assert.equal(pointerOnly(`${lead}\n${pointer}`), false)
  }
  const r = await rig({ inspect: true })
  try {
    for (const lead of leads) for (const seat of ['testseat', 'other']) {
      const event = event20('gone.json', { text: `${lead}\nRoom mail for ${seat} from peer: gone.json` })
      const result = await invoke20(r, 'prompt.submit', event, async () => { assert.fail('BARE pointer must drop') })
      assert.match(result.drop, seat === 'testseat' ? /GONE/ : /another seat/)
    }
    const event = event20('gone.json', { text: `FYI:\n${event20('gone.json').text}` })
    const result = await invoke20(r, 'prompt.submit', event, async e => { assert.equal(e, event); return { text: e.text } })
    assert.equal(result.text, event.text)
  } finally { r.done() }
})


test('FENCE G: completion preserves other bound turns and new unbound admissions', async () => {
  const r = await rig({ inspect: true })
  try {
    r.inspection.suppressTick()
    await invoke20(r, 'turn.start', { turnId: 'reading' })
    await invoke20(r, 'turn.start', { turnId: 'unrelated' })
    const bindings = r.inspection.admissionTurns
    bindings.set('bound', new Set([{ seq: 0, turnId: 'reading', token: 'bound' }]))
    bindings.set('old', new Set([{ seq: 1, token: 'old' }]))
    bindings.set('queued', new Set([{ seq: 2, token: 'queued' }]))
    await invoke20(r, 'turn.complete', { turnId: 'unrelated' })
    assert.deepEqual([...bindings.keys()], ['bound', 'queued'])
    await invoke20(r, 'turn.complete', { turnId: 'reading' })
    assert.deepEqual([...bindings.keys()], ['queued'])
    await invoke20(r, 'turn.complete', { turnId: 'lost-unbound-start' })
    assert.equal(bindings.size, 0)
  } finally { r.done() }
})





test('round25 item 1: marks before samples read CLAIMED and bound samples block queued claims', async () => {
  const r = await rig({ inspect: true })
  const sample = Promise.withResolvers()
  let prompt, claim
  try {
    r.inspection.suppressTick()
    r.drop('a', 'peer', 'hello')
    const exists = r.engine.fs.exists
    let sampling = false
    assert.equal(await r.inspection.claim(r.engine, r.where, { id: 'room:testseat:a.json', source: 'room' }), 'moved')
    prompt = invoke20(r, 'prompt.submit', event20())
    assert.match((await prompt).drop, /CLAIMED/)
    // Bookkeeping wins even when both disk samples falsely report inbox-only.
    r.engine.fs.exists = p => /\/(inbox|claimed)\/testseat\/a.json$/.test(p) ? Promise.resolve(p.includes('/inbox/')) : exists(p)
    assert.match((await invoke20(r, 'prompt.submit', event20())).drop, /CLAIMED/)
    r.drop('b', 'peer', 'second')
    r.engine.fs.exists = async p => {
      const present = await exists(p)
      if (p.endsWith('/inbox/testseat/b.json')) { sampling = true; await sample.promise }
      return present
    }
    prompt = invoke20(r, 'prompt.submit', event20('b.json'))
    await until20(() => sampling)
    const run = r.engine.process.run
    r.engine.process.run = async args => {
      assert.ok(!args.includes(MOVE), 'an admitted file never reaches the mover')
      return run(args)
    }
    sample.resolve()
    assert.equal((await prompt).drop, undefined)
    claim = r.inspection.claim(r.engine, r.where, { id: 'room:testseat:b.json', source: 'room' })
    assert.equal(await claim, 'admitted')
    assert.ok(r.inspection.admissionTurns.has('b.json'))
    assert.ok(r.inbox().includes('b.json'))
  } finally { sample.resolve(); await Promise.allSettled([prompt, claim]); r.done() }
})

test('round25 item 2: generic lead-in is MIXED for GONE and UNREAD with either hold state', async () => {
  const r = await rig({ inspect: true })
  try {
    r.inspection.suppressTick()
    const generic = file => event20(file, { text: `Here is what I got from the session:\n${event20(file).text}` })
    const next = async e => ({ text: e.text })
    assert.deepEqual(await invoke20(r, 'prompt.submit', generic('gone.json'), next), { text: generic('gone.json').text })
    assert.match((await invoke20(r, 'prompt.submit', event20('gone.json', { text: `Another Claude session sent a message:\n${event20('gone.json').text}` }), next)).drop, /GONE/)
    r.drop('a', 'peer', 'hello')
    r.freeze()
    assert.deepEqual(await invoke20(r, 'prompt.submit', generic('a.json'), next), { text: generic('a.json').text })
    assert.equal(r.inspection.admissionTurns.size, 0)
    r.thaw()
    assert.deepEqual(await invoke20(r, 'prompt.submit', generic('a.json'), next), { text: generic('a.json').text })
    assert.ok(r.inspection.admissionTurns.has('a.json'))
  } finally { r.done() }
})

test('round25 item 3: 65th pointer drops with the cap reason and the tick delivers its file', async () => {
  const r = await rig({ inspect: true })
  const pending = Promise.withResolvers(), calls = []
  try {
    r.inspection.suppressTick()
    r.drop('a', 'peer', 'tracked')
    r.drop('overflow', 'peer', 'overflow')
    for (let i = 0; i < 64; i++) {
      calls.push(invoke20(r, 'prompt.submit', event20(), () => pending.promise))
      await flush20()
    }
    let forwarded = 0
    for (let i = 0; i < 2; i++) {
      const result = await invoke20(r, 'prompt.submit', event20('overflow.json'), async () => { forwarded++; return {} })
      assert.match(result.drop, /promptAdmissions cap 64/)
    }
    assert.equal(forwarded, 0)
    assert.equal(r.logs.filter(line => line.includes('cap 64')).length, 1)
    assert.equal(r.inspection.admissionTurns.has('overflow.json'), false)
    pending.resolve({ drop: 'tracked dropped' })
    await Promise.all(calls)
    r.inspection.resumeTick()
    await r.tick()
    await r.tick()
    assert.ok(r.processed().includes('overflow.json'))
  } finally { pending.resolve({ drop: 'cleanup' }); await Promise.all(calls); r.done() }
})

test('round25 item 4: claim bookkeeping follows landed status without a finally disk read', async () => {
  const r = await rig({ inspect: true })
  try {
    r.inspection.suppressTick()
    r.drop('a', 'peer', 'hello')
    const item = { id: 'room:testseat:a.json', source: 'room' }
    assert.equal(await r.inspection.claim(r.engine, r.where, item), 'moved')
    assert.ok(r.inspection.tickOwned.has('a.json'))
    const exists = r.engine.fs.exists
    let claimedReads = 0
    r.engine.fs.exists = p => { if (p.endsWith('/claimed/testseat/a.json')) claimedReads++; return exists(p) }
    assert.equal(await r.inspection.claim(r.engine, r.where, item), 'blocked')
    assert.equal(claimedReads, 1, 'only the destination precheck reads claimed/')
    assert.equal(r.inspection.tickOwned.has('a.json'), false, 'a blocked attempt did not move this file')
    rmSync(join(r.where.root, '..', 'room', 'claimed', SEAT, 'a.json'))
    claimedReads = 0
    assert.equal(await r.inspection.claim(r.engine, r.where, item), 'absent')
    assert.equal(claimedReads, 2, 'destination precheck plus post-failure sample only')
    assert.equal(r.inspection.tickOwned.has('a.json'), false)
  } finally { r.done() }
})

test('round25 item 6: only peer prompts mint tokens and session-end reset clears their bindings', async () => {
  const r = await rig({ inspect: true })
  try {
    r.inspection.suppressTick()
    const before = r.inspection.runtime().promptSeq
    await invoke20(r, 'prompt.submit', event20('a.json', { origin: { kind: 'composer' } }))
    assert.equal(r.inspection.runtime().promptSeq, before)
    r.drop('a', 'peer', 'hello')
    await invoke20(r, 'prompt.submit', event20())
    const bindings = [...r.inspection.admissionTurns.get('a.json')]
    assert.equal(bindings.length, 1)
    assert.equal(bindings[0].token, String(before + 1))
    r.inspection.resetTurnState('end')
    assert.equal(r.inspection.admissionTurns.size, 0)
  } finally { r.done() }
})


test('round26 item 3: abandoned hook cannot bind or call next after its sample resolves', async () => {
  const r = await rig({ inspect: true })
  const sample = Promise.withResolvers()
  let prompt
  try {
    r.inspection.suppressTick()
    r.drop('a', 'peer', 'hello')
    const exists = r.engine.fs.exists
    let sampling = false, calls = 0
    r.engine.fs.exists = async p => {
      const present = await exists(p)
      if (p.endsWith('/inbox/testseat/a.json')) { sampling = true; await sample.promise }
      return present
    }
    const event = Object.freeze(event20())
    prompt = invoke20(r, 'prompt.submit', event, async () => { calls++; return {} })
    await until20(() => sampling)
    const caughtNext = Object.assign(async () => { calls++; return {} }, { called: false })
    const caught = await r.catches['prompt.submit'](r.engine, event, caughtNext)
    assert.match(caught.drop, /did not finish/)
    sample.resolve()
    await prompt
    assert.equal(r.inspection.admissionTurns.size, 0)
    assert.equal(r.inspection.promptAdmissions.size, 0)
    assert.equal(calls, 0)
    assert.deepEqual(r.inbox(), ['a.json'])
  } finally { sample.resolve(); await prompt; r.done() }
})

test('round26 item 4: session.start wakes WAIT without ending the submit windows', async () => {
  const r = await rig({ inspect: true, submitTimeoutMinutes: 0.05 })
  const pending = Promise.withResolvers()
  try {
    const timers = []
    r.clock.after = (ms, run) => {
      const timer = { ms, run, cancelled: false }; timers.push(timer)
      return { cancel() { timer.cancelled = true } }
    }
    await invoke20(r, 'turn.start', { turnId: 'lost-turn' })
    r.hooks.pending = pending.promise
    r.drop('a', 'testseat-supervisor', LEG)
    await invoke20(r, 'turn.complete', { turnId: 'other' })
    await until20(() => r.submitted.length === 1)
    assert.equal(r.inspection.turnEndWaiters.size, 1)
    await invoke20(r, 'session.start')
    await flush20()
    assert.ok(timers.some(t => t.ms === 3000 && !t.cancelled), 'WAIT leaves for a submit window')
    // A new main turn spans that window; its completion grants the next one.
    await invoke20(r, 'turn.start', { turnId: 'new-turn' })
    await invoke20(r, 'turn.complete', { turnId: 'new-turn' })
    timers.find(t => t.ms === 3000).run()
    await flush20()
    assert.equal(timers.filter(t => t.ms === 3000).length, 2, 'start must not force a final window')
    assert.doesNotMatch(r.logText(), /submitting:unresolved/)
    pending.resolve({})
    await until20(() => r.processed().includes('a.json') && !r.inspection.runtime().isTicking)
    assert.equal(r.submitted.length, 1)
    assert.equal(r.inspection.turnEndWaiters.size, 0)
    assert.doesNotMatch(r.logText(), /submitting:unresolved/)
  } finally {
    pending.resolve({}); await flush20()
    await until20(() => !r.inspection.runtime().isTicking)
    r.done()
  }
})

test('round26 item 5: both mutex queues preserve FIFO results and rejection recovery', async () => {
  const r = await rig({ inspect: true })
  try {
    assert.equal(typeof r.inspection.mutex, 'function', 'one shared promiseMutex factory')
    for (const serial of [r.inspection.serialMarker, r.inspection.serialized]) {
      const first = Promise.withResolvers(), order = []
      const failure = Error('caller must receive this')
      const a = serial(async () => { order.push('first'); await first.promise; throw failure })
      const rejected = assert.rejects(a, error => error === failure)
      const b = serial(async () => { order.push('second'); return 42 })
      await flush20()
      assert.deepEqual(order, ['first'])
      first.resolve()
      await rejected
      assert.equal(await b, 42)
      assert.deepEqual(order, ['first', 'second'])
    }
  } finally { r.done() }
})

test('round27 item 1: post-bind abandonment releases the token and cap entry before dropping', async () => {
  const r = await rig({ inspect: true })
  try {
    r.inspection.suppressTick()
    r.drop('a', 'peer', 'hello')
    for (const viaCatch of [false, true]) {
      const event = Object.freeze(event20())
      let calls = 0
      const admissions = r.inspection.promptAdmissions
      const set = admissions.set.bind(admissions)
      admissions.set = (token, admission) => {
        set(token, admission)
        const check = r.inspection.pointerChecks.get(event) ?? r.inspection.pointerChecks.get(token)
        queueMicrotask(() => {
          if (viaCatch) {
            r.catches['prompt.submit'](r.engine, event, Object.assign(async () => { calls++; return {} }, { called: false }))
            assert.equal(admissions.size, 0, 'not-called catch takes its admission immediately')
            assert.equal(r.inspection.admissionTurns.size, 0)
          } else check.settled = true
        })
        return admissions
      }
      const result = await invoke20(r, 'prompt.submit', event, async () => { calls++; return {} })
      assert.match(result.drop, /did not finish/)
      assert.equal(calls, 0)
      assert.equal(r.inspection.admissionTurns.size, 0, 'abandoned file is not guarded')
      assert.equal(admissions.size, 0, 'abandoned token uses no cap entry')
      admissions.set = set
    }
    assert.deepEqual(r.inbox(), ['a.json'])
  } finally { r.done() }
})

test('round27 item 2: copied-event catch settles the pending token before its sample can bind', async () => {
  const r = await rig({ inspect: true })
  const sample = Promise.withResolvers()
  let prompt
  try {
    r.inspection.suppressTick()
    r.drop('a', 'peer', 'hello')
    const exists = r.engine.fs.exists
    let sampling = false, calls = 0
    r.engine.fs.exists = async p => {
      const present = await exists(p)
      if (p.endsWith('/inbox/testseat/a.json')) { sampling = true; await sample.promise }
      return present
    }
    const event = Object.freeze(event20())
    prompt = invoke20(r, 'prompt.submit', event, async () => { calls++; return {} })
    await until20(() => sampling)
    const check = r.inspection.pointerChecks.get(event) ?? r.inspection.pointerChecks.get(String(r.inspection.runtime().promptSeq))
    const caught = await r.catches['prompt.submit'](r.engine, { ...event }, Object.assign(async () => { calls++; return {} }, { called: false }))
    assert.match(caught.drop, /did not finish/)
    assert.equal(check.settled, true, 'copied catch resolves the pending text FIFO token')
    sample.resolve()
    assert.match((await prompt).drop, /did not finish/)
    assert.equal(calls, 0)
    assert.equal(r.inspection.admissionTurns.size, 0)
    assert.equal(r.inspection.promptAdmissions.size, 0)
    assert.deepEqual(r.inbox(), ['a.json'])
  } finally { sample.resolve(); await prompt; r.done() }
})

test('round27 item 3 / J: session end releases WAIT and active window in the same tick, with late correction', async () => {
  for (const inTurn of [true, false]) {
    const r = await rig({ inspect: true, submitTimeoutMinutes: 10 })
    const pending = Promise.withResolvers()
    let tick
    try {
      const timers = []
      r.clock.after = (ms, run) => {
        const t = { ms, run, cancelled: false }; timers.push(t)
        return { cancel() { t.cancelled = true } }
      }
      if (inTurn) await invoke20(r, 'turn.start', { turnId: 'working' })
      r.drop('a', 'testseat-supervisor', LEG)
      r.hooks.pending = pending.promise
      tick = r.inspection.tick(r.engine)
      await until20(() => r.inspection.turnEndWaiters.size === 1)
      const armed = timers.length
      await invoke20(r, 'session.end')
      await flush20()
      assert.equal(r.inspection.turnEndWaiters.size, 0, 'wait returns without firing or advancing a timer')
      await tick
      assert.equal(r.inspection.runtime().isTicking, false)
      assert.equal(r.held('room:testseat:a.json').status, 'submitting:unresolved')
      assert.equal(timers.length, armed, 'no final ten-minute window')
      assert.ok(timers.every(t => t.cancelled))
      pending.resolve({})
      await until20(() => r.ledger()['room:testseat:a.json'] === 'submitted' && !r.tickets().length)
      assert.match(r.logText(), /submitting:unresolved/)
    } finally { pending.resolve({}); await tick; await flush20(); r.done() }
  }
})

test('round27 item 4: admitted claim races silently skip without spending claim or deferral budgets', async () => {
  const r = await rig({ inspect: true })
  try {
    for (let i = 0; i < 9; i++) r.drop(`a${i}`, 'peer', `message ${i}`)
    let reads = 0
    r.engine.prompt.read = async () => {
      const i = reads++
      if (i < 8) await invoke20(r, 'prompt.submit', event20(`a${i}.json`))
      return { text: '' }
    }
    await r.inspection.tick(r.engine)
    assert.doesNotMatch(r.logText(), /deferred:claim-move/, 'admitted outcome is not a ledger deferral')
    assert.equal(reads, 9, 'eight silent skips consume neither the six-claim nor three-deferral budget')
    assert.deepEqual(r.inbox(), Array.from({ length: 8 }, (_, i) => `a${i}.json`))
    assert.deepEqual(r.processed(), ['a8.json'])
    assert.equal(r.submitted.length, 1)
    assert.equal(await r.inspection.claim(r.engine, r.where, { id: 'room:testseat:a0.json', source: 'room' }), 'admitted')
    assert.equal(Object.values(r.ledger()).filter(s => s.startsWith('deferred:')).length, 0)
  } finally { r.done() }
})

test('round27 item 5 / C: cap permits mixed mail unchanged with no admission and one log', async () => {
  const r = await rig({ inspect: true })
  const pending = Promise.withResolvers(), calls = []
  try {
    r.inspection.suppressTick()
    r.drop('a', 'peer', 'tracked')
    r.drop('overflow', 'peer', 'unread quote')
    for (let i = 0; i < 64; i++) {
      calls.push(invoke20(r, 'prompt.submit', event20(), () => pending.promise))
      await until20(() => r.inspection.promptAdmissions.size === i + 1)
    }
    const text = `Please answer this mail.\n${event20('overflow.json').text}`
    for (let i = 0; i < 2; i++) {
      const event = Object.freeze(event20('overflow.json', { text }))
      let forwarded
      const answer = await invoke20(r, 'prompt.submit', event, async e => { forwarded = e; return { text: e.text } })
      assert.equal(forwarded, event, 'MIXED enters unchanged even when its quote is UNREAD')
      assert.equal(answer.text, text)
      assert.equal(r.inspection.admissionTurns.has('overflow.json'), false)
      assert.equal(r.inspection.promptAdmissions.size, 64)
    }
    assert.equal(r.logs.filter(line => line.includes('cap 64')).length, 1)
    assert.match((await invoke20(r, 'prompt.submit', event20('overflow.json'))).drop, /cap 64/)
    assert.equal(r.logs.filter(line => line.includes('cap 64')).length, 1)
    assert.ok(r.inbox().includes('overflow.json'))
  } finally { pending.resolve({ drop: 'cleanup' }); await Promise.all(calls); r.done() }
})

test('round28 item 1: a five-second claim spawn does not delay the pointer sample', async () => {
  const r = await rig({ inspect: true })
  let claim, prompt, slow
  const spawn = Promise.withResolvers()
  try {
    r.inspection.suppressTick()
    r.drop('a', 'peer', 'hello')
    const run = r.engine.process.run
    let spawning = false, settled = false
    r.engine.process.run = async args => {
      if (args.includes(MOVE)) {
        spawning = true
        slow = setTimeout(spawn.resolve, 5000)
        await spawn.promise
      }
      return run(args)
    }
    claim = r.inspection.claim(r.engine, r.where, { id: 'room:testseat:a.json', source: 'room' })
    await until20(() => spawning)
    const started = performance.now()
    prompt = invoke20(r, 'prompt.submit', event20()).then(value => { settled = true; return value })
    await sleep(100)
    assert.equal(settled, true, 'fence completes while the five-second spawn is still pending')
    assert.ok(performance.now() - started < 1000)
    assert.match((await prompt).drop, /CLAIMED/)
    assert.equal(r.inspection.admissionTurns.size, 0)
    assert.ok(r.inspection.tickOwned.has('a.json'), 'claim marks before spawning')
    assert.deepEqual(r.inbox(), ['a.json'])
    await claim
  } finally { clearTimeout(slow); spawn.resolve(); await Promise.allSettled([claim, prompt]); r.done() }
})

test('round28 item 2: installRoot without roomRoot admits a bare pointer unchanged after holds', async () => {
  const r = await rig({ inspect: true, noRoom: true })
  try {
    r.inspection.suppressTick()
    const event = event20()
    let entered
    const result = await invoke20(r, 'prompt.submit', event, async e => { entered = e; return { text: e.text } })
    assert.equal(entered, event)
    assert.equal(result.text, event.text)
    assert.equal(r.inspection.admissionTurns.size, 0)
    writeFileSync(join(r.where.memory, 'runtime', 'auto-clear-cycle.json'), JSON.stringify({ state: 'CLEAR_PENDING' }))
    assert.match((await invoke20(r, 'prompt.submit', event)).drop, /delivery held/)
  } finally { r.done() }
})

test('round28 item 3: clockless after two queued completions waits for a new completion', async () => {
  const r = await rig({ inspect: true })
  const pending = Promise.withResolvers()
  let waiting
  try {
    r.inspection.suppressTick()
    r.inspection.mainTurns.add('still-working')
    let arms = 0, result
    r.clock.after = () => {
      if (++arms === 2) throw Error('window clock unavailable')
      return { cancel() {} }
    }
    waiting = r.inspection.waitForSubmit(r.engine, () => pending.promise).then(value => { result = value })
    for (const wake of r.inspection.turnEndWaiters) { wake(); wake() }
    await flush20()
    assert.equal(arms, 2, 'two completions queued before the first window')
    assert.equal(result, undefined, 'old settled ended promise must not end clockless WAIT')
    assert.equal(r.inspection.turnEndWaiters.size, 1)
    await invoke20(r, 'turn.complete', { turnId: 'still-working' })
    await waiting
    assert.equal(result, 'timeout')
    assert.equal(r.inspection.turnEndWaiters.size, 0)
  } finally { pending.resolve('cleanup'); await waiting; r.done() }
})

test('round28 item 4: abandoned pointer logs exactly once when the body resumes', async () => {
  const r = await rig({ inspect: true })
  const sample = Promise.withResolvers()
  let prompt
  try {
    r.inspection.suppressTick()
    r.drop('a', 'peer', 'hello')
    const exists = r.engine.fs.exists
    let sampling = false
    r.engine.fs.exists = async p => {
      const present = await exists(p)
      if (p.endsWith('/inbox/testseat/a.json')) { sampling = true; await sample.promise }
      return present
    }
    const event = event20()
    prompt = invoke20(r, 'prompt.submit', event, async () => assert.fail('abandoned prompt entered'))
    await until20(() => sampling)
    const caught = await r.catches['prompt.submit'](r.engine, event, Object.assign(async () => ({}), { called: false }))
    sample.resolve()
    assert.deepEqual(await prompt, caught)
    assert.equal(r.logs.filter(line => line.includes('pointer fence did not finish')).length, 1)
  } finally { sample.resolve(); await prompt; r.done() }
})

test('round28 item 5: mixed GONE pointer skips hold reads and UNREAD samples precede holds outside the gate', async () => {
  const r = await rig({ inspect: true })
  const hold = Promise.withResolvers()
  let prompt
  try {
    r.inspection.suppressTick()
    r.freeze()
    const reads = [], samples = []
    const read = r.engine.fs.read, exists = r.engine.fs.exists
    let readingHold = false
    r.engine.fs.read = async p => {
      if (/auto-clear-cycle.json|state\/holds\//.test(p)) {
        reads.push(p)
        if (p.endsWith('/auto-clear-cycle.json')) { readingHold = true; await hold.promise }
      }
      return read(p)
    }
    r.engine.fs.exists = p => {
      if (/\/(inbox|claimed)\/testseat\//.test(p)) samples.push(p)
      return exists(p)
    }
    const mixed = event20('gone.json', { text: `Please reply.\n${event20('gone.json').text}` })
    // If the old fence tries holds, unblock it so RED is an assertion, not a hang.
    const gone = invoke20(r, 'prompt.submit', mixed, async e => ({ text: e.text }))
    await flush20()
    hold.resolve()
    assert.equal((await gone).text, mixed.text)
    assert.deepEqual(reads, [], 'MIXED + GONE does not read either hold file')
    assert.equal(samples.length, 2)
    r.drop('a', 'peer', 'unread')
    const blocked = Promise.withResolvers()
    r.engine.fs.read = async p => {
      if (p.endsWith('/auto-clear-cycle.json')) {
        assert.equal(samples.length, 4, 'both samples precede the first hold read')
        readingHold = true
        await blocked.promise
      }
      return read(p)
    }
    readingHold = false
    prompt = invoke20(r, 'prompt.submit', event20())
    await until20(() => readingHold)
    let gateFree = false
    const gate = r.inspection.serialized(async () => { gateFree = true })
    await flush20()
    const freeDuringHold = gateFree
    blocked.resolve()
    await gate
    assert.equal(freeDuringHold, true, 'hold I/O runs outside the gate')
    assert.match((await prompt).drop, /delivery held/)
    assert.equal(r.inspection.admissionTurns.size, 0, 'held prompt releases its provisional binding')
  } finally { hold.resolve(); await prompt; r.done() }
})

test('round28 item 6: bare and mixed fences bind the same unread file', async () => {
  const r = await rig({ inspect: true })
  try {
    r.drop('a', 'peer', 'hello')
    for (const bare of [true, false]) {
      const text = `${bare ? '' : 'Please reply.\n'}${event20().text}`
      const token = String(bare)
      const fence = await r.inspection.pointerHold(r.engine, text, r.inspection.findPointers(text), { settled: false, token, text })
      assert.deepEqual(fence.admission.files, ['a.json'])
      assert.equal(r.inspection.promptAdmissions.get(token), fence.admission)
    }
  } finally { r.done() }
})

test('round28 item 7: promiseMutex invokes jobs with zero arguments across rejection recovery', async () => {
  const r = await rig({ inspect: true })
  try {
    const serial = r.inspection.mutex()
    const seen = []
    await assert.rejects(serial(function (...args) { seen.push(args); throw Error('first') }), /first/)
    assert.equal(await serial(function (...args) { seen.push(args); return Promise.resolve(42) }), 42)
    assert.deepEqual(seen, [[], []])
  } finally { r.done() }
})

test('round28 item 8: two reachable prompt tokens prune separately at their last binding', async () => {
  const r = await rig({ inspect: true })
  try {
    r.inspection.suppressTick()
    r.drop('a', 'peer', 'first')
    r.drop('b', 'peer', 'last')
    for (const [file, turnId] of [['a.json', 'first'], ['b.json', 'last']]) {
      await invoke20(r, 'turn.start', { turnId })
      await assert.rejects(invoke20(r, 'prompt.submit', event20(file, { turnId }), async () => { throw Error('downstream') }), /downstream/)
    }
    const admissions = [...r.inspection.promptAdmissions.values()]
    assert.equal(admissions.length, 2)
    assert.notEqual(admissions[0].token, admissions[1].token)
    assert.deepEqual(admissions.map(a => a.files), [['a.json'], ['b.json']])
    await invoke20(r, 'turn.complete', { turnId: 'first' })
    assert.deepEqual([...r.inspection.promptAdmissions.keys()], [admissions[1].token])
    assert.deepEqual([...r.inspection.admissionTurns.keys()], ['b.json'])
    await invoke20(r, 'turn.complete', { turnId: 'last' })
    assert.equal(r.inspection.promptAdmissions.size, 0)
    assert.equal(r.inspection.admissionTurns.size, 0)
  } finally { r.done() }
})


test('round29 item 1: hung samples leave claims free and ownership wins before decision', async () => {
  const r = await rig({ inspect: true })
  const sample = Promise.withResolvers(), spawn = Promise.withResolvers()
  let prompt, claim
  try {
    r.inspection.suppressTick()
    r.drop('a', 'peer', 'hello')
    const exists = r.engine.fs.exists, run = r.engine.process.run
    let sampling = false, spawning = false
    r.engine.fs.exists = async p => {
      const present = await exists(p)
      if (p.endsWith('/inbox/testseat/a.json')) { sampling = true; await sample.promise }
      return present
    }
    r.engine.process.run = async args => {
      if (args.includes(MOVE)) { spawning = true; await spawn.promise }
      return run(args)
    }
    prompt = invoke20(r, 'prompt.submit', event20())
    await until20(() => sampling)
    claim = r.inspection.claim(r.engine, r.where, { id: 'room:testseat:a.json', source: 'room' })
    await flush20()
    assert.equal(spawning, true, 'a hung pointer sample cannot block the tick claim')
    sample.resolve()
    assert.match((await prompt).drop, /CLAIMED/, 'mark before decide overrides the stale UNREAD sample')
    spawn.resolve()
    assert.equal(await claim, 'moved')
    r.drop('b', 'peer', 'second')
    await invoke20(r, 'prompt.submit', event20('b.json'))
    assert.equal(await r.inspection.claim(r.engine, r.where, { id: 'room:testseat:b.json', source: 'room' }), 'admitted', 'mark after bind checks admission in its own gate')
    assert.deepEqual(r.inbox(), ['b.json'])
  } finally { sample.resolve(); spawn.resolve(); await Promise.allSettled([prompt, claim]); r.done() }
})

test('round29 item 2: bare and mixed quotes never admit a supervisor lifecycle leg', async () => {
  for (const mixed of [false, true]) {
    const r = await rig({ inspect: true })
    try {
      r.inspection.suppressTick()
      r.drop('leg', 'testseat-supervisor', LEG)
      const text = `${mixed ? 'Please reply.\n' : ''}${event20('leg.json').text}`
      await invoke20(r, 'prompt.submit', event20('leg.json', { text }))
      assert.equal(r.inspection.admissionTurns.has('leg.json'), false, 'lifecycle files never bind')
      r.inspection.resumeTick()
      await r.tick()
      assert.deepEqual(r.processed(), ['leg.json'])
      assert.equal(r.submitted.length, 1)
      assert.ok(r.submitted[0].includes('ROOM-LIFECYCLE'))
    } finally { r.done() }
  }
  // A real prior admission can outlive a replacement file with the same name.
  // The claim's own exemption must still let the supervisor leg through.
  const r = await rig({ inspect: true })
  try {
    r.inspection.suppressTick()
    r.drop('leg', 'peer', 'ordinary mail')
    await invoke20(r, 'prompt.submit', event20('leg.json'))
    assert.equal(r.inspection.admissionTurns.has('leg.json'), true)
    r.drop('leg', 'testseat-supervisor', LEG)
    r.inspection.resumeTick()
    await r.tick()
    assert.deepEqual(r.processed(), ['leg.json'])
    assert.equal(r.submitted.length, 1)
    assert.ok(r.submitted[0].includes('ROOM-LIFECYCLE'))
  } finally { r.done() }
})

test('round29 item 4: pointerHold returns its bound admission without a callback', async () => {
  const r = await rig({ inspect: true })
  try {
    r.inspection.suppressTick()
    r.drop('a', 'peer', 'hello')
    const text = event20().text
    const fence = await r.inspection.pointerHold(r.engine, text, r.inspection.findPointers(text), { settled: false, token: 'direct', text })
    assert.deepEqual(fence, { admission: { token: 'direct', text, files: ['a.json'] } })
    assert.deepEqual([...r.inspection.admissionTurns.keys()], ['a.json'])
    assert.equal(r.inspection.promptAdmissions.get('direct'), fence.admission)
  } finally { r.done() }
})

test('round29 item 8: WAIT deadline arms once on first WAIT after an idle submit window', async () => {
  const r = await rig({ inspect: true })
  const pending = Promise.withResolvers()
  let waiting
  try {
    r.inspection.suppressTick()
    const timers = []
    r.clock.after = (ms, run) => { const t = { ms, run, cancelled: false }; timers.push(t); return { cancel() { t.cancelled = true } } }
    waiting = r.inspection.waitForSubmit(r.engine, () => pending.promise)
    await flush20()
    assert.deepEqual(timers.map(t => t.ms), [600000], 'idle submits only arm their submit window')
    await invoke20(r, 'turn.start', { turnId: 'working' })
    timers[0].run()
    await flush20()
    assert.deepEqual(timers.map(t => t.ms), [600000, 3600000])
    await invoke20(r, 'turn.complete', { turnId: 'working' })
    await flush20()
    await invoke20(r, 'turn.start', { turnId: 'second' })
    timers[2].run()
    await flush20()
    assert.equal(timers.filter(t => t.ms === 3600000).length, 1, 'later WAIT reuses the first deadline')
    pending.resolve('entered')
    assert.equal(await waiting, 'entered')
    assert.ok(timers.every(t => t.cancelled))
  } finally { pending.resolve('cleanup'); await waiting; r.done() }
})


test('round30 item 1: a not-called catch cannot release an identical pending replay admission', async () => {
  const r = await rig({ inspect: true })
  try {
    r.inspection.suppressTick()
    r.drop('a', 'peer', 'hello')
    const p1 = event20()
    await assert.rejects(invoke20(r, 'prompt.submit', p1, async () => { throw Error('P1 downstream') }), /P1 downstream/)
    const admission = [...r.inspection.promptAdmissions.values()][0]
    assert.equal(admission.replay, true)
    const p2 = { ...p1, get origin() { throw Error('P2 before next') } }
    let called = false
    await assert.rejects(invoke20(r, 'prompt.submit', p2, async () => { called = true }), /P2 before next/)
    assert.equal(called, false)
    const unusedNext = Object.assign(async () => { throw Error('must not call next') }, { called: false })
    assert.ok(r.catches['prompt.submit'](r.engine, p2, unusedNext).drop)
    assert.equal(r.inspection.promptAdmissions.get(admission.token), admission, 'P2 owns no replay admission')
    assert.equal(r.inspection.admissionTurns.get('a.json').size, 1, 'P1 remains bound')
    const settled = Promise.withResolvers()
    const replay = r.catches['prompt.submit'](r.engine, { ...p1 }, Object.assign(() => settled.promise, { called: true }))
    await flush20()
    assert.equal(r.inspection.admissionTurns.get('a.json').size, 1, 'pending replay keeps the binding')
    settled.resolve({ drop: 'P1 replay dropped' })
    assert.deepEqual(await replay, { drop: 'P1 replay dropped' })
    assert.equal(r.inspection.admissionTurns.has('a.json'), false)
  } finally { r.done() }
})

test('round30 item 2: turn.start between the tick check and gate leaves the file in inbox', async () => {
  const r = await rig({ inspect: true })
  let started
  try {
    r.drop('a', 'peer', 'hello')
    const turns = r.inspection.mainTurns
    const size = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get
    let armed = false
    r.engine.prompt.read = async () => { armed = true; return { text: '' } }
    Object.defineProperty(turns, 'size', { configurable: true, get() {
      const count = size.call(this)
      if (armed) {
        armed = false
        queueMicrotask(() => {
          assert.equal(r.inspection.tickOwned.has('a.json'), false, 'turn starts before claim marking')
          started = invoke20(r, 'turn.start', { turnId: 'gate-race' })
        })
      }
      return count
    } })
    await r.inspection.tick(r.engine)
    assert.ok(started, 'turn.start ran after the outside check')
    await started
    assert.deepEqual(r.inbox(), ['a.json'])
    assert.deepEqual(r.claimed(), [])
    assert.equal(r.inspection.tickOwned.has('a.json'), false)
    assert.equal(r.runs.some(args => args.includes(MOVE)), false)
    assert.deepEqual(r.ledger(), {}, 'silent skip writes no deferral')
    assert.deepEqual(r.submitted, [])
  } finally { r.done() }
})


test('round31 item 1: not-called catch forwards MIXED unchanged and drops BARE without binding', async () => {
  for (const mixed of [true, false]) {
    const r = await rig({ inspect: true })
    const hold = Promise.withResolvers()
    let prompt
    try {
      r.inspection.suppressTick()
      r.drop('a', 'peer', 'unread')
      const read = r.engine.fs.read
      let readingHold = false
      r.engine.fs.read = async p => {
        if (p.endsWith('/auto-clear-cycle.json')) { readingHold = true; await hold.promise }
        return read(p)
      }
      const event = event20('a.json', { text: `${mixed ? 'Please stop before the clear.\n' : ''}${event20().text}` })
      let forwarded = 0
      const next = async e => { forwarded++; assert.equal(e, event); return { text: e.text } }
      prompt = invoke20(r, 'prompt.submit', event, next)
      await until20(() => readingHold)
      assert.equal(r.inspection.admissionTurns.size, 1)
      const caught = await r.catches['prompt.submit'](r.engine, event, Object.assign(next, { called: false }))
      assert.equal(r.inspection.admissionTurns.size, 0)
      assert.equal(r.inspection.promptAdmissions.size, 0)
      hold.resolve()
      await prompt
      assert.equal(forwarded, mixed ? 1 : 0, 'late hook never forwards a second time')
      if (mixed) assert.deepEqual(caught, { text: event.text })
      else assert.match(caught.drop, /did not finish/)
    } finally { hold.resolve(); await prompt; r.done() }
  }
})

test('round31 item 2 / D: held MIXED enters unbound and the tick delivers UNREAD after thaw; BARE drops', async () => {
  for (const hold of ['cycle', 'supervisor']) {
    const r = await rig({ inspect: true, cycle: hold === 'cycle' ? 'checkpoint-requested' : 'idle' })
    try {
      r.inspection.suppressTick()
      if (hold === 'supervisor') r.freeze()
      r.drop('a', 'peer', 'Room body survives the hold')
      const event = event20('a.json', { text: `Please stop before the clear.\n${event20().text}` })
      const result = await invoke20(r, 'prompt.submit', event, async e => {
        assert.equal(e, event)
        assert.equal(r.inspection.admissionTurns.size, 0, 'no binding when the peer words enter')
        assert.equal(r.inspection.promptAdmissions.size, 0, 'nothing admitted')
        return { text: e.text }
      })
      assert.deepEqual(result, { text: event.text })
      assert.match((await invoke20(r, 'prompt.submit', event20())).drop, /held/)
      assert.deepEqual(r.inbox(), ['a.json'])
      assert.deepEqual(r.submitted, [])
      r.thaw()
      writeFileSync(join(r.where.memory, 'runtime', 'auto-clear-cycle.json'), JSON.stringify({ state: 'idle' }))
      r.inspection.resumeTick()
      await r.tick()
      assert.equal(r.submitted.length, 1)
      assert.match(r.submitted[0], /Room body survives the hold/)
      assert.deepEqual(r.processed(), ['a.json'])
    } finally { r.done() }
  }
})

test('round31 item 3: falsy drops and rejected replays release only their admission', async () => {
  const outcomes = []
  for (const replay of [false, true]) for (const drop of ['', false, null, 0]) {
    const r = await rig({ inspect: true })
    try {
      r.inspection.suppressTick()
      r.drop('a', 'peer', 'drop this admission')
      r.drop('b', 'peer', 'keep this admission')
      await invoke20(r, 'prompt.submit', event20('b.json'))
      const event = event20()
      if (replay) {
        await assert.rejects(invoke20(r, 'prompt.submit', event, async () => { throw Error('downstream') }), /downstream/)
        assert.deepEqual(await r.catches['prompt.submit'](r.engine, event, Object.assign(async () => ({ drop }), { called: true })), { drop })
      } else assert.deepEqual(await invoke20(r, 'prompt.submit', event, async () => ({ drop })), { drop })
      outcomes.push([...r.inspection.admissionTurns.keys()])
      assert.equal(r.inspection.promptAdmissions.size, 0)
    } finally { r.done() }
  }
  const r = await rig({ inspect: true })
  try {
    r.inspection.suppressTick()
    r.drop('a', 'peer', 'replay rejects')
    r.drop('b', 'peer', 'keep this admission')
    await invoke20(r, 'prompt.submit', event20('b.json'))
    const event = event20()
    await assert.rejects(invoke20(r, 'prompt.submit', event, async () => { throw Error('downstream') }), /downstream/)
    const failure = Error('replay rejection')
    await assert.rejects(r.catches['prompt.submit'](r.engine, event, Object.assign(async () => { throw failure }, { called: true })), error => error === failure)
    outcomes.push([...r.inspection.admissionTurns.keys()])
    assert.equal(r.inspection.promptAdmissions.size, 0)
  } finally { r.done() }
  assert.deepEqual(outcomes, Array.from({ length: 9 }, () => ['b.json']))
})

test('round31 item 4: a session reset during hold reads drops BARE and forwards MIXED unbound', async () => {
  for (const edge of ['start', 'end']) for (const mixed of [false, true]) {
    const r = await rig({ inspect: true })
    const hold = Promise.withResolvers()
    let prompt
    try {
      r.inspection.suppressTick()
      r.drop('a', 'peer', 'unread')
      const read = r.engine.fs.read
      let readingHold = false
      r.engine.fs.read = async p => {
        if (p.endsWith('/auto-clear-cycle.json')) { readingHold = true; await hold.promise }
        return read(p)
      }
      const event = event20('a.json', { text: `${mixed ? 'Please reply.\n' : ''}${event20().text}` })
      let forwarded = 0
      prompt = invoke20(r, 'prompt.submit', event, async e => {
        forwarded++
        assert.equal(e, event)
        assert.equal(r.inspection.admissionTurns.size, 0)
        assert.equal(r.inspection.promptAdmissions.size, 0)
        return { text: e.text }
      })
      await until20(() => readingHold)
      assert.equal(r.inspection.admissionTurns.size, 1)
      r.inspection.resetTurnState(edge)
      hold.resolve()
      const result = await prompt
      assert.equal(forwarded, mixed ? 1 : 0)
      if (mixed) assert.deepEqual(result, { text: event.text })
      else assert.match(result.drop, /binding|fence|check failed/)
      assert.deepEqual(r.inbox(), ['a.json'])
    } finally { hold.resolve(); await prompt; r.done() }
  }
})

test('round31 item 5: angle-bracket peer words plus a GONE pointer are MIXED and enter unchanged', async () => {
  const { pointerOnly } = await import('../hooks/register.ts')
  const r = await rig({ inspect: true })
  try {
    r.inspection.suppressTick()
    const event = event20('gone.json', { text: `<urgent: stop before the clear>\n${event20('gone.json').text}` })
    const result = await invoke20(r, 'prompt.submit', event, async e => { assert.equal(e, event); return { text: e.text } })
    assert.deepEqual(result, { text: event.text })
    assert.equal(pointerOnly(event.text), false)
    for (const tag of ['cross-session-message', 'task-notification']) {
      assert.equal(pointerOnly(`<${tag}>\n${event20('gone.json').text}\n</${tag}>`), true)
    }
  } finally { r.done() }
})
