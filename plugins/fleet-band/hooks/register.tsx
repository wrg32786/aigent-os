// fleet-band: a read-only status band above the prompt plus /fires, /pending
// and /held, which answer with no model turn. Fences: no writes outside
// $.state, no network, no permission calls, nothing that submits a prompt,
// and one host process only (`node <installRoot>/daemons/job-results.mjs
// pending`), never started unless that script exists. Every source comes from
// userConfig: an empty one is skipped, never guessed. Every read is
// try/catch: a configured source that cannot be read draws as "?".
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { FleetBandHeld, FleetBandPending, FleetBandSnapshot } from '../types'

const snapshot = atom({ plugin: 'fleet-band', key: 'snapshot' } as const, null)

const REFRESH_MS = 60_000
const STALE_MS = 3 * REFRESH_MS
// $.fs.read rejects files over 4 MiB; stat first so the reason is ours to say.
const FS_READ_CAP = 4 * 1024 * 1024
const TAIL_LINES = 50
const SEAT_NAME = /^[a-z0-9_-]+$/

type $ = EngineInterface

type Config = {
  installRoot: string
  roomRoot: string
  eodPath: string
  watchedSeats: string[]
  showSummaries: boolean
}

const path = (value: unknown) => (typeof value === 'string' ? value.trim().replace(/[\\/]+$/, '') : '')

function readConfig(options: PluginOptions): Config {
  const seats = options.watchedSeats
  const list = Array.isArray(seats) ? seats : typeof seats === 'string' ? seats.split(',') : []
  return {
    installRoot: path(options.installRoot),
    roomRoot: path(options.roomRoot),
    eodPath: path(options.eodPath),
    watchedSeats: list.map(one => String(one).trim().toLowerCase()).filter(one => SEAT_NAME.test(one)),
    showSummaries: options.showSummaries === true,
  }
}

// Module state, reset by a hot reload along with the environment.
let config: Config = readConfig({})
// The job-results script is checked once and remembered: no spawn ever
// happens unless installRoot is set and the script is there.
let jobScript: 'unchecked' | 'present' | 'absent' = 'unchecked'
let timer: Timer | undefined
let lastTickAt = 0

const scriptPath = () => `${config.installRoot}/daemons/job-results.mjs`

async function hasJobScript($: $): Promise<boolean> {
  if (jobScript === 'unchecked') {
    if (!config.installRoot) {
      jobScript = 'absent'
    } else {
      try {
        jobScript = (await $.fs.stat(scriptPath())).kind === 'file' ? 'present' : 'absent'
      } catch {
        jobScript = 'absent'
      }
    }
  }
  return jobScript === 'present'
}

async function seatName($: $): Promise<string> {
  try {
    const fromEnv = (await $.env.get('SEAT'))?.toLowerCase()
    if (fromEnv) return SEAT_NAME.test(fromEnv) ? fromEnv : 'seat'
  } catch {}
  try {
    const base = (await $.session.root()).split(/[\\/]/).filter(Boolean).pop()?.toLowerCase()
    if (base && SEAT_NAME.test(base)) return base
  } catch {}
  return 'seat'
}

async function ctxPercent($: $): Promise<number | null> {
  try {
    const { context } = await $.session.usage()
    return context.percent ?? null
  } catch {
    return null
  }
}

async function roomUnread($: $, seat: string): Promise<number | null> {
  try {
    const entries = await $.fs.list(`${config.roomRoot}/inbox/${seat}`)
    return entries.filter(one => one.kind === 'file' && one.name.endsWith('.json')).length
  } catch {
    return null
  }
}

async function pendingResults($: $): Promise<FleetBandPending[] | null> {
  try {
    const ran = await $.process.run(['node', scriptPath(), 'pending'], {
      cwd: config.installRoot,
      env: { JOB_RESULTS_ROOT: config.installRoot },
      timeoutMs: 20_000,
    })
    if (ran.exitCode !== 0) return null
    const rows: unknown = JSON.parse(ran.stdout)
    if (!Array.isArray(rows)) return null
    return rows.map(row => ({
      id: String(row?.id ?? ''),
      job: String(row?.job ?? ''),
      summary: String(row?.summary ?? ''),
      producedAt: String(row?.produced_at ?? ''),
    }))
  } catch {
    return null
  }
}

async function needsYou($: $): Promise<string[] | null> {
  try {
    const eod = JSON.parse(await $.fs.read(config.eodPath))
    if (!Array.isArray(eod?.needs_you)) return null
    return eod.needs_you.map((row: { title?: unknown }) => String(row?.title ?? '(untitled)'))
  } catch {
    return null
  }
}

async function heldSeat($: $, seat: string): Promise<FleetBandHeld> {
  const log = `${config.roomRoot}/state/${seat}.supervisor.log`
  try {
    if ((await $.fs.stat(log)).size > FS_READ_CAP) return { seat, state: 'unknown', reason: 'log-over-read-cap' }
    const lines = (await $.fs.read(log)).split(/\r?\n/).filter(Boolean).slice(-TAIL_LINES)
    let hold = -1
    let released = -1
    lines.forEach((line, i) => {
      if (/\[refresh-cycle\] HOLD\b/.test(line)) hold = i
      if (/\[refresh-cycle\] .*\breleased\b/.test(line)) released = i
    })
    if (hold < 0) return { seat, state: 'clear', reason: 'no-hold-in-tail' }
    return released > hold
      ? { seat, state: 'clear', reason: 'released' }
      : { seat, state: 'held', reason: 'hold-without-release' }
  } catch {
    return { seat, state: 'unknown', reason: 'log-unreadable' }
  }
}

async function collect($: $): Promise<FleetBandSnapshot> {
  const seat = await seatName($)
  const s: FleetBandSnapshot = { at: await $.clock.now(), seat, ctxPercent: await ctxPercent($) }
  if (config.roomRoot) s.roomUnread = await roomUnread($, seat)
  if (await hasJobScript($)) s.pending = await pendingResults($)
  if (config.eodPath) s.needsYou = await needsYou($)
  if (config.roomRoot && config.watchedSeats.length > 0) {
    s.held = await Promise.all(config.watchedSeats.map(one => heldSeat($, one)))
  }
  return s
}

async function refresh($: $): Promise<FleetBandSnapshot | null> {
  try {
    const next = await collect($)
    await update($, snapshot, () => next)
    return next
  } catch {
    return null
  }
}

// Starts the 60 s timer, or restarts it when it threw or stopped ticking
// (a refused period ends an interval without saying so).
async function ensureTicking($: $): Promise<void> {
  try {
    const now = await $.clock.now()
    if (timer && now - lastTickAt <= STALE_MS) return
    timer?.cancel()
    lastTickAt = now
    timer = $.clock.every(REFRESH_MS, () => {
      void $.clock.now().then(now => {
        lastTickAt = now
      })
      void refresh($)
    })
  } catch {
    timer = undefined
  }
}

const shown = (n: number | null | undefined) => (n === null || n === undefined ? '?' : String(n))

// Fields left to right; only configured ones appear. The band drops from the
// right until it fits.
export function bandFields(s: FleetBandSnapshot): string[] {
  const fields = [s.seat, `ctx ${s.ctxPercent === null ? '?' : `${s.ctxPercent}%`}`]
  if ('roomUnread' in s) fields.push(`room ${shown(s.roomUnread)} unread`)
  if ('pending' in s) fields.push(`results ${shown(s.pending?.length)} pending`)
  if ('needsYou' in s) fields.push(`needs-you ${shown(s.needsYou?.length)}`)
  if (s.held) {
    const names = s.held.filter(one => one.state === 'held').map(one => one.seat)
    const isAnyUnknown = s.held.some(one => one.state === 'unknown')
    const unknown = isAnyUnknown ? '?' : ''
    fields.push(`held: ${names.length > 0 ? [...names, unknown].filter(Boolean).join(',') : unknown || 'none'}`)
  }
  return fields
}

export function fitBand(fields: string[], columns: number, suffix = ''): string {
  const kept = [...fields]
  while (kept.length > 1 && kept.join(' · ').length + suffix.length > columns) kept.pop()
  return kept.join(' · ') + suffix
}

function firesText(s: FleetBandSnapshot | null): string {
  if (jobScript !== 'present') return 'Pending job results: not configured (installRoot unset or its job-results script is missing)'
  if (!s?.pending) return 'Pending job results: ? (the job-results script did not answer)'
  if (s.pending.length === 0) return 'Pending job results: none'
  return [
    `Pending job results: ${s.pending.length}`,
    ...s.pending.map(one => `- ${one.job}  ${one.producedAt}${config.showSummaries ? `  ${one.summary}` : ''}`),
  ].join('\n')
}

function needsText(s: FleetBandSnapshot | null): string {
  if (!config.eodPath) return 'Needs you: not configured (eodPath unset)'
  if (!s?.needsYou) return 'Needs you: ? (the EOD file could not be read)'
  if (s.needsYou.length === 0) return 'Needs you: none'
  return [`Needs you: ${s.needsYou.length}`, ...s.needsYou.map(title => `- ${title}`)].join('\n')
}

function heldText(s: FleetBandSnapshot | null): string {
  if (!config.roomRoot || config.watchedSeats.length === 0) {
    return 'Held seats: not configured (roomRoot or watchedSeats unset)'
  }
  if (!s?.held) return 'Held seats: ? (refresh failed)'
  const word = { held: 'HELD', clear: 'clear', unknown: '?' } as const
  return ['Held seats:', ...s.held.map(one => `- ${one.seat}: ${word[one.state]} (${one.reason})`)].join('\n')
}

const COMMANDS = [
  { name: 'fires', description: 'fleet-band: list pending job results (no model turn)' },
  { name: 'pending', description: 'fleet-band: pending job results plus the EOD needs-you titles (no model turn)' },
  { name: 'held', description: 'fleet-band: held state of each watched seat (no model turn)' },
]

async function registerCommands($: $): Promise<void> {
  for (const command of COMMANDS) {
    try {
      await $.command.register(command)
    } catch {}
  }
}

export const register: Register = (on, options) => {
  config = readConfig(options)

  on('session.start', async ($, e, next) => {
    await registerCommands($)
    await ensureTicking($)
    void refresh($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await ensureTicking($)
    void refresh($)
    return next(e)
  })

  on('command.run', { command: 'fires' }, async $ => {
    await ensureTicking($)
    return { text: firesText(await refresh($)) }
  }).catch(() => ({ text: 'fleet-band: /fires could not read its sources' }))

  on('command.run', { command: 'pending' }, async $ => {
    await ensureTicking($)
    const s = await refresh($)
    return { text: `${firesText(s)}\n\n${needsText(s)}` }
  }).catch(() => ({ text: 'fleet-band: /pending could not read its sources' }))

  on('command.run', { command: 'held' }, async $ => {
    await ensureTicking($)
    return { text: heldText(await refresh($)) }
  }).catch(() => ({ text: 'fleet-band: /held could not read its sources' }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapshot)
    if (e.props.hasSurvey || s === null) return next(e)
    const { Text } = $.ui.resolve(e)
    const isStale = (await $.clock.now()) - s.at > STALE_MS
    return (
      <Text dimColor wrap="truncate">
        {fitBand(bandFields(s), Math.min(100, e.props.bodyColumns), isStale ? ' (stale)' : '')}
      </Text>
    )
  })
}
