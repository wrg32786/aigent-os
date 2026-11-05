import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { resumeLine } from './register'

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
  root?: string
  now?: number
  // Raw text of room/state/main.resume-pending; absent means no file.
  resume?: string
  logs?: { text: string; to: string }[]
}

function fleet(on: On, world: World = {}) {
  // A refused timer needs a hand-rolled clock: mock.clock owns clock.every.
  let now = world.now ?? 1_000
  const clock = world.isTimerRefused ? { advance: async (ms: number) => void (now += ms) } : mock.clock(on, { now })
  if (world.isTimerRefused) {
    on('clock.now', () => ({ value: now }))
    on('clock.every', () => ({ deny: 'no timers' }))
  }
  mock.env(on, world.env ?? { SEAT: 'main' })
  on('session.root', () => ({ value: world.root ?? 'C:/example/Main' }))
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
    if (norm(e.path) === `${ROOM}/state/main.resume-pending`) {
      return world.resume === undefined ? { deny: 'ENOENT' } : { value: world.resume }
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
  on('ui.log', ($, e) => {
    world.logs?.push({ text: e.text, to: e.to })
    return { value: undefined }
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

test('a "-vault" install folder names the seat without the suffix', async ($, on) => {
  fleet(on, { env: {}, root: 'C:/example/Beta-Vault' })
  await $.command.run({ command: 'held', ...RUN })
  const band = await $.ui.mount({ plugin: 'fleet-band', surface: 'terminal', ...BAND })
  expect((await band.find({ type: 'Text', text: /ctx/ }))?.text).toBe('beta · ctx 42%')
})

test('AIGENT_SEAT wins over the install folder', async ($, on) => {
  fleet(on, { env: { AIGENT_SEAT: 'gamma' }, root: 'C:/example/Beta-Vault' })
  await $.command.run({ command: 'held', ...RUN })
  const band = await $.ui.mount({ plugin: 'fleet-band', surface: 'terminal', ...BAND })
  expect((await band.find({ type: 'Text', text: /ctx/ }))?.text).toBe('gamma · ctx 42%')
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

// Resume-pending: room/state/<seat>.resume-pending, written by the supervisor.
const NOW = Date.parse('2026-11-04T05:44:19.056Z')
const pending = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    state: 'waiting',
    since: '2026-11-04T03:44:19.056Z',
    capsule: '2026-11-03-land-everything-davinci',
    detail: 'mod ledger deferred:composer-busy',
    pid: 12540,
    ...over,
  })

async function bandText($: Parameters<Parameters<typeof test>[2]>[0]) {
  await $.command.run({ command: 'held', ...RUN }) // a refresh fills the snapshot the band draws
  const band = await $.ui.mount({ plugin: 'fleet-band', surface: 'terminal', ...BAND })
  const text = (await band.find({ type: 'Text', text: /main/ }))?.text ?? ''
  await band.unmount()
  return text
}

const RESUME_CASES: [string, Record<string, unknown>, string][] = [
  ['waiting', { since: '2026-11-04T05:14:19.056Z' }, 'resume: waiting (deferred:composer-busy, 30m)'],
  ['waiting at 59m', { since: '2026-11-04T04:45:19.056Z' }, 'resume: waiting (deferred:composer-busy, 59m)'],
  ['waiting past 60m', {}, 'resume: stale (2h)'],
  ['submitted past 60m', { state: 'submitted', since: '2026-11-04T03:44:19.056Z' }, 'resume: stale (2h)'],
  ['failed however old', { state: 'failed', pid: 1 }, 'resume: FAILED'],
  ['waiting door', { detail: 'door: held by lock', since: '2026-11-04T05:43:00.000Z' }, 'resume: waiting (held by lock, 1m)'],
  ['submitted', { state: 'submitted', detail: 'mod ledger submitted', since: '2026-11-04T05:42:00.000Z' }, 'resume: submitted (2m)'],
  ['null capsule', { capsule: null, since: '2026-11-04T05:14:19.056Z' }, 'resume: waiting (deferred:composer-busy, 30m)'],
  ['failed', { state: 'failed', detail: 'refused by the mod (error:submit-failed)' }, 'resume: FAILED'],
]

for (const [name, over, want] of RESUME_CASES) {
  test(`resume-pending ${name} renders ${want}`, { options: CONFIGURED.options }, async ($, on) => {
    fleet(on, { now: NOW, resume: pending(over) })
    expect(await bandText($)).toContain(`main · ctx 42% · ${want} · room 3 unread`)
  })
}

// The mod sandbox has no process, so stale is an age rule and pid is not read.
test('resume-pending stale is age only: 61m is stale, 60m is not, failed never', () => {
  const at = (min: number, over = {}) => JSON.parse(pending({ since: new Date(NOW - min * 60_000).toISOString(), ...over }))
  expect(resumeLine(at(60), NOW)).toBe('resume: waiting (deferred:composer-busy, 1h)')
  expect(resumeLine(at(61), NOW)).toBe('resume: stale (1h)')
  expect(resumeLine(at(61, { pid: 1 }), NOW)).toBe('resume: stale (1h)')
  expect(resumeLine(at(3000, { state: 'failed' }), NOW)).toBe('resume: FAILED')
})

test('resume-pending detail is capped at 300 chars', () => {
  const since = new Date(NOW - 5 * 60_000).toISOString()
  expect(resumeLine(JSON.parse(pending({ detail: 'x'.repeat(500), since })), NOW)).toBe(`resume: waiting (${'x'.repeat(300)}, 5m)`)
})

test('resume-pending absent shows nothing', CONFIGURED, async ($, on) => {
  fleet(on, { now: NOW })
  expect(await bandText($)).not.toContain('resume')
})

test('resume-pending v other than 1 shows nothing and logs one debug line', CONFIGURED, async ($, on) => {
  const logs: { text: string; to: string }[] = []
  fleet(on, { now: NOW, resume: pending({ v: 2 }), logs })
  expect(await bandText($)).not.toContain('resume')
  expect(logs.filter(one => one.to === 'debug' && /resume-pending/.test(one.text))).toHaveLength(1)
})

test('resume-pending malformed shows nothing and logs one debug line', CONFIGURED, async ($, on) => {
  const logs: { text: string; to: string }[] = []
  fleet(on, { now: NOW, resume: '{not json', logs })
  expect(await bandText($)).not.toContain('resume')
  expect(logs.filter(one => one.to === 'debug' && /resume-pending/.test(one.text))).toHaveLength(1)
})

test('resume-pending is never read when roomRoot is unset', async ($, on) => {
  fleet(on, { now: NOW, resume: pending() })
  expect(await bandText($)).toBe('main · ctx 42%')
})
