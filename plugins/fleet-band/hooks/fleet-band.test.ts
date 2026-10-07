import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// Example install; no real machine's paths or seats.
const ROOT = 'C:/example/aigent'
const ROOM = 'C:/example/room'
const EOD = 'C:/example/eod/latest.json'
const MIB = 1024 * 1024
// The engine hands the hook the path in the host's own spelling.
const norm = (path: string) => path.replace(/\\/g, '/')

const CONFIGURED = {
  options: { installRoot: ROOT, roomRoot: ROOM, eodPath: EOD, watchedSeats: ['alpha', 'beta', 'gamma'] },
}

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const

const RUN = { args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

const LOGS: Record<string, string> = {
  [`${ROOM}/state/alpha.supervisor.log`]: [
    '[supervisor:alpha] [refresh-cycle] resume-done released seat=alpha capsule=null',
    '[supervisor:alpha] [refresh-cycle] HOLD seat=alpha code=capsule-done-before-request-submit',
    '[supervisor:alpha] inject submit: held unarchived until it runs (released later)',
  ].join('\n'),
  [`${ROOM}/state/beta.supervisor.log`]: [
    '[supervisor:beta] [refresh-cycle] HOLD seat=beta code=lifecycle-fast-forward',
    '[supervisor:beta] [refresh-cycle] resume-done released seat=beta capsule=x',
  ].join('\n'),
}

const ran = (exitCode: number, stdout: string) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// The world beneath the plugin: a configured fleet, gamma's log over the read cap.
type World = {
  env?: Record<string, string>
  process?: 'ok' | 'throw' | 'deny'
  isScriptMissing?: boolean
  isTimerRefused?: boolean
}

function fleet(on: On, world: World = {}) {
  // A refused timer needs a hand-rolled clock: mock.clock owns clock.every.
  let now = 1_000
  const clock = world.isTimerRefused ? { advance: async (ms: number) => void (now += ms) } : mock.clock(on, { now })
  if (world.isTimerRefused) {
    on('clock.now', () => ({ value: now }))
    on('clock.every', () => ({ deny: 'no timers' }))
  }
  mock.env(on, world.env ?? { SEAT: 'main' })
  on('session.root', () => ({ value: 'C:/example/Main' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, tokens: 84_000, percent: 42 }, rateLimits: [] },
  }))
  on('fs.list', ($, e) => {
    if (norm(e.path) !== `${ROOM}/inbox/main`) return { deny: 'ENOENT' }
    const file = (name: string) => ({ name, kind: 'file' as const, size: 10, mtimeMs: 1, isLink: false })
    const dir = { name: 'corrupt', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }
    return { value: [file('a.json'), file('b.json'), file('c.json'), dir] }
  })
  on('fs.stat', ($, e) => {
    if (world.isScriptMissing && norm(e.path).endsWith('job-results.mjs')) return { deny: 'ENOENT' }
    const size = norm(e.path).includes('gamma') ? 900 * MIB : 1_000
    return { value: { kind: 'file' as const, size, mtimeMs: 1, isLink: false } }
  })
  on('fs.read', ($, e) => {
    if (norm(e.path) === EOD) {
      return { value: JSON.stringify({ needs_you: [{ title: 'Approve the draft' }, { title: 'Clear a pane' }] }) }
    }
    const log = LOGS[norm(e.path)]
    return log === undefined ? { deny: 'ENOENT' } : { value: log }
  })
  on('process.run', ($, e) => {
    if (world.process === 'throw') throw new Error('this world must not spawn')
    if (world.process === 'deny') return { deny: 'refused by policy' }
    expect(e.argv).toEqual(['node', `${ROOT}/daemons/job-results.mjs`, 'pending'])
    expect(e.init?.env).toEqual({ JOB_RESULTS_ROOT: ROOT })
    const rows = [{ id: 'r1', job: 'triage', summary: 'secret free text', produced_at: '2026-10-07T15:00:00Z' }]
    return ran(0, JSON.stringify(rows))
  })
  return clock
}

test('a configured band shows every field and drops from the right when narrow', CONFIGURED, async ($, on) => {
  fleet(on)
  const fires = await $.command.run({ command: 'fires', ...RUN })
  expect(fires.text).toContain('triage  2026-10-07T15:00:00Z')
  expect(fires.text).not.toContain('secret free text')

  for (const surface of SURFACES) {
    const wide = await $.ui.mount({ plugin: 'fleet-band', surface, ...BAND })
    expect((await wide.find({ type: 'Text', text: /main/ }))?.text).toBe(
      'main · ctx 42% · room 3 unread · results 1 pending · needs-you 2 · held: alpha,?',
    )
    await wide.unmount()

    const narrow = await $.ui.mount({ plugin: 'fleet-band', surface, ...BAND, props: { ...BAND.props, bodyColumns: 25 } })
    expect((await narrow.find({ type: 'Text', text: /main/ }))?.text).toBe('main · ctx 42%')
    await narrow.unmount()
  }
})

test('/fires prints summaries only when showSummaries is on', { options: { ...CONFIGURED.options, showSummaries: true } }, async ($, on) => {
  fleet(on)
  expect((await $.command.run({ command: 'fires', ...RUN })).text).toContain('secret free text')
})

test('/pending and /held print titles and reason classes, never log lines', CONFIGURED, async ($, on) => {
  fleet(on)
  const pending = await $.command.run({ command: 'pending', ...RUN })
  expect(pending.text).toContain('- Clear a pane')

  const held = await $.command.run({ command: 'held', ...RUN })
  expect(held.text).toContain('alpha: HELD (hold-without-release)')
  expect(held.text).toContain('beta: clear (released)')
  expect(held.text).toContain('gamma: ? (log-over-read-cap)')
  expect(held.text).not.toContain('supervisor:')
})

test('a stock install shows seat and ctx only and never spawns', async ($, on) => {
  fleet(on, { process: 'throw' })
  expect((await $.command.run({ command: 'fires', ...RUN })).text).toContain('not configured')
  expect((await $.command.run({ command: 'held', ...RUN })).text).toContain('not configured')
  expect((await $.command.run({ command: 'pending', ...RUN })).text).toContain('Needs you: not configured')
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: 'fleet-band', surface, ...BAND })
    expect((await band.find({ type: 'Text', text: /main/ }))?.text).toBe('main · ctx 42%')
    await band.unmount()
  }
})

test('a missing job-results script is skipped with no spawn', CONFIGURED, async ($, on) => {
  fleet(on, { isScriptMissing: true, process: 'throw' })
  expect((await $.command.run({ command: 'fires', ...RUN })).text).toContain('not configured')
})

test('a denied process draws results as ?', CONFIGURED, async ($, on) => {
  fleet(on, { process: 'deny' })
  expect((await $.command.run({ command: 'fires', ...RUN })).text).toContain('Pending job results: ?')
  const band = await $.ui.mount({ plugin: 'fleet-band', surface: 'terminal', ...BAND })
  expect((await band.find({ type: 'Text', text: /main/ }))?.text).toContain('results ? pending')
})

test('seat comes from the session root without SEAT', async ($, on) => {
  fleet(on, { env: {} })
  await $.command.run({ command: 'held', ...RUN })
  const band = await $.ui.mount({ plugin: 'fleet-band', surface: 'terminal', ...BAND })
  expect((await band.find({ type: 'Text', text: /ctx/ }))?.text).toBe('main · ctx 42%')
})

test('an invalid SEAT falls back to "seat"', async ($, on) => {
  fleet(on, { env: { SEAT: 'Bad Seat!' } })
  await $.command.run({ command: 'held', ...RUN })
  const band = await $.ui.mount({ plugin: 'fleet-band', surface: 'terminal', ...BAND })
  expect((await band.find({ type: 'Text', text: /ctx/ }))?.text).toBe('seat · ctx 42%')
})

test('configured sources that fail draw as ? on every surface and never throw', CONFIGURED, async ($, on) => {
  mock.clock(on, { now: 1_000 })
  mock.env(on, { SEAT: 'main' })
  on('session.usage', () => ({ deny: 'no usage' }))
  on('fs.list', () => ({ deny: 'ENOENT' }))
  on('fs.stat', ($, e) =>
    norm(e.path).endsWith('job-results.mjs')
      ? { value: { kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false } }
      : { deny: 'ENOENT' },
  )
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('process.run', () => ran(1, ''))

  expect((await $.command.run({ command: 'fires', ...RUN })).text).toContain('?')
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: 'fleet-band', surface, ...BAND })
    expect((await band.find({ type: 'Text', text: /main/ }))?.text).toBe(
      'main · ctx ? · room ? unread · results ? pending · needs-you ? · held: ?',
    )
    await band.unmount()
  }
})

test('a refused timer leaves the snapshot to age into (stale)', CONFIGURED, async ($, on) => {
  const clock = fleet(on, { isTimerRefused: true })
  await $.command.run({ command: 'held', ...RUN })
  await clock.advance(4 * 60_000)
  const band = await $.ui.mount({ plugin: 'fleet-band', surface: 'terminal', ...BAND })
  expect((await band.find({ type: 'Text', text: /main/ }))?.text).toMatch(/ \(stale\)$/)
})
