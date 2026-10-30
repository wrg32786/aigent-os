// Direct fake-on fixtures run under Node because the plugin runner forbids dynamic imports.
// Each fixture gets fresh production module state through its cache-busting specifier.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { On, PromptSubmitResult, Hook, CatchHandler, EngineInterface } from 'claude-code'
import { MOVE, OWNER_PID, PID_DEAD, UNLINK, WRITE, pointerText } from '../hooks/register.ts'

import {
  ROOT, ROOM, LOG, CYCLE, INBOX, PROCESSED, CLAIMED, RENAME, CONFIGURED,
  line, envelope, ENVELOPE, READY, TURN, A_POINTER, asPeerPrompt,
} from './fixtures.ts'

type Entries = Record<string, { status: string }>

let directModuleId = 0

test('FENCE H: a dropped catch replay releases only its admits, preserving a quoted pointer on a copied event', async () => {
  // Drive the actual registered hook and catch directly so a post-next failure
  // and the engine's settled replay can be injected independently.
  let submit!: Hook<'prompt.submit'>
  let recover!: CatchHandler<Hook<'prompt.submit'>>
  let complete!: Hook<'turn.complete'>
  let start!: Hook<'turn.start'>
  let end!: Hook<'session.end'>
  const { register } = await import(`../hooks/register.ts?fixture=${++directModuleId}`)
  register(((name: string, ...args: unknown[]) => {
    if (name === 'prompt.submit') submit = args.at(-1) as typeof submit
    if (name === 'turn.complete') complete = args.at(-1) as typeof complete
    if (name === 'turn.start') start = args.at(-1) as typeof start
    if (name === 'session.end') end = args.at(-1) as typeof end
    return { catch: (handler: typeof recover) => { if (name === 'prompt.submit') recover = handler } }
  }) as unknown as On, CONFIGURED.options)
  const files = new Map(Object.entries(READY))
  const slots = new Map<string, { value: unknown; version: number }>()
  const delivered: string[] = []
  let tickAgain = () => {}
  const isDir = (p: string) => [...files.keys()].some(file => file.startsWith(`${p}/`))
  const engine = {
    clock: { now: async () => Date.parse('2026-10-07T18:30:00Z'), after: () => ({ cancel() {} }), every: (_ms: number, run: () => void) => { tickAgain = run; return { cancel() {} } } },
    fs: {
      exists: async (p: string) => files.has(p) || isDir(p),
      read: async (p: string) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p)! },
      write: async (p: string, text: string) => { files.set(p, text) },
      stat: async (p: string) => { if (!files.has(p) && !isDir(p)) throw new Error('ENOENT'); return { kind: isDir(p) ? 'dir' : 'file', size: files.get(p)?.length ?? 0, mtimeMs: 0, isLink: false } },
      list: async (p: string) => [...files.keys()].filter(file => file.startsWith(`${p}/`) && !file.slice(p.length + 1).includes('/')).map(file => ({ name: file.slice(p.length + 1), kind: 'file' })),
    },
    env: { get: async () => undefined },
    session: { root: async () => ROOT, id: async () => 'alpha-sid' },
    state: {
      get: async (key: { key: string }) => slots.get(key.key) ?? { value: undefined, version: 0 },
      set: async (key: { key: string }, value: unknown, options?: { ifVersion?: number }) => {
        const version = slots.get(key.key)?.version ?? 0
        if (options?.ifVersion !== undefined && options.ifVersion !== version) return { isSet: false }
        slots.set(key.key, { value, version: version + 1 })
        return { isSet: true }
      },
    },
    store: { get: async () => undefined, delete: async () => {} },
    process: { run: async (argv: string[]) => {
      if (argv[2] === OWNER_PID) return { exitCode: 0, stdout: '4242', stderr: '' }
      if (argv[2] === PID_DEAD) return { exitCode: 1, stdout: '', stderr: '' }
      if (argv[2] === WRITE) files.set(argv.at(-2)!, argv.at(-1)!)
      else if (argv[2] === UNLINK) files.delete(argv.at(-1)!)
      else if (argv[2] === MOVE || argv[2] === RENAME) {
        const from = argv.at(-2)!, to = argv.at(-1)!
        if (!files.has(from)) return { exitCode: 1, stdout: '', stderr: 'ENOENT' }
        files.set(to, files.get(from)!); files.delete(from)
      } else throw new Error('unexpected process in replay test')
      return { exitCode: 0, stdout: '', stderr: '' }
    } },
    prompt: { read: async () => ({ text: '' }), submit: async (e: { text: string }) => { delivered.push(e.text); return { text: 'entered' } } },
    ui: { log: () => {}, status: () => {} },
  } as unknown as EngineInterface
  const next = (async () => ({})) as unknown as Parameters<typeof submit>[2]
  await end(engine, { sessionId: 'alpha-sid', reason: 'clear' } as never, next as never)
  await start(engine, { text: 'working', turnId: 'replay-turn' } as never, next as never)
  // A separate queued prompt is unaffected by the dropped replay.
  files.set(`${INBOX}/b.json`, ENVELOPE)
  await submit(engine, asPeerPrompt(pointerText('alpha', 'beta', 'b.json')), next)
  const event = asPeerPrompt(`Real mail quoting another seat.\n${pointerText('gamma', 'beta', 'b.json')}\n${A_POINTER}`)
  let forwarded = ''
  const failedNext = (async (e: { text: string }) => { forwarded = e.text; throw new Error('injected after next') }) as unknown as Parameters<typeof submit>[2]
  let failed = false
  try { await submit(engine, event, failedNext) } catch { failed = true }
  assert.equal(failed, true)
  assert.ok((forwarded).includes('a.json'))
  assert.equal(forwarded, event.text)
  const replay = Object.assign(async () => ({ drop: 'downstream drop' }), { called: true }) as unknown as Parameters<typeof recover>[2]
  assert.deepEqual(await recover(engine, { ...event }, replay), { drop: 'downstream drop' })
  let recoveredText = ''
  const firstNext = Object.assign(async (e: { text: string }) => { recoveredText = e.text; return {} }, { called: false }) as unknown as Parameters<typeof recover>[2]
  const mixed = asPeerPrompt(`Plain mail.\n${A_POINTER}`)
  const recovered = await recover(engine, mixed, firstNext)
  assert.ok(recovered)
  assert.deepEqual(recovered, {})
  assert.equal(recoveredText, mixed.text)
  assert.deepEqual(await recover(engine, asPeerPrompt(A_POINTER), firstNext), { drop: 'fleet-delivery: pointer fence did not finish; the pointer is dropped, the file waits for the tick' })
  // The dropped pointer is available to the next tick.
  await complete(engine, { ...TURN, turnId: 'replay-turn' } as never, next as never)
  for (let i = 0; i < 1000; i++) await Promise.resolve()
  assert.equal(files.has(`${PROCESSED}/a.json`), true)
  tickAgain()
  for (let i = 0; i < 1000; i++) await Promise.resolve()
  assert.equal(files.has(`${INBOX}/b.json`), true)
  assert.equal((delivered).length, 1)
  await end(engine, { sessionId: 'alpha-sid', reason: 'clear' } as never, next as never)
})

// Direct hook harness: deterministic timers, including unavailable clocks and a stuck now().
let cleanupRound18: (() => Promise<void>) | undefined
async function round18(minutes = 0.05) {
  await cleanupRound18?.()
  let submit!: Hook<'prompt.submit'>
  let recover!: CatchHandler<Hook<'prompt.submit'>>
  let complete!: Hook<'turn.complete'>
  let start!: Hook<'turn.start'>
  let end!: Hook<'session.end'>
  const { register } = await import(`../hooks/register.ts?fixture=${++directModuleId}`)
  register(((name: string, ...args: unknown[]) => {
    if (name === 'prompt.submit') submit = args.at(-1) as typeof submit
    if (name === 'turn.complete') complete = args.at(-1) as typeof complete
    if (name === 'turn.start') start = args.at(-1) as typeof start
    if (name === 'session.end') end = args.at(-1) as typeof end
    return { catch: (handler: typeof recover) => { if (name === 'prompt.submit') recover = handler } }
  }) as unknown as On, { ...CONFIGURED.options, submitTimeoutMinutes: minutes })
  let time = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  const windows: number[] = []
  let timerId = 0
  const flush = async () => { for (let i = 0; i < 1000; i++) await Promise.resolve() }
  const files = new Map(Object.entries(READY))
  const slots = new Map<string, { value: unknown; version: number }>()
  const delivered: string[] = []
  let tickAgain = () => {}
  const isDir = (p: string) => [...files.keys()].some(file => file.startsWith(`${p}/`))
  const engine = {
    clock: {
      now: async () => Date.parse('2026-10-07T18:30:00Z') + time,
      after: (ms: number, run: () => void) => {
        windows.push(ms)
        const id = ++timerId
        timers.set(id, { at: time + ms, run })
        return { cancel: () => { timers.delete(id) } }
      },
      every: (_ms: number, run: () => void) => { tickAgain = run; return { cancel() {} } },
    },
    fs: {
      exists: async (p: string) => files.has(p) || isDir(p),
      read: async (p: string) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p)! },
      write: async (p: string, text: string) => { files.set(p, text) },
      stat: async (p: string) => { if (!files.has(p) && !isDir(p)) throw new Error('ENOENT'); return { kind: isDir(p) ? 'dir' : 'file', size: files.get(p)?.length ?? 0, mtimeMs: 0, isLink: false } },
      list: async (p: string) => [...files.keys()].filter(file => file.startsWith(`${p}/`) && !file.slice(p.length + 1).includes('/')).map(file => ({ name: file.slice(p.length + 1), kind: 'file' })),
    },
    env: { get: async () => undefined },
    session: { root: async () => ROOT, id: async () => 'alpha-sid' },
    state: {
      get: async (key: { key: string }) => slots.get(key.key) ?? { value: undefined, version: 0 },
      set: async (key: { key: string }, value: unknown, options?: { ifVersion?: number }) => {
        const version = slots.get(key.key)?.version ?? 0
        if (options?.ifVersion !== undefined && options.ifVersion !== version) return { isSet: false }
        slots.set(key.key, { value, version: version + 1 })
        return { isSet: true }
      },
    },
    store: { get: async () => undefined, delete: async () => {} },
    process: { run: async (argv: string[]) => {
      if (argv[2] === OWNER_PID) return { exitCode: 0, stdout: '4242', stderr: '' }
      if (argv[2] === PID_DEAD) return { exitCode: 1, stdout: '', stderr: '' }
      if (argv[2] === WRITE) files.set(argv.at(-2)!, argv.at(-1)!)
      else if (argv[2] === UNLINK) files.delete(argv.at(-1)!)
      else if (argv[2] === MOVE || argv[2] === RENAME) {
        const from = argv.at(-2)!, to = argv.at(-1)!
        if (!files.has(from)) return { exitCode: 1, stdout: '', stderr: 'ENOENT' }
        files.set(to, files.get(from)!); files.delete(from)
      } else throw new Error('unexpected process in replay test')
      return { exitCode: 0, stdout: '', stderr: '' }
    } },
    prompt: { read: async () => ({ text: '' }), submit: async (e: { text: string }) => { delivered.push(e.text); return { text: 'entered' } } },
    ui: { log: () => {}, status: () => {} },
  } as unknown as EngineInterface
  const next = (async () => ({})) as unknown as Parameters<typeof submit>[2]
  await end(engine, { sessionId: 'alpha-sid', reason: 'clear' } as never, next as never)
  const advance = async (ms: number) => {
    const target = time + ms
    while (true) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      time = due[1].at
      timers.delete(due[0])
      due[1].run()
      await flush()
    }
    time = target
    await flush()
  }
  const turnStart = (turnId: string) => start(engine, { text: 'working', turnId } as never, next as never)
  const turnEnd = (turnId: string, agentId?: string) => complete(engine, { ...TURN, turnId, agentId } as never, next as never)
  const status = () => (slots.get('ledger')?.value as Record<string, Entries>)?.alpha?.['room:alpha:leg.json']?.status
  let enter!: (value: PromptSubmitResult) => void
  let reject!: (error: Error) => void
  const originalNow = engine.clock.now
  cleanupRound18 = async () => {
    engine.clock.now = originalNow
    enter?.({ text: 'cleanup entry' })
    await end(engine, { sessionId: 'alpha-sid', reason: 'clear' } as never, next as never)
    await flush()
    timers.clear()
    cleanupRound18 = undefined
  }
  const pendingLeg = async () => {
    files.delete(`${INBOX}/a.json`)
    files.set(`${INBOX}/leg.json`, envelope('alpha-supervisor', '[refresh-cycle] Run the fleet capsule lifecycle verb now.\nROOM-LIFECYCLE capsule-request'))
    engine.prompt.submit = () => new Promise((done, fail) => { enter = done; reject = fail })
    await turnStart('t1')
    await turnEnd('other')
    await flush()
    assert.equal(status(), 'submitting')
  }
  return { engine, files, windows, flush, advance, turnStart, turnEnd, status, pendingLeg, submit, recover, next, tick: () => tickAgain(), timers, enter: (value: PromptSubmitResult) => enter(value), reject: (error: Error) => reject(error), end: () => end(engine, { sessionId: 'alpha-sid', reason: 'clear' } as never, next as never) }
}

// Run teardown even for the final direct-hook test and when an assertion fails.
const round18Test = (name: string, body: () => Promise<void>) => test(name, async () => {
  try { await body() } finally { await cleanupRound18?.() }
})

round18Test('round18 J(a): a completion with a rejected clock still grants a submit window', async () => {
  const h = await round18()
  await h.pendingLeg()
  await h.advance(4000)
  const now = h.engine.clock.now
  h.engine.clock.now = async () => { h.engine.clock.now = now; throw new Error('clock refused') }
  await h.turnEnd('t1')
  await h.flush()
  assert.equal(h.status(), 'submitting')
  await h.advance(2999)
  assert.equal(h.status(), 'submitting')
  await h.advance(1)
  assert.equal(h.status(), 'submitting:unresolved')
})

round18Test('round18 J(b): two completions in one millisecond each grant a window', async () => {
  const h = await round18()
  await h.pendingLeg()
  await h.advance(4000)
  await h.turnStart('t2')
  h.engine.clock.now = async () => Date.parse('2026-10-07T18:30:00Z') + 4000
  const before = h.windows.filter(ms => ms === 3000).length
  await h.turnEnd('t1')
  await h.turnEnd('t2')
  await h.flush()
  assert.equal(h.windows.filter(ms => ms === 3000).length, before + 1)
  await h.advance(3000)
  assert.equal(h.windows.filter(ms => ms === 3000).length, before + 2)
  assert.equal(h.status(), 'submitting')
  await h.advance(3000)
  assert.equal(h.status(), 'submitting:unresolved')
})

round18Test('round18 J(c): rejecting now at wait start cannot park a three-hour turn', async () => {
  const h = await round18()
  const read = h.engine.fs.read
  const now = h.engine.clock.now
  h.engine.fs.read = (async (p: string) => {
    const value = await read(p)
    if (p === CYCLE && h.status() === 'submitting') h.engine.clock.now = async () => { throw new Error('no now') }
    return value
  }) as unknown as typeof h.engine.fs.read
  await h.pendingLeg()
  await h.advance(3000)
  h.engine.clock.now = now
  await h.advance(60 * 60_000 - 3001)
  assert.equal(h.status(), 'submitting')
  await h.advance(1)
  assert.equal(h.status(), 'submitting:unresolved')
  await h.advance(2 * 60 * 60_000)
  assert.equal(h.status(), 'submitting:unresolved')
  assert.equal(h.timers.size, 0)
})

round18Test('round18 J(d): WAIT deadline cannot shorten a completion window', async () => {
  const h = await round18()
  await h.pendingLeg()
  await h.advance(60 * 60_000 - 1000)
  await h.turnEnd('t1')
  await h.flush()
  assert.equal(h.status(), 'submitting')
  await h.advance(2999)
  assert.equal(h.status(), 'submitting')
  await h.advance(1)
  assert.equal(h.status(), 'submitting:unresolved')
  assert.equal(h.timers.size, 0)
})

round18Test('round18 J(e): the first ninety-minute window starts at completion', async () => {
  const h = await round18(90)
  await h.pendingLeg()
  await h.advance(10_000)
  await h.turnEnd('t1')
  await h.advance(90 * 60_000 - 1)
  assert.equal(h.status(), 'submitting')
  await h.advance(1)
  assert.equal(h.status(), 'submitting:unresolved')
  assert.equal(h.timers.size, 0)
})

for (const ending of ['completion', 'entry', 'session']) round18Test(`round18 J(f): unavailable after races once against ${ending}`, async () => {
  const h = await round18()
  h.engine.clock.after = () => { throw new Error('no after') }
  await h.pendingLeg()
  await h.advance(3 * 60 * 60_000)
  assert.equal(h.status(), 'submitting')
  if (ending === 'completion') await h.turnEnd('t1')
  else if (ending === 'session') {
    // Capture the registered end hook in the helper's reset path too.
    await h.end()
  } else h.enter({ text: 'entered' })
  await h.flush()
  assert.equal(h.status(), ending === 'entry' ? 'submitted' : 'submitting:unresolved')
  if (ending === 'session') {
    h.enter({ text: 'engine settled after teardown' })
    await h.flush()
    assert.equal(h.status(), 'submitted')
    const log = h.files.get(LOG)
    assert.ok(log)
    assert.ok(log.includes('submitting:unresolved'))
  }
})

round18Test('round18 item 2: a never-resolving now cannot delay completion wake', async () => {
  const h = await round18()
  await h.pendingLeg()
  await h.advance(4000)
  const before = h.windows.filter(ms => ms === 3000).length
  h.engine.clock.now = () => new Promise(() => {})
  void h.turnEnd('t1')
  await h.flush()
  assert.equal(h.windows.filter(ms => ms === 3000).length, before + 1)
})

round18Test('round18 item 3 / amended H: identical prompts retain the successful first admission after second replay', async () => {
  const h = await round18()
  await h.turnStart('pre')
  await h.turnEnd('other')
  await h.flush()
  let firstDone!: (value: object) => void
  let secondFail!: (error: Error) => void
  const event = asPeerPrompt(A_POINTER)
  const first = h.submit(h.engine, event, (() => new Promise(done => { firstDone = done })) as never)
  await h.flush()
  const second = Promise.resolve(h.submit(h.engine, { ...event }, (() => new Promise((_, fail) => { secondFail = fail })) as never)).catch(() => {})
  await h.flush()
  firstDone({})
  await first
  secondFail(new Error('overrun after next'))
  await second
  const replay = Object.assign(async () => ({ drop: 'downstream drop' }), { called: true })
  await h.recover(h.engine, { ...event }, replay as never)
  // A seen turn that started before admission must not release queued files.
  h.tick()
  await h.flush()
  // Start the tick without a lost-start completion that could mask the leak.
  await h.turnEnd('pre')
  await h.flush()
  assert.equal(h.files.has(`${INBOX}/a.json`), true)
  await h.turnStart('reader')
  await h.turnEnd('reader')
  await h.flush()
  assert.equal(h.files.has(`${PROCESSED}/a.json`), true)
})

round18Test('round18 item 4: unresolved memory reads neither hold nor clock', async () => {
  const h = await round18()
  h.files.set(`${ROOT}/.aigent/state.json`, 'invalid JSON')
  h.files.set(`${ROOM}/state/holds/alpha.json`, JSON.stringify({ ts: '2026-10-07T18:30:00Z' }))
  const reads: string[] = []
  const read = h.engine.fs.read
  h.engine.fs.read = (async (p: string) => { reads.push(p); return read(p) }) as unknown as typeof h.engine.fs.read
  let clockReads = 0
  h.engine.clock.now = async () => { clockReads++; return 0 }
  const text = `${A_POINTER}\n${pointerText('alpha', 'beta', 'b.json')}`
  const result = await h.submit(h.engine, asPeerPrompt(text), h.next)
  assert.ok(('drop' in (result)))
  assert.ok(((result as { drop: string }).drop).includes('memory root unresolved'))
  assert.deepEqual(reads, [`${ROOT}/.aigent/state.json`])
  assert.equal(clockReads, 0)
})

round18Test('round19 item 2 / D: unresolved memory admits mixed mail unchanged and drops bare pointers', async () => {
  const h = await round18()
  h.files.set(`${ROOT}/.aigent/state.json`, 'invalid JSON')
  const event = asPeerPrompt(`Please reply.\n${A_POINTER}`)
  const forwarded: unknown[] = []
  const answer = await h.submit(h.engine, event, (async (e: Parameters<typeof h.submit>[1]) => { forwarded.push(e); return {} }) as never)
  assert.ok(!('drop' in (answer)))
  assert.deepEqual(forwarded, [event])
  assert.ok(('drop' in (await h.submit(h.engine, asPeerPrompt(A_POINTER), h.next))))
})

for (const replay of [false, true]) round18Test(`round19 item 3 / H: P1 drop preserves P2 token for the same file (replay=${replay})`, async () => {
  const h = await round18()
  await h.turnStart('pre')
  await h.turnEnd('other')
  await h.flush()
  let settle!: (value: object) => void
  let fail!: (error: Error) => void
  const event = asPeerPrompt(A_POINTER)
  const p1 = Promise.resolve(h.submit(h.engine, event, (() => new Promise((done, reject) => { settle = done; fail = reject })) as never)).catch(() => {})
  await h.flush()
  await h.submit(h.engine, { ...event }, h.next)
  if (replay) {
    fail(new Error('downstream overrun'))
    await p1
    await h.recover(h.engine, { ...event }, Object.assign(async () => ({ drop: 'P1 drop' }), { called: true }) as never)
  } else { settle({ drop: 'P1 drop' }); await p1 }
  await h.turnEnd('pre')
  await h.flush()
  assert.equal(h.files.has(`${INBOX}/a.json`), true)
  assert.equal(h.files.has(`${PROCESSED}/a.json`), false)
  await h.turnStart('p2')
  await h.turnEnd('p2')
  await h.flush()
  assert.equal(h.files.has(`${PROCESSED}/a.json`), true)
})

for (const outcome of ['entered', 'dropped', 'rejected']) round18Test(`round19 item 4 / J: session.end records unresolved then preserves the late engine outcome (${outcome})`, async () => {
  const h = await round18()
  await h.pendingLeg()
  await h.advance(4000)
  await h.end()
  await h.flush()
  assert.equal(h.status(), 'submitting:unresolved')
  if (outcome === 'rejected') h.reject(new Error('engine rejected at teardown'))
  else h.enter(outcome === 'dropped' ? { drop: 'engine dropped at teardown' } as never : { text: 'entered' })
  await h.flush()
  assert.equal(h.status(), { entered: 'submitted', dropped: 'dropped', rejected: 'deferred:submit-rejected' }[outcome])
  const log = h.files.get(LOG)
  assert.ok(log)
  assert.ok(log.includes('submitting:unresolved'))
})

round18Test('round21 G: bound admission waits for its own completion or a session edge', async () => {
  const h = await round18()
  await h.turnStart('t1')
  await h.submit(h.engine, { ...asPeerPrompt(A_POINTER), turnId: 't1' }, h.next)
  await h.turnStart('t2')
  await h.turnEnd('t2')
  await h.flush()
  assert.equal(h.files.has(`${INBOX}/a.json`), true)
  await h.turnEnd('t1')
  await h.flush()
  assert.equal(h.files.has(`${PROCESSED}/a.json`), true)
})



round18Test('round19 item 7: ninth live prompt cannot evict the first catch replay', async () => {
  const h = await round18()
  h.files.delete(`${INBOX}/a.json`)
  await h.turnStart('pre')
  await h.turnEnd('other')
  await h.flush()
  const events: ReturnType<typeof asPeerPrompt>[] = []
  const pending: Promise<unknown>[] = []
  const settle: ((value: object) => void)[] = []
  let fail!: (error: Error) => void
  for (let i = 0; i < 9; i++) {
    const file = `p${i}.json`
    h.files.set(`${INBOX}/${file}`, ENVELOPE)
    const event = asPeerPrompt(pointerText('alpha', 'beta', file))
    events.push(event)
    pending.push(Promise.resolve(h.submit(h.engine, event, (() => new Promise((done, reject) => { settle.push(done); if (!i) fail = reject })) as never)).catch(() => {}))
    await h.flush()
  }
  fail(new Error('first downstream overran'))
  await pending[0]
  await h.recover(h.engine, { ...events[0]! }, Object.assign(async () => ({ drop: 'first dropped' }), { called: true }) as never)
  for (let i = 1; i < settle.length; i++) settle[i]!({})
  await Promise.all(pending)
  await h.turnEnd('pre')
  await h.flush()
  assert.equal(h.files.has(`${PROCESSED}/p0.json`), true)
  assert.equal(h.files.has(`${INBOX}/p1.json`), true)
})

round18Test('round19 item 9: each claimed and inbox existence read starts together', async () => {
  const h = await round18()
  const exists = h.engine.fs.exists
  let release!: () => void
  const barrier = new Promise<void>(done => { release = done })
  const started: string[] = []
  h.engine.fs.exists = (async (p: string) => {
    if (p === `${CLAIMED}/a.json` || p === `${INBOX}/a.json`) { started.push(p); await barrier }
    return exists(p)
  }) as typeof exists
  const pending = h.submit(h.engine, asPeerPrompt(A_POINTER), h.next)
  await h.flush()
  const beforeRelease = [...started]
  release()
  await pending
  assert.deepEqual(beforeRelease.sort(), [`${CLAIMED}/a.json`, `${INBOX}/a.json`].sort())
})

for (const identical of [false, true]) round18Test(`round22 cap: overflow never binds and the tick delivers after tracked drops (identical=${identical})`, async () => {
  const h = await round18()
  if (!identical) h.files.delete(`${INBOX}/a.json`)
  await h.turnStart('pre')
  await h.turnEnd('other')
  await h.flush()
  const logs: string[] = []
  h.engine.ui.log = (message => { logs.push(message) }) as typeof h.engine.ui.log
  const pending: Promise<unknown>[] = []
  const settle: ((value: object) => void)[] = []
  let newest!: ReturnType<typeof asPeerPrompt>
  for (let i = 0; i < 65; i++) {
    const file = identical ? 'a.json' : `cap${i}.json`
    h.files.set(`${INBOX}/${file}`, ENVELOPE)
    newest = asPeerPrompt(pointerText('alpha', 'beta', file))
    pending.push(Promise.resolve(h.submit(h.engine, newest, (() => new Promise(done => { settle.push(done) })) as never)).catch(() => {}))
    await h.flush()
  }
  assert.ok((await pending[64] as { drop: string }).drop.includes('cap 64'))
  assert.equal(settle.length, 64)
  for (let i = 0; i < 64; i++) settle[i]!({ drop: 'tracked drop' })
  await Promise.all(pending)
  await h.turnEnd('pre')
  await h.flush()
  assert.equal(logs.some(line => line.includes('logErr') && line.includes('64') && line.includes('file waits for the tick')), true)
  // The overflow prompt drops without binding; tracked drops release their own admissions,
  // so the tick can deliver the overflow file.
  // Each tick has a six-claim budget; advance through the queued files.
  for (let i = 0; i < 65 && !h.files.has(`${PROCESSED}/${identical ? 'a.json' : 'cap64.json'}`); i++) { h.tick(); await h.flush() }
  assert.equal(h.files.has(`${PROCESSED}/${identical ? 'a.json' : 'cap64.json'}`), true)
  if (!identical) assert.equal(h.files.has(`${PROCESSED}/cap0.json`), true)
})
