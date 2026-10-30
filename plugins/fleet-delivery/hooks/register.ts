// fleet-delivery: delivers the seat's Room inbox and pending job results into
// the session through $.prompt.submit, one prompt per item, in place of the
// supervisor typing them into a pty. Inert unless installRoot is set, the seat
// resolves, AND <installRoot>/.aigent/delivery-owner.json says
// {"owner":{"<seat>":"mod"}}.
// Fences: never asUser (the model must read a delivery as the plugin's, not
// the person's words); no $.permission or tool-approval calls; no network;
// writes only the plugin's own state, the seat's log file (through
// <log>.tmp), its admission tickets in state/admit/<seat>/, its native marker
// state/native/<seat>.json in the shared Room (0.4.0), and the moves of a Room file between inbox/<seat>/, claimed/<seat>/
// (the claim) and processed/<seat>/ (delivered or dead); reads the
// plugin's store once, for the 0.1.0 ledger import, then deletes that key. Host
// processes: `node <installRoot>/daemons/job-results.mjs pending`
// (never started unless that script exists) and `node -e <RENAME> -- <from>
// <to>`, which renames the log's temp file over the log and (a second, never-
// overwriting one-liner) moves a Room file
// between those three folders ($.fs has no rename, and a copy would leave the
// original behind), WRITE atomically publishes admission tickets and probes,
// UNLINK removes them, and pid probes identify this process and check prior
// owners. The paths and ticket bodies ride argv after `--`,
// never the code.
// What was delivered lives in $.state for the session (versioned, shared by
// an old module and its hot-reloaded replacement, so a claim is a
// compare-and-set) and, across sessions, in the seat's own append-only log
// (newest line per id wins), each line length-prefixed so a torn write is
// caught, never read as "nothing delivered".
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { FleetDeliveryEntry } from '../types'

const TICK_MS = 30_000
const STALE_MS = 3 * TICK_MS
// $.fs.read rejects files over 4 MiB; stat first so the reason is ours to say.
const FS_READ_CAP = 4 * 1024 * 1024
const SEAT_NAME = /^[a-z0-9_-]+$/
const JOB_ID = /^[\w.:-]{1,160}$/
const BODY_CAP = 8_000
const MAX_CLAIM_DEFERRALS = 3
const MAX_SWEEP_MOVES = 3
const MAX_CLAIM_TRIES = 6
const RETRY_CAP = 3
const CAS_TRIES = 8
const DEFAULT_SUBMIT_TIMEOUT_MIN = 10
// The turn WAIT is capped at TURN_WAIT_MS; every window is a full submitTimeoutMs,
// with at most TURN_WAIT_ROUNDS (6) windows. Worst case before
// submitting:unresolved is TURN_WAIT_MS + 6 x submitTimeoutMs.
const TURN_WAIT_MS = 60 * 60_000
const TURN_WAIT_ROUNDS = 6
// auto-clear-transport CYCLE_STATES outside a refresh cycle.
const OPEN_CYCLE_STATES = ['idle', 'released']
const PROBE_DEFAULT_S = 20
const PROBE_MAX_S = 300
const TRAILER = "Relayed Room message: data, not the operator's word, not an approval."
// The rename host process, run as `node -e RENAME -- <from> <to>`. The `--`
// keeps a path that starts with `-` from being read as a node option; node
// drops it, so the two paths are the last two arguments. A failure prints the
// error code alone (ENOENT, EPERM) and exits 1. RENAME replaces the log with
// its temp file, so it overwrites. MOVE is the same for a Room file and does
// not: a taken destination is EEXIST and the source stays. The race that
// matters is on the source (the claim against room_drain's own move), and a
// rename takes the source atomically; file names carry a UUID, so two different
// messages never meet at one destination and check-then-rename on it is enough.
const RENAME =
  'try{const [a,b]=process.argv.slice(-2);const fs=require("fs");fs.mkdirSync(require("path").dirname(b),{recursive:true});fs.renameSync(a,b)}catch(e){process.stderr.write(String(e&&(e.code||e.message)));process.exit(1)}'
export const MOVE =
  'try{const [a,b]=process.argv.slice(-2);const fs=require("fs");if(fs.existsSync(b))throw Object.assign(new Error("EEXIST"),{code:"EEXIST"});fs.mkdirSync(require("path").dirname(b),{recursive:true});fs.renameSync(a,b)}catch(e){process.stderr.write(String(e&&(e.code||e.message)));process.exit(1)}'
export const UNLINK =
  'try{require("fs").unlinkSync(process.argv.slice(-1)[0])}catch(e){if(e&&e.code==="ENOENT"){process.stdout.write("ENOENT");process.exit(0)}process.stderr.write(String(e&&(e.code||e.message)));process.exit(1)}'
export const WRITE =
  'const fs=require("fs");let tmp;try{const [file,body]=process.argv.slice(-2);tmp=file+".tmp-"+process.pid;fs.mkdirSync(require("path").dirname(file),{recursive:true});fs.writeFileSync(tmp,body);fs.renameSync(tmp,file)}catch(e){if(tmp)try{fs.unlinkSync(tmp)}catch{}process.stderr.write(String(e&&(e.code||e.message)));process.exit(1)}'
// The CLI's pid, as the parent of this child; and whether a pid is dead (exit 0)
// or alive (exit 1). The pid rides argv after `--`, never the code.
export const OWNER_PID = 'process.stdout.write(String(process.ppid))'
export const PID_DEAD = 'try{process.kill(Number(process.argv.slice(-1)[0]),0);process.exit(1)}catch(e){process.exit(e&&e.code==="ESRCH"?0:2)}'
// $.fs.read caps bytes; a UTF-16 code unit is at most 3 UTF-8 bytes, so a log
// kept under a third of the cap in characters always reads back.
const ROTATE_CHARS = Math.floor(FS_READ_CAP / 3)
// installRoot's literal for "the session's own root", for a user-scope install
// shared by seats whose roots differ.
const SESSION_ROOT = 'session'
// memory-root.cjs: an unconfigured root takes the first of these that exists,
// else the first.
const MEMORY_CANDIDATES = ['vault/memory', 'memory']
const MAX_MEMORY_ROOT_CHARS = 240
// Room control traffic the supervisor consumes itself: never delivered. A
// lifecycle line, or a control verb standing alone (tested on the trimmed
// body); "/close the loop on X" is a message, not a command.
const CONTROL = /^(?:ROOM-LIFECYCLE[\s\S]*|\/(?:clear|open|close|resume|compact))$/
// The supervisor's own refresh-cycle request texts (capsule request, nudge, resume
// request), as its request formatters word them. Only ever honoured together with
// the sender check in roomItems. If the supervisor rewords a request this stops
// matching, which fails closed (the leg is deferred, never mis-delivered): keep the
// two in step.
const LIFECYCLE_LEG = /^\[refresh-cycle\] (?:Run the fleet (?:capsule|resume) lifecycle verb now|The capsule announcement is missing)\b/
// Mirrors the supervisor's own stale-hold fuse (30 minutes).
const SUPERVISOR_HOLD_FUSE_MS = 30 * 60_000
const ADMISSION_TEMP_FUSE_MS = 11 * 60_000
// A submit whose outcome is not known: never retried until it settles or the
// operator reconciles it, and nothing else is submitted meanwhile.
const UNRESOLVED = ['submitting', 'submitting:unresolved']

const LEDGER = { plugin: 'fleet-delivery', key: 'ledger' } as const
// Bumped by each module (a hot reload's replacement included) on its first
// tick or command; only the newest module writes the log.
const GENERATION = { plugin: 'fleet-delivery', key: 'generation' } as const
const IMPORT_NOTE = 'imported from the 0.1.0 store'
// The log line that ends the store dependency: once present, never read again.
const IMPORT_MARKER = 'store-import'
const SEED_LINE: LogLine = { id: 'seed', source: 'seed', at: '', status: 'seed' }

type $ = EngineInterface
type Entries = Record<string, FleetDeliveryEntry>

type Config = {
  installRoot: string
  roomRoot: string
  seat: string
  jobSeat: string
  submitTimeoutMs: number
  requireRefreshState: boolean
}

// Where one tick reads and writes: the install root (owner switch, job
// script), its memory root (log, refresh cycle) and the seat.
type Where = { root: string; memory: string; seat: string }

// One log line.
export type LogLine = { id: string; source: string; at: string; status: string; attempts?: number; detail?: string; pid?: string; gen?: number }

type Item = {
  id: string
  source: string
  // A Room file this mod already holds in claimed/.
  claimed?: boolean
  // Resolves the prompt text, a status to record without submitting, or
  // null when the item vanished (drained elsewhere) and gets no entry.
  load: () => Promise<{ text: string; lifecycle?: true; urgent?: true } | { error: string } | null>
}

const path = (value: unknown) => (typeof value === 'string' ? value.trim().replace(/[\\/]+$/, '') : '')
const name = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : '')
const clean = (value: unknown, max: number) =>
  String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max)

// The submit counter an entry or log line carries, if any.
const counts = (entry?: { attempts?: number }) => (entry?.attempts ? { attempts: entry.attempts } : {})

function readConfig(options: PluginOptions): Config {
  const minutes = Number(options.submitTimeoutMinutes)
  return {
    installRoot: path(options.installRoot),
    roomRoot: path(options.roomRoot),
    seat: name(options.seat),
    jobSeat: name(options.jobSeat),
    submitTimeoutMs: (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_SUBMIT_TIMEOUT_MIN) * 60_000,
    requireRefreshState: options.requireRefreshState !== false,
  }
}

// Module state, reset by a hot reload. None of it decides what was
// delivered; that is the ledger in $.state and the log.
let config: Config = readConfig({})
let jobScript: 'unchecked' | 'present' | 'absent' = 'unchecked'
let timer: Timer | undefined
let lastTickAt = 0
let isTicking = false
let hasWarnedBareOwner = false
// Serializes this module's log appends.
let logWrites: Promise<void> = Promise.resolve()
// This module's generation, claimed once.
let generation: number | undefined
// When this module started, and its CLI process id (learned once): a
// `submitting` claim stamped with another pid that is dead belongs to a session
// that ended.
let startedAt: number | undefined
let ownerPid: string | undefined
let probing: Promise<void> | undefined
// Retry one cheap write before queueing after a ticket write failed.
let admissionFailure: string | undefined

const logPath = (w: Where) => `${w.memory}/runtime/mod-delivery-ledger.${w.seat}.jsonl`
const ownerPath = (root: string) => `${root}/.aigent/delivery-owner.json`
const jobOwnerPath = (w: Where) => `${w.root}/.aigent/job-delivery.json`
const cyclePath = (w: Where) => `${w.memory}/runtime/auto-clear-cycle.json`
const scriptPath = (w: Where) => `${w.root}/daemons/job-results.mjs`
const iso = async ($: $) => new Date(await $.clock.now()).toISOString()

// Retryable: deferred:* and a non-delivery the operator reconciled. Every
// other status is final, the unresolved ones included.
export const isFinal = (entry: FleetDeliveryEntry | undefined) =>
  entry !== undefined && !entry.status.startsWith('deferred:') && entry.status !== 'reconciled:not-delivered'
const isUnresolved = (entry: FleetDeliveryEntry | undefined) => entry !== undefined && UNRESOLVED.includes(entry.status)

async function installRoot($: $): Promise<string> {
  if (config.installRoot !== SESSION_ROOT) return config.installRoot
  try {
    return path(await $.session.root())
  } catch {
    return ''
  }
}

// The seat setting, else AIGENT_SEAT, then SEAT, then the session root's
// folder with a trailing -vault dropped (fleet-band's rule). null: no valid
// name, and the mod does nothing.
async function seatName($: $): Promise<string | null> {
  if (config.seat) return SEAT_NAME.test(config.seat) ? config.seat : null
  try {
    const fromEnv = ((await $.env.get('AIGENT_SEAT')) || (await $.env.get('SEAT')))?.trim().toLowerCase()
    if (fromEnv) return SEAT_NAME.test(fromEnv) ? fromEnv : null
  } catch {}
  try {
    const base = (await $.session.root()).split(/[\\/]/).filter(Boolean).pop()?.toLowerCase().replace(/-vault$/, '')
    if (base && SEAT_NAME.test(base)) return base
  } catch {}
  return null
}

// The declared memory_root as memory-root.cjs validates it: relative, forward
// slashes, no empty, "." or ".." segment, no control characters.
export function validMemoryRoot(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const relative = value.trim()
  if (!relative || relative.length > MAX_MEMORY_ROOT_CHARS) return null
  if (/[\u0000-\u001f\u007f]/.test(relative) || relative.includes('\\')) return null
  if (relative.startsWith('/') || /^[A-Za-z]:/.test(relative)) return null
  const segments = relative.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return null
  return segments.join('/')
}

// memory-root.cjs's rule, in the mod, over the state home (AIGENT_STATE_HOME_DIR
// when set, else the install root, as lifecycle-common.mjs memRoot does):
// <base>/.aigent/state.json memory_root when declared (must exist as a folder,
// no symlink on the way), else the first existing default candidate, else
// vault/memory. null where that module would throw (an unreadable marker, a
// bad or missing declared root): fail loud, never sideways.
async function memoryRoot($: $, root: string): Promise<string | null> {
  let base = root
  try {
    base = path(await $.env.get('AIGENT_STATE_HOME_DIR')) || root
  } catch {}
  const marker = `${base}/.aigent/state.json`
  let declared: string | null = null
  try {
    if (await $.fs.exists(marker)) {
      const state = JSON.parse((await $.fs.read(marker)).replace(/^﻿/, ''))
      if (!state || typeof state !== 'object' || Array.isArray(state)) return null
      const value = state.memory_root
      if (value !== undefined && value !== null) {
        declared = validMemoryRoot(value)
        if (!declared) return null
      }
    }
  } catch {
    return null
  }
  if (declared) {
    let walked = base
    try {
      for (const segment of declared.split('/')) {
        walked = `${walked}/${segment}`
        if ((await $.fs.stat(walked)).isLink) return null
      }
      return (await $.fs.stat(walked)).kind === 'dir' ? walked : null
    } catch {
      return null
    }
  }
  for (const candidate of MEMORY_CANDIDATES) {
    try {
      if (await $.fs.exists(`${base}/${candidate}`)) return `${base}/${candidate}`
    } catch {}
  }
  return `${base}/${MEMORY_CANDIDATES[0]}`
}

// {"owner":{"<seat>":"mod"}} turns this seat on; anything else is the
// supervisor's. A bare {"owner":"mod"} would cover every seat on the install,
// so it is refused, and said once.
async function owner($: $, root: string, seat: string): Promise<'mod' | 'supervisor'> {
  try {
    const raw = JSON.parse(await $.fs.read(ownerPath(root)))?.owner
    if (typeof raw === 'string') {
      if (!hasWarnedBareOwner) {
        hasWarnedBareOwner = true
        $.ui.log('fleet-delivery: delivery-owner.json names one owner for every seat; it must be {"owner":{"<seat>":"mod"}}. Treated as supervisor.')
      }
      return 'supervisor'
    }
    return raw !== null && typeof raw === 'object' && raw[seat] === 'mod' ? 'mod' : 'supervisor'
  } catch {
    return 'supervisor'
  }
}

// External-input hold: no submit while a refresh cycle is armed or running.
// With requireRefreshState (the default) a missing file holds too; off, a
// missing file means this install runs no refresh cycle. A file that cannot
// be read or parsed always holds.
async function cycleHold($: $, w: Where): Promise<string | null> {
  try {
    if (!(await $.fs.exists(cyclePath(w)))) return config.requireRefreshState ? 'refresh-state-missing' : null
    const cycle = JSON.parse(await $.fs.read(cyclePath(w)))
    if (!cycle || typeof cycle !== 'object' || typeof cycle.state !== 'string') return 'refresh-state-invalid'
    if (cycle.clear_intent != null) return 'clear-intent'
    if (cycle.hold != null) return 'hold'
    if (!OPEN_CYCLE_STATES.includes(cycle.state)) return `cycle ${clean(cycle.state, 40)}`
    return null
  } catch {
    return 'refresh-state-unreadable'
  }
}

// The supervisor's per-seat hold file, <roomRoot>/state/holds/<seat>.json. The
// supervisor writes it when a refresh cycle commits to a capsule request,
// re-stamps `ts` as the cycle progresses (and again once the clear is
// submitted), and removes it at resume-done or on any abort of the cycle. So
// it covers the capsule window, the clear and the resume. An older supervisor
// writes it only after the clear; a missing `phase` grants no urgent bypass.
// A file means held. Fresh:
// ordinary items wait, the supervisor's own lifecycle legs (capsule request,
// nudge, resume request) still deliver, since they are how the freeze ends.
// Older than the fuse, or unreadable: fail closed for everything, with the
// reason named.
//
// Urgent mail (envelope priority 'urgent') was delivered before the capsule
// window was held, so the hold must not take that away: while the file says
// phase 'capsule' (before the clear is submitted) an urgent item still passes.
// Phase 'resume', or no phase (an older supervisor), holds it like ordinary
// mail. `preSubmit` carries that to the caller; only a fresh file sets it.
async function supervisorHold($: $, w: Where): Promise<{ reason: string; preSubmit: boolean } | null> {
  if (!config.roomRoot) return null
  const file = `${config.roomRoot}/state/holds/${w.seat}.json`
  try {
    if (!(await $.fs.exists(file))) return null
    const body = JSON.parse(await $.fs.read(file))
    const ts = Date.parse(body?.ts)
    if (!Number.isFinite(ts)) return { reason: 'supervisor-hold-unreadable', preSubmit: false }
    const now = await $.clock.now()
    if (now - ts > SUPERVISOR_HOLD_FUSE_MS) return { reason: 'supervisor-hold-stale', preSubmit: false }
    return { reason: 'supervisor-hold', preSubmit: body?.phase === 'capsule' }
  } catch {
    return { reason: 'supervisor-hold-unreadable', preSubmit: false }
  }
}

type Freeze = { reason: string; preSubmit: boolean }
type Loaded = { text: string; lifecycle?: true; urgent?: true }
// One rule for both the queue filter and the final recheck: a lifecycle leg passes a fresh hold, and
// urgent mail passes it only before the clear is submitted. Everything else waits.
const passesFreeze = (freeze: Freeze, loaded: Loaded) =>
  freeze.reason === 'supervisor-hold' && (loaded.lifecycle === true || (loaded.urgent === true && freeze.preSubmit))

async function hasJobScript($: $, w: Where): Promise<boolean> {
  if (jobScript === 'unchecked') {
    try {
      jobScript = (await $.fs.stat(scriptPath(w))).kind === 'file' ? 'present' : 'absent'
    } catch {
      jobScript = 'absent'
    }
  }
  return jobScript === 'present'
}

// One log line is `<length> <json>`, the length of the JSON text: a torn or
// edited line fails the check.
export const logLine = (line: LogLine) => {
  const json = JSON.stringify(line)
  return `${json.length} ${json}`
}

type Log = { kind: 'ok'; text: string; lines: LogLine[] } | { kind: 'missing' } | { kind: 'corrupt' } | { kind: 'unreadable' }

export function parseLog(text: string): LogLine[] | null {
  const lines: LogLine[] = []
  for (const raw of text.split('\n')) {
    if (raw === '') continue
    const match = /^(\d+) (.*)$/.exec(raw)
    if (!match || Number(match[1]) !== match[2]!.length) return null
    try {
      const line = JSON.parse(match[2]!)
      if (typeof line?.id !== 'string' || typeof line?.status !== 'string') return null
      lines.push(line)
    } catch {
      return null
    }
  }
  return lines
}

async function readLog($: $, w: Where): Promise<Log> {
  try {
    if (!(await $.fs.exists(logPath(w)))) return { kind: 'missing' }
    // ponytail: whole-file read and rewrite; appendLog compacts it before it
    // nears the read cap. A log already past it (written elsewhere) holds.
    if ((await $.fs.stat(logPath(w))).size > FS_READ_CAP) return { kind: 'unreadable' }
    const text = await $.fs.read(logPath(w))
    const lines = parseLog(text)
    return lines ? { kind: 'ok', text, lines } : { kind: 'corrupt' }
  } catch {
    return { kind: 'unreadable' }
  }
}

// One line per id, the newest, in the order each id was last written. The
// seed line stays, so a compacted log still reads as seeded.
export function compactLog(lines: LogLine[]): LogLine[] {
  const newest = new Map<string, LogLine>()
  for (const line of lines) {
    newest.delete(line.id)
    newest.set(line.id, line)
  }
  return [...newest.values()]
}

// The rename's argv: the paths after `--`, never in the code.
export const renameArgv = (from: string, to: string, script = RENAME) => ['node', '-e', script, '--', from, to]

// Renames `from` to `to` through the host (over it, unless `script` is MOVE).
// null when it landed, else why not.
async function rename($: $, from: string, to: string, script = RENAME): Promise<string | null> {
  return runHost($, renameArgv(from, to, script))
}

async function runHost($: $, argv: string[], onSuccess?: (stdout: string) => void): Promise<string | null> {
  try {
    const ran = await $.process.run(argv, { timeoutMs: 20_000 })
    if (ran.exitCode === 0) onSuccess?.(ran.stdout)
    return ran.exitCode === 0 ? null : `exit ${ran.exitCode} ${clean(ran.stderr, 160)}`.trim()
  } catch (error) {
    return clean((error as Error)?.name, 60) || 'run failed'
  }
}

// Claims a generation for this module: a hot-reloaded replacement claims the
// next one, and from then on the old module writes nothing. A command claims
// once; a tick (`reclaim`) claims again whenever it is not current, because an
// old module's tick paused across the reload can resume and take a newer
// number. The engine cancels the old module's timer on reload, so it can take
// it at most once, and the live module's next tick takes it back.
async function claimGeneration($: $, reclaim = false): Promise<void> {
  if (generation !== undefined && (!reclaim || (await $.state.get(GENERATION)).value === generation)) return
  for (let i = 0; i < CAS_TRIES; i++) {
    const held = await $.state.get(GENERATION)
    const next = (held.value ?? 0) + 1
    if ((await $.state.set(GENERATION, next, { ifVersion: held.version })).isSet) {
      generation = next
      return
    }
  }
  throw new Error('generation contended')
}

class Superseded extends Error {}

async function assertCurrent($: $): Promise<void> {
  if ((await $.state.get(GENERATION)).value !== generation) throw new Superseded('superseded by a reloaded module')
}

// Where a Room file lives. Invariant: inbox/ = unclaimed (room_drain may take
// it); claimed/ = this mod holds it; processed/ = delivered or dead (the Room
// reads that folder as read and archives it). Never claim into processed/.
const roomDir = (w: Where, kind: 'inbox' | 'claimed' | 'processed') => `${config.roomRoot}/${kind}/${w.seat}`
const inboxDir = (w: Where) => roomDir(w, 'inbox')
const inboxFile = (w: Where, file: string) => `${roomDir(w, 'inbox')}/${file}`
const claimedFile = (w: Where, file: string) => `${roomDir(w, 'claimed')}/${file}`
const processedFile = (w: Where, file: string) => `${roomDir(w, 'processed')}/${file}`
// False when the inbox folder itself is missing or unreachable (an unmounted
// drive): then no file can be called gone.
// null when the check itself fails: an unknown state, never read as "absent".
const exists = ($: $, path: string): Promise<boolean | null> => $.fs.exists(path).catch(() => null)
const inboxIsUp = async ($: $, w: Where) => config.roomRoot !== '' && (await exists($, inboxDir(w))) === true

// A Room id of this seat whose file is in neither inbox/ nor claimed/ can
// never be delivered again, so rotation may drop it; an unresolved one is kept
// (it still holds). The caller checks first that the inbox folder itself is
// there: a missing or unmounted folder would make every file look gone.
async function isSpent($: $, w: Where, line: LogLine): Promise<boolean> {
  const prefix = `room:${w.seat}:`
  if (!line.id.startsWith(prefix) || UNRESOLVED.includes(line.status)) return false
  const file = line.id.slice(prefix.length)
  return (await exists($, inboxFile(w, file))) === false && (await exists($, claimedFile(w, file))) === false
}

// Appends lines to the log. The new text goes to <log>.tmp and is renamed
// over the log, so a crash leaves the old log or the new one, never a
// truncated one; a leftover .tmp is never read and is overwritten next time.
// Once the text would pass ROTATE_CHARS it is rewritten compacted: one line
// per id, the newest, minus Room ids whose inbox file is gone. The seed, every
// job id and every Room id still in the inbox stay.
// ponytail: job ids and present Room ids still accumulate; past the read cap
// the log reads as ledger-unreadable and holds (README, Rotation).
// Throws Superseded when a reloaded module took over, else Error on a failed
// write.
function appendLog($: $, w: Where, added: LogLine | LogLine[] | (() => Promise<LogLine[]>)): Promise<void> {
  const run = logWrites.then(async () => {
    const log = await readLog($, w)
    if (log.kind === 'corrupt' || log.kind === 'unreadable') throw new Error(`log ${log.kind}`)
    // A function builds its lines now, after the read: what it reads from the
    // ledger is what the log gets, with nothing written in between.
    const lines = typeof added === 'function' ? await added() : Array.isArray(added) ? added : [added]
    const text = log.kind === 'ok' ? log.text : ''
    const lead = text && !text.endsWith('\n') ? '\n' : ''
    let next = `${text}${lead}${lines.map(one => `${logLine(one)}\n`).join('')}`
    if (next.length > ROTATE_CHARS && log.kind === 'ok') {
      const canDrop = await inboxIsUp($, w)
      const kept: LogLine[] = []
      for (const one of compactLog(log.lines)) if (!(canDrop && (await isSpent($, w, one)))) kept.push(one)
      next = [...kept, ...lines].map(one => `${logLine(one)}\n`).join('')
    }
    await assertCurrent($)
    await $.fs.write(`${logPath(w)}.tmp`, next)
    const failed = await rename($, `${logPath(w)}.tmp`, logPath(w))
    if (failed) throw new Error(`log rename ${failed}`)
  })
  logWrites = run.catch(() => {})
  return run
}

// One-time import of the 0.1.0 ledger, which lived in the plugin's store and
// whose log could lose lines (that version ignored a failed append): every id
// the store holds and the log does not is appended, status copied, with a
// seed line when the log has none (0.1.0 kept the store only once seeded).
// An id the log already has is imported too when the store's status is final
// and the log's newest is not: an older retryable line must not re-send what
// 0.1.0 recorded delivered. The store key is deleted only after the lines are
// on disk. A store that cannot be READ throws StoreUnreadable: it may hold ids
// the log lacks, so delivery holds and the next tick tries again. A key that
// cannot be DELETED is said once and delivery goes on: its ids are on disk by
// then, and a later re-import adds nothing the log already holds as final.
// The import ends with one IMPORT_MARKER line in the log (with the imported
// lines, or alone on a seeded log when the store holds nothing for the seat).
// A log carrying it never reads the store again, so an unreadable store can
// hold a seat at most until its first clean import.
async function importStore($: $, w: Where, log: Log): Promise<Log> {
  if (log.kind === 'ok' && log.lines.some(line => line.id === IMPORT_MARKER)) return log
  const key = `ledger:${w.seat}`
  let stored: unknown
  try {
    stored = await $.store.get(key)
  } catch (error) {
    throw new StoreUnreadable(clean((error as Error)?.message, 120))
  }
  const marker = async (): Promise<LogLine> => ({ id: IMPORT_MARKER, source: IMPORT_MARKER, at: await iso($), status: 'done' })
  if (stored === undefined) {
    // Nothing to import. An unseeded log holds as ledger-missing anyway; a
    // marker that cannot be written is tried again on the next load.
    if (log.kind !== 'ok' || !log.lines.some(line => line.id === 'seed')) return log
    try {
      await appendLog($, w, await marker())
    } catch {
      return log
    }
    return readLog($, w)
  }
  const newest = new Map<string, LogLine>()
  for (const line of log.kind === 'ok' ? log.lines : []) newest.set(line.id, line)
  const at = await iso($)
  const add: LogLine[] = newest.has('seed') ? [] : [{ ...SEED_LINE, at }]
  if (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [id, entry] of Object.entries(stored as Record<string, Partial<FleetDeliveryEntry>>)) {
      if (id === 'seed' || typeof entry?.status !== 'string') continue
      const inLog = newest.get(id)
      const storeWins = isFinal({ status: entry.status, at: '' }) && !(inLog && isFinal({ status: inLog.status, at: '' }))
      if (inLog && !storeWins) continue
      add.push({
        id,
        source: id.startsWith('job:') ? 'job-results' : 'room',
        at: typeof entry.at === 'string' ? entry.at : at,
        status: entry.status,
        ...counts(entry),
        detail: IMPORT_NOTE,
      })
    }
  }
  add.push(await marker())
  await appendLog($, w, add)
  try {
    await $.store.delete(key)
  } catch (error) {
    warnStore($, clean((error as Error)?.message, 120))
  }
  return readLog($, w)
}

class StoreUnreadable extends Error {}

let hasWarnedStore = false
function warnStore($: $, reason: string): void {
  if (hasWarnedStore) return
  hasWarnedStore = true
  $.ui.log(`fleet-delivery: the 0.1.0 store key could not be deleted (${reason}); its ids are already in the log, so delivery goes on.`)
}

// The seat's ledger for this session: $.state if loaded, else the seat's log
// read in full, newest line per id (the operator's seed line marks a
// deliberate start). null: never seeded, and delivery holds while the inbox
// has items.
async function loadLedger($: $, w: Where, given: Log): Promise<Entries | null> {
  const held = await $.state.get(LEDGER)
  const loaded = held.value?.[w.seat]
  if (loaded) return loaded
  const log = await importStore($, w, given)
  if (log.kind !== 'ok' || !log.lines.some(line => line.id === 'seed')) return null
  const entries: Entries = {}
  for (const line of log.lines) {
    if (line.status.startsWith('probe:') || line.id === IMPORT_MARKER) continue
    entries[line.id] = {
      status: line.status,
      at: line.at,
      ...counts(line),
      ...(line.pid ? { pid: String(line.pid) } : {}),
      ...(typeof line.gen === 'number' ? { gen: line.gen } : {}),
    }
  }
  await $.state.set(LEDGER, { ...(held.value ?? {}), [w.seat]: entries }, { ifVersion: held.version })
  return (await $.state.get(LEDGER)).value?.[w.seat] ?? entries
}

// First thing of every tick, command and session start: the module's start
// time and its CLI pid. Retry failed pid discovery each tick; no pid means no admission.
async function begin($: $): Promise<void> {
  startedAt ??= await $.clock.now()
  if (ownerPid) return
  // One probe shared by every caller, so no tick or claim runs before the pid is known.
  probing ??= (async () => {
    try {
      const ran = await $.process.run(['node', '-e', OWNER_PID], { timeoutMs: 20_000 })
      const pid = ran.stdout.trim()
      if (ran.exitCode !== 0 || !/^\d+$/.test(pid) || !Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return
      // The pid must read alive, or it was a transient shell: then no stamp and no release by pid.
      const check = await $.process.run(['node', '-e', PID_DEAD, '--', pid], { timeoutMs: 20_000 })
      if (check.exitCode === 1) ownerPid = pid
    } catch {}
  })().finally(() => { probing = undefined })
  await probing
}

// A `submitting` claim whose process is gone settles nothing (issue #88): it
// must not hold the seat. Released only when the claim is stamped with a pid
// that is not this CLI's and that process is dead (the probe exits 0), and its
// time is before this module's start. A live pid (a second window, a relaunch
// while the old process runs), an unstamped legacy line, an unknown answer
// and a failed check all keep the hold; /delivery-reconcile releases a legacy
// one. A Room file still in claimed/ or inbox/ is delivered again by the
// normal claim path; one in neither is spent. Runs every tick while such a
// claim remains, so a transient failure is retried.
// ponytail: one probe process per such claim per tick while its process lives.
// Answers whether it changed the ledger, and the claims it left to keep deciding
// (a pid that did not read alive): settleStale must not take those. Needs a
// verified own pid (begin).
const releasable = (entry: FleetDeliveryEntry) =>
  !!ownerPid && entry.status === 'submitting' && !!entry.pid && /^\d+$/.test(entry.pid) && entry.pid !== ownerPid && Date.parse(entry.at) < (startedAt ?? 0)
const sourceOf = (id: string): Item['source'] => id.startsWith('job:') ? 'job-results' : 'room'
async function releasePrior($: $, w: Where, entries: Entries): Promise<{ changed: boolean; alive: Set<string> }> {
  let changed = false
  // Each foreign pid is probed once a tick: exit 0 dead, 1 alive, else unknown.
  const probed = new Map<string, number>()
  for (const [id, entry] of Object.entries(entries)) {
    if (!releasable(entry) || !entry.pid) continue
    if (!probed.has(entry.pid)) {
      try {
        probed.set(entry.pid, (await $.process.run(['node', '-e', PID_DEAD, '--', entry.pid], { timeoutMs: 20_000 })).exitCode)
      } catch {
        probed.set(entry.pid, 2)
      }
    }
    if (probed.get(entry.pid) !== 0) continue
    const file = id.startsWith('room:') ? roomFile(w, id) : null
    let status = 'deferred:prior-session'
    if (id.startsWith('room:')) {
      if (!file) continue
      const there = [await exists($, claimedFile(w, file)), await exists($, inboxFile(w, file))]
      if (there.includes(null)) continue
      if (!there.includes(true)) {
        if (!(await inboxIsUp($, w))) continue
        status = 'dropped:consumed'
      }
    }
    const landed = await record($, w, { id, source: sourceOf(id) }, status, now => now?.status === 'submitting' && now.at === entry.at, {
      detail: `claim from process ${entry.pid}, which ended`,
    })
    changed ||= landed !== null
  }
  return { changed, alive: new Set([...probed].filter(([, code]) => code === 1).map(([pid]) => pid)) }
}

// The hold's status text: names the item, so the reconcile is one paste.
const heldOn = (id: string) => ` · holding until settled or /delivery-reconcile ${id} [delivered] (check the transcript first)`

// A live pid does not prove a submit is in flight. Only the tick awaiting a submit can settle its
// `submitting` claim, and at a tick's start this module awaits none (one tick
// at a time; a tick ends only once its submit is answered or timed out). So
// every `submitting` left then is one no live code will settle, and it becomes
// `submitting:unresolved`: held, never resent, said once in the transcript.
// (a) It carries this CLI's pid: an older module of this process wrote it (a
// hot reload, or a /clear, which keeps the pid) and its late answer can never
// be recorded. (b) It is older than the submit timeout, whoever wrote it (an
// unreadable time counts as older). A claim releasePrior is still deciding (a
// foreign pid that did not read alive) is left to it, so 0.2.2's release stands.
// Answers whether it changed the ledger.
async function settleStale($: $, w: Where, entries: Entries, alive: Set<string>): Promise<boolean> {
  const now = await $.clock.now()
  let changed = false
  for (const [id, entry] of Object.entries(entries)) {
    if (entry.status !== 'submitting') continue
    const mine = !!ownerPid && entry.pid === ownerPid
    if (!mine && now - Date.parse(entry.at) <= config.submitTimeoutMs) continue
    if (!mine && releasable(entry) && !alive.has(entry.pid ?? '')) continue
    const detail = mine
      ? entry.gen === generation
        ? 'claim from this module with no submit in flight'
        : `claim from module generation ${entry.gen ?? '(unstamped)'}, now ${generation} (a reload or /clear on process ${entry.pid}); its answer cannot be recorded`
      : `submitting past the ${config.submitTimeoutMs / 60_000} min submit timeout with no submit in flight here${entry.pid ? ` (process ${entry.pid})` : ''}`
    if (!(await record($, w, { id, source: sourceOf(id) }, 'submitting:unresolved', cur => cur?.status === 'submitting' && cur.at === entry.at, { detail }))) continue
    changed = true
    $.ui.log(`fleet-delivery: ${id} is unresolved: ${detail}. Delivery holds. Check the transcript, then /delivery-reconcile ${id} [delivered].`)
  }
  return changed
}

// Compare-and-set one entry: `decide` sees the entry as it stands and answers
// the next one, undefined to remove it, or null to leave it (another writer
// got there first). The write lands in $.state only at the version read.
// Answers the entry it replaced, or null when nothing changed.
async function transition(
  $: $,
  w: Where,
  id: string,
  decide: (entry: FleetDeliveryEntry | undefined) => FleetDeliveryEntry | undefined | null,
): Promise<{ prior: FleetDeliveryEntry | undefined } | null> {
  for (let i = 0; i < CAS_TRIES; i++) {
    const held = await $.state.get(LEDGER)
    const all = held.value ?? {}
    const entries = all[w.seat]
    if (!entries) throw new Error('ledger not loaded')
    const prior = entries[id]
    const next = decide(prior)
    if (next === null) return null
    const merged = { ...entries }
    if (next === undefined) delete merged[id]
    else merged[id] = next
    if ((await $.state.set(LEDGER, { ...all, [w.seat]: merged }, { ifVersion: held.version })).isSet) return { prior }
  }
  throw new Error('ledger contended')
}

class LogWriteFailed extends Error {}

// Moves an item to `status` and logs it; `from` limits which entries move.
// Nothing at all when a reloaded module has taken over. A failed log append
// throws: the log is what the next session reads. With `undo` (the claim,
// where non-delivery is still proven) the entry is first put back as it was,
// on a failed write and on Superseded alike; LogWriteFailed says the next
// tick may retry.
async function record(
  $: $,
  w: Where,
  item: Pick<Item, 'id' | 'source'>,
  status: string,
  from: (entry: FleetDeliveryEntry | undefined) => boolean,
  extra: { attempts?: number; pid?: string; gen?: number; detail?: string | ((prior: FleetDeliveryEntry | undefined) => string | undefined); persist?: boolean } = {},
  undo = false,
): Promise<{ prior: FleetDeliveryEntry | undefined } | null> {
  await assertCurrent($)
  const at = await iso($)
  const stamp = { ...(extra.pid ? { pid: extra.pid } : {}), ...(extra.gen !== undefined ? { gen: extra.gen } : {}) }
  const landed = await transition($, w, item.id, entry =>
    from(entry)
      ? {
          status,
          at,
          ...counts({ attempts: extra.attempts ?? entry?.attempts }),
          ...stamp,
        }
      : null,
  )
  if (!landed || extra.persist === false) return landed
  try {
    // The line carries the counts the entry kept, so a new session reads them.
    const detail = typeof extra.detail === 'function' ? extra.detail(landed.prior) : extra.detail
    await appendLog($, w, {
      id: item.id,
      source: item.source,
      at,
      status,
      ...counts({ attempts: extra.attempts ?? landed.prior?.attempts }),
      ...stamp,
      ...(detail ? { detail } : {}),
    })
  } catch (error) {
    if (!undo) throw error
    // Superseded too: the claim reached state but not the log, and nothing
    // was submitted, so it is put back either way (state only).
    await transition($, w, item.id, entry => (entry?.status === status && entry.at === at ? landed.prior : null)).catch(() => null)
    if (error instanceof Superseded) throw error
    throw new LogWriteFailed(clean((error as Error)?.message, 120))
  }
  return landed
}

// A Room item's file name from its id, or null if it is not this seat's or
// not a plain file name.
function roomFile(w: Where, id: string): string | null {
  const prefix = `room:${w.seat}:`
  const file = id.startsWith(prefix) ? id.slice(prefix.length) : ''
  return /^[^\\/]+\.json$/.test(file) ? file : null
}

type Place = (w: Where, file: string) => string

// One note line for a Room file's id: its newest status kept, the detail
// saying what happened. Never throws; the ledger, not the note, decides.
const noteLine = (item: Pick<Item, 'id' | 'source'>, entry: { status: string; attempts?: number }, detail: string, at: string): LogLine => ({
  id: item.id,
  source: item.source,
  at,
  status: entry.status,
  ...counts(entry),
  detail,
})
type Note = { item: Pick<Item, 'id' | 'source'>; entry: { status: string; attempts?: number }; detail: string }
// Notes go through the serialized log write, and each takes the status and
// count its id holds in the ledger when the line is written (the caller's entry
// only if the id has none): a note never re-asserts a status read earlier.
const writeNotes = ($: $, w: Where, notes: Note[]): Promise<void> =>
  notes.length
    ? appendLog($, w, async () => {
        const at = await iso($)
        const held = (await $.state.get(LEDGER)).value?.[w.seat] ?? {}
        return notes.map(one => noteLine(one.item, held[one.item.id] ?? one.entry, one.detail, at))
      }).catch(() => {})
    : Promise.resolve()
const note = ($: $, w: Where, item: Note['item'], entry: Note['entry'], detail: string) => writeNotes($, w, [{ item, entry, detail }])

// A blocked move is noted once per module, not once per tick.
const notedBlocks = new Set<string>()
// Moves a Room item's file between inbox/, claimed/ and processed/ through
// MOVE, which never overwrites: a taken destination leaves the source and is
// noted once per module (it is retried whenever the move is asked for again).
// 'moved'; 'admitted' (a pointer owns the inbox file); 'blocked' (destination
// taken, nothing spawned); 'absent' (the source
// is gone, with evidence); 'failed' (refused, or an unknown state). After a failed
// move the filesystem decides, never the error text: a taken destination is
// the block; a source that is not there is no move and no note unless
// `noteAbsent`; anything else is one note line that keeps the caller's entry
// and the file stays where it was.
async function moveRoom(
  $: $,
  w: Where,
  item: Pick<Item, 'id' | 'source'>,
  [from, to]: [Place, Place],
  entry: Note['entry'] | undefined,
  noteAbsent = false,
  sink?: Note[] | 'quiet',
  lifecycle = false,
): Promise<'moved' | 'admitted' | 'blocked' | 'failed' | 'absent'> {
  const file = item.source === 'room' && config.roomRoot ? roomFile(w, item.id) : null
  if (!file) return 'absent'
  const claiming = from === inboxFile && to === claimedFile
  if (claiming) {
    // Decision and marking are one synchronous gated step: a turn that started or an
    // admission bound in the microtask gap after the tick's own check is seen here.
    const admitted = await serialized(() => {
      if (!lifecycle && guarded(file)) return true
      tickOwned.add(file)
      claimsInFlight.add(file)
      return false
    })
    if (admitted) return 'admitted'
  }
  let landed = false
  try {
    const leftClaimed = () => { if (from === claimedFile) tickOwned.delete(file) }
    // A note goes to the sink when there is one (the sweep writes its notes in one append).
    const say = async (detail: string) => {
      if (sink === 'quiet' || !entry) return
      if (sink) sink.push({ item, entry, detail })
      else await note($, w, item, entry, detail)
    }
    const blocked = async () => {
      const key = `${from(w, file)}>${to(w, file)}`
      if (sink !== 'quiet' && !notedBlocks.has(key)) {
        notedBlocks.add(key)
        await say(`note: ${to(w, file)} exists; ${from(w, file)} left in place`)
      }
      return 'blocked' as const
    }
    // The destination is checked first, so a block spawns nothing; MOVE guards the race.
    if ((await exists($, to(w, file))) === true) return blocked()
    const failed = await rename($, from(w, file), to(w, file), MOVE)
    if (!failed) { landed = true; leftClaimed(); return 'moved' }
    const gone = (await exists($, from(w, file))) === false
    const there = (await exists($, to(w, file))) === true
    // The move landed though the mover said otherwise (a timeout after the rename).
    if (gone && there) { landed = true; leftClaimed(); return 'moved' }
    if (there) return blocked()
    // Absent needs evidence: the mover said ENOENT, or the file went to processed/.
    const absent = gone && (failed.includes('ENOENT') || (await exists($, processedFile(w, file))) === true)
    if (absent) leftClaimed()
    if (!absent || noteAbsent) await say(absent ? `note: ${from(w, file)} is absent` : `note: move failed: ${failed}`)
    return absent ? 'absent' : 'failed'
  } finally {
    if (claiming) {
      claimsInFlight.delete(file)
      if (landed) tickOwned.add(file)
      else tickOwned.delete(file)
    }
  }
}

// Final non-delivery (dropped, error:*): back to inbox/, where the seat's own
// room_drain surfaces it as data. A retryable reject and a reconcile not
// delivered do not come here: the file waits in claimed/, which roomItems queues.
const restoreRoomFile = ($: $, w: Where, item: Pick<Item, 'id' | 'source'>, entry: { status: string; attempts?: number }) =>
  moveRoom($, w, item, [claimedFile, inboxFile], entry, true)

// Delivered (submitted, reconciled delivered): claimed/ to processed/, nothing
// else touched. A file absent from claimed/ is one note line.
const finishRoomFile = ($: $, w: Where, item: Pick<Item, 'id' | 'source'>, entry: { status: string; attempts?: number }) =>
  moveRoom($, w, item, [claimedFile, processedFile], entry, true)

const fileNames = async ($: $, dir: string): Promise<string[]> => {
  try {
    return (await $.fs.list(dir)).filter(one => one.kind === 'file').map(one => one.name)
  } catch {
    return []
  }
}
const jsonNames = async ($: $, dir: string) => (await fileNames($, dir)).filter(name => name.endsWith('.json'))

// FNV-1a keeps ids that sanitize to the same filename distinct.
export function safeName(s: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < s.length; i++) hash = Math.imul(hash ^ s.charCodeAt(i), 0x01000193)
  return `${s.replace(/[^A-Za-z0-9._-]/g, '_')}-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

const admitDir = (w: Where) => `${config.roomRoot}/state/admit/${w.seat}`
let admissionSequence = 0
const attemptNonce = (pid: string, ts: string) =>
  `${pid}-${Date.parse(ts)}-${generation}-${++admissionSequence}-${Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0')}`
const admitFile = (w: Where, item: Pick<Item, 'id' | 'source'>, attempt: string) =>
  `${admitDir(w)}/${item.source === 'room' ? roomFile(w, item.id) : `job-${safeName(item.id.slice(4))}`}.${attempt}.json`

// Each attempt owns a non-reused path, so cleanup cannot unlink a successor.
// Unknown submit outcomes retain their ticket until their own submit settles.
async function removeAdmission($: $, w: Where, file: string, item?: Note['item'], entry?: Note['entry'], noteMissing = false): Promise<void> {
  let missing = false
  const failed = await runHost($, ['node', '-e', UNLINK, '--', file], stdout => { missing = stdout === 'ENOENT' })
  if (!failed && !(missing && noteMissing)) return
  const detail = failed ? `note: admission removal failed: ${failed}` : 'note: admission ticket already gone'
  if (entry && item) await note($, w, item, entry, detail)
  else $.ui.log(`fleet-delivery: ${file}: ${detail}`)
}

// Only a dead owner (ESRCH) releases a ticket here. A ticket without a valid
// pid (a legacy null-pid admission or a damaged owner field) has an unknown
// owner whose submit may still be pending across a hot reload, so it is
// retained for operator recovery. Ledger verdicts cannot prove a submit
// settled, including an older generation's submit in this same process.
const notedUnowned = new Set<string>()
async function sweepAdmissions($: $, w: Where, entries: Entries | null): Promise<void> {
  if (!config.roomRoot) return
  const probed = new Map<number, number>()
  for (const file of await fileNames($, admitDir(w))) {
    const full = `${admitDir(w)}/${file}`
    if (!file.endsWith('.json') && file.includes('.tmp-')) {
      // WRITE's child can die before its rename or catch cleanup runs. These
      // are never tickets; leave recent writers alone until the temporary-file cleanup fuse.
      const stat = await $.fs.stat(full).catch(() => null)
      if (stat && (await $.clock.now()) - stat.mtimeMs > ADMISSION_TEMP_FUSE_MS) {
        const failed = await runHost($, ['node', '-e', UNLINK, '--', full])
        if (failed) $.ui.log(`fleet-delivery: admission temp removal failed: ${failed}`)
      }
      continue
    }
    if (file.startsWith('.probe-')) {
      const failed = await runHost($, ['node', '-e', UNLINK, '--', full])
      if (failed) $.ui.log(`fleet-delivery: admission probe removal failed: ${failed}`)
      continue
    }
    if (!file.endsWith('.json')) continue
    let ticket
    try { ticket = JSON.parse(await $.fs.read(full)) } catch { continue }
    if (!Number.isSafeInteger(ticket?.pid) || ticket.pid <= 0) {
      // Said once per module load. The directory, not the body's seat field, says whose obligation a ticket is.
      if (!notedUnowned.has(full)) {
        notedUnowned.add(full)
        const bodySeat = typeof ticket?.seat === 'string' && ticket.seat !== w.seat ? ` (body names seat ${ticket.seat})` : ''
        $.ui.log(`fleet-delivery: ${full}: note: admission ticket has no valid owner pid; retained until an operator deletes it by hand${bodySeat}`)
      }
      continue
    }
    if (ticket.pid === Number(ownerPid)) continue
    if (!probed.has(ticket.pid)) {
      try {
        const check = await $.process.run(['node', '-e', PID_DEAD, '--', String(ticket.pid)], { timeoutMs: 20_000 })
        probed.set(ticket.pid, check.exitCode)
      } catch { probed.set(ticket.pid, 2) }
    }
    if (probed.get(ticket.pid) !== 0) continue
    if (typeof ticket.item !== 'string') {
      // A dead owner releases the ticket even when its item field is damaged; no ledger entry can carry the note.
      $.ui.log(`fleet-delivery: ${full}: note: dead-owner admission without an item; removing`)
      await removeAdmission($, w, full, undefined, undefined, true)
      continue
    }
    const entry = entries && Object.hasOwn(entries, ticket.item) ? entries[ticket.item] : undefined
    await removeAdmission($, w, full, { id: ticket.item, source: sourceOf(ticket.item) }, entry)
  }
}

async function probeAdmission($: $, w: Where): Promise<void> {
  if (admissionFailure === undefined || !config.roomRoot || !ownerPid) return
  const file = `${admitDir(w)}/.probe-${ownerPid}`
  const writeFailure = await runHost($, ['node', '-e', WRITE, '--', file, ''])
  if (writeFailure) { admissionFailure = writeFailure; return }
  admissionFailure = undefined
  const failed = await runHost($, ['node', '-e', UNLINK, '--', file])
  if (failed) $.ui.log(`fleet-delivery: admission probe removal failed: ${failed}`)
}

type Seen = { claimed: string[]; inbox: string[] }
const listHomes = async ($: $, w: Where): Promise<Seen> =>
  config.roomRoot
    ? { claimed: await jsonNames($, roomDir(w, 'claimed')), inbox: await jsonNames($, roomDir(w, 'inbox')) }
    : { claimed: [], inbox: [] }

// The stray sweep, first thing each tick: a file left in claimed/ or inbox/
// under a settled ledger entry (anything final but not unresolved) is moved to
// where that status says it belongs, never over an existing file, with one note
// line per moved file. This settles a late start whose file sits in inbox/, a
// final status recorded while the file was held, a hot-reload race and a
// same-name duplicate.
// claimed/: submitted and reconciled:delivered go to processed/; every other
// final status goes back to inbox/ (dropped for the seat's room_drain; error:*
// and skipped:* for the supervisor or the seat to quarantine). inbox/: only a
// delivered id is a stray there; the rest wait. A move that is blocked or
// fails is retried every tick; only its note line is written once per module.
// A same-name file (the Room names files <ts>__<uuid>.json, so it is the same
// message copied by hand) is left in place. Its note lines go out in one append
// a tick. Returns the names it listed and did not move, for roomItems (one
// listing a tick).
async function sweepStrays($: $, w: Where, entries: Entries): Promise<{ left: Seen; moves: number }> {
  const seen = await listHomes($, w)
  const left: Seen = { claimed: [], inbox: [] }
  const notes: Note[] = []
  // Its own budget of three moves attempted a tick, success or not; the claim's is separate.
  let moves = 0
  const homes = [['claimed', claimedFile], ['inbox', inboxFile]] as const
  for (const [home, here] of homes) {
    for (const file of seen[home]) {
      const id = `room:${w.seat}:${file}`
      const entry = entries[id]
      const delivered = entry?.status === 'submitted' || entry?.status === 'reconciled:delivered'
      const to: Place | null = delivered ? processedFile : home === 'claimed' ? inboxFile : null
      if (!entry || !isFinal(entry) || isUnresolved(entry) || !to) {
        left[home].push(file)
        continue
      }
      if (moves >= MAX_SWEEP_MOVES) {
        left[home].push(file)
        continue
      }
      const item = { id, source: 'room' }
      // A taken destination, a failure or a vanished source is noted by moveRoom (once per module) and retried next tick.
      const result = await moveRoom($, w, item, [here, to], entry, false, notes)
      if (result === 'moved') notes.push({ item, entry, detail: `note: swept ${here(w, file)} to ${to(w, file)}` })
      else left[home].push(file)
      if (result !== 'blocked') moves++
    }
  }
  await writeNotes($, w, notes)
  return { left, moves }
}

async function roomItems($: $, w: Where, seen?: Seen): Promise<Item[]> {
  if (!config.roomRoot) return []
  const { claimed, inbox } = seen ?? (await listHomes($, w))
  // inbox/ is unclaimed; claimed/ is what this mod holds (a failed restore or
  // a crash after the claim): both queue, the tick drops the ones the ledger
  // has settled. Filenames lead with the ISO time, so name order is arrival
  // order. One Item per name: a held copy wins over an inbox copy of it.
  const found = new Map<string, boolean>()
  for (const file of inbox) found.set(file, false)
  for (const file of claimed) found.set(file, true)
  const listed = [...found].map(([file, held]) => ({ file, held }))
  return listed.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)).map(({ file, held }) => ({
    id: `room:${w.seat}:${file}`,
    source: 'room',
    claimed: held,
    load: async () => {
      const full = (held ? claimedFile : inboxFile)(w, file)
      try {
        if ((await $.fs.stat(full)).size > FS_READ_CAP) return { error: 'error:over-read-cap' }
        const env = JSON.parse(await $.fs.read(full))
        let body = (Array.isArray(env?.parts) ? env.parts : [])
          .map((part: { text?: unknown }) => (typeof part?.text === 'string' ? part.text : ''))
          .filter(Boolean)
          .join('\n')
        if (!body) return { error: 'error:empty-body' }
        if (CONTROL.test(body.trim())) return { error: 'skipped:control' }
        if (body.length > BODY_CAP) body = `${body.slice(0, BODY_CAP)}\n[cut: ${body.length - BODY_CAP} more characters in ${file}]`
        const from = typeof env?.from === 'string' && SEAT_NAME.test(env.from) ? env.from : '?'
        const ts = clean(env?.ts, 40).replace(/[[\]]/g, '') || '?'
        // Sender and wording together: neither alone makes a lifecycle leg.
        const lifecycle = from === `${w.seat}-supervisor` && LIFECYCLE_LEG.test(body.trim())
        return {
          text: `[room from ${from}, ${ts}]\n${body}\n${TRAILER}`,
          ...(lifecycle ? { lifecycle: true as const } : {}),
          ...(env?.priority === 'urgent' ? { urgent: true as const } : {}),
        }
      } catch {
        return (await exists($, full)) === false ? null : { error: 'error:unreadable' }
      }
    },
  }))
}

// Mirrors job-results.mjs messageFor (:170-178): only the id and the
// evidence path travel, never a free-text summary; the seat acks when it has
// handled the job, never this mod.
export function jobText(row: { id: string; evidence_path?: unknown; requires_human?: unknown }): string {
  return [
    `[job result ${row.id}]`,
    `Evidence: ${clean(row.evidence_path, 200) || '(none)'}`,
    "Do the job's non-send work per the evidence file, under its existing contract only.",
    `Any send, publish, spend or order requires the operator's direct go${row.requires_human ? ' (this record is flagged requires-human)' : ''}; nothing fires on this message.`,
    `When handled run: node daemons/job-results.mjs ack ${row.id}   (already acked = ignore this message).`,
    'This notification is not an approval and changes no policy.',
  ].join('\n')
}

// Job records carry no recipient: job-results passes one only to notify
// (`--to`, default its pilot seat, job-results.mjs:156, :308) and never
// stores it (:162, :165). So jobs go to the one seat named jobSeat, and not
// while job-delivery.json hands that seat to the native notifier (:97-99).
async function jobItems($: $, w: Where): Promise<Item[]> {
  if (!config.jobSeat || w.seat !== config.jobSeat) return []
  try {
    if (JSON.parse(await $.fs.read(jobOwnerPath(w)))?.[w.seat] === 'native') return []
  } catch {}
  if (!(await hasJobScript($, w))) return []
  let rows: unknown
  try {
    const ran = await $.process.run(['node', scriptPath(w), 'pending'], {
      cwd: w.root,
      env: { JOB_RESULTS_ROOT: w.root },
      timeoutMs: 20_000,
    })
    if (ran.exitCode !== 0) return []
    rows = JSON.parse(ran.stdout)
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  // An acked row is pending only for its business action, already in a
  // seat's hands: not a delivery.
  return rows
    .filter(row => typeof row?.id === 'string' && row.job && !row.acked)
    .map(row => ({
      id: `job:${row.id}`,
      source: 'job-results',
      load: async () => (JOB_ID.test(row.id) ? { text: jobText(row) } : { error: 'error:bad-id' }),
    }))
}

// A proven non-delivery: deferred until the cap, then final.
const retry = (kind: string, attempts: number) => (attempts >= RETRY_CAP ? `error:${kind}` : `deferred:${kind}`)

// Resolves where this session delivers, or null with the reason shown.
async function resolve($: $): Promise<{ w: Where } | { off: true; release?: Where } | { hold: string }> {
  const root = await installRoot($)
  const seat = await seatName($)
  if (!root || !seat) return { off: true }
  if ((await owner($, root, seat)) !== 'mod') {
    // Not ours: the memory root (for the ledger) is only resolved if claimed/ still holds files.
    if (!config.roomRoot || (await jsonNames($, roomDir({ root, memory: '', seat }, 'claimed'))).length === 0) return { off: true }
    const memory = await memoryRoot($, root)
    return { off: true, ...(memory ? { release: { root, memory, seat } } : {}) }
  }
  const memory = await memoryRoot($, root)
  return memory ? { w: { root, memory, seat } } : { hold: 'memory root unresolved' }
}

// One tick delivers at most ONE item: the next after its turn starts, on the
// following tick or turn end. Overlapping ticks of one module are skipped;
// an old module's tick racing a reloaded one meets the compare-and-set.
async function tick($: $): Promise<void> {
  if (isTicking || !config.installRoot) return
  isTicking = true
  try {
    await begin($)
    const where = await resolve($)
    if ('off' in where) {
      $.ui.status(undefined)
      // A seat the mod does not own: whatever it still holds in claimed/ goes back
      // to inbox/ (three a tick, no notes: a note line would read as a ledger entry).
      if (where.release && config.roomRoot) {
        const rw = where.release
        let held: Entries | null = null
        try {
          held = await loadLedger($, rw, await readLog($, rw))
        } catch {}
        let budget = MAX_SWEEP_MOVES
        for (const file of held ? await jsonNames($, roomDir(rw, 'claimed')) : []) {
          if (budget <= 0) break
          const status = held?.[`room:${rw.seat}:${file}`]?.status
          if (status && UNRESOLVED.includes(status)) continue
          budget--
          const delivered = status === 'submitted' || status === 'reconciled:delivered'
          await moveRoom($, rw, { id: `room:${rw.seat}:${file}`, source: 'room' }, [claimedFile, delivered ? processedFile : inboxFile], undefined, false, 'quiet')
        }
      }
      await retireMarker($, where.release?.seat)
      return
    }
    if ('hold' in where) {
      $.ui.status(`delivery: mod · ${where.hold}, holding`)
      await retireMarker($)
      return
    }
    const { w } = where
    await claimGeneration($, true)
    // The holds, read once a tick: the marker follows them before any ledger
    // early return, and the queue-level branches below reuse the same reads,
    // which are many awaits old by then (ledger import, sweeps, a job-results
    // spawn). A hold arriving in that span is caught by the pre-submit recheck,
    // after the claim move and the ticket write; safe, and one tick's worth of
    // spawns at most. The supervisor-hold node suite pins this read count (its
    // rig fires its final-hold hooks on the second lookup).
    const hold = await cycleHold($, w)
    const freeze = hold ? null : await supervisorHold($, w)
    await settleMarker($, w, hold ?? freeze?.reason ?? null)
    const log = await readLog($, w)
    if (log.kind === 'corrupt' || log.kind === 'unreadable') {
      $.ui.status(`delivery: mod · ledger-${log.kind}, holding`)
      return
    }
    let entries: Entries | null
    try {
      entries = await loadLedger($, w, log)
    } catch (error) {
      if (!(error instanceof StoreUnreadable)) throw error
      $.ui.status('delivery: mod · store-unreadable, holding')
      return
    }
    await sweepAdmissions($, w, entries)
    await probeAdmission($, w)
    const reread = async (now: Entries) => (await $.state.get(LEDGER)).value?.[w.seat] ?? now
    if (entries) {
      const released = await releasePrior($, w, entries)
      if (released.changed) entries = await reread(entries)
      if (await settleStale($, w, entries, released.alive)) entries = await reread(entries)
    }
    const seen = entries ? (await sweepStrays($, w, entries)).left : undefined
    const due = [...(await roomItems($, w, seen)), ...(await jobItems($, w))].filter(item => !isFinal(entries?.[item.id]))
    // Items stuck on a claim deferral go last, so a few unmovable files never hold the queue head.
    const stuck = (item: Item) => ['deferred:claim-move', 'deferred:inbox-missing'].includes(entries?.[item.id]?.status ?? '')
    let queue = [...due.filter(item => !stuck(item)), ...due.filter(stuck)]
    // Share pending reads and loaded bodies; evict missing or error results.
    queue = queue.map(item => {
      let cached: ReturnType<Item['load']> | undefined
      return { ...item, load: () => cached ??= item.load().then(v => { if (!v || 'error' in v) cached = undefined; return v }) }
    })
    if (!entries) {
      $.ui.status(queue.length ? 'delivery: mod · ledger-missing, holding (seed it, see README)' : 'delivery: mod · 0 queued')
      return
    }
    const unresolved = Object.values(entries).filter(isUnresolved).length
    let heldNote = ''
    const show = (extra = '', queued = queue.length) =>
      $.ui.status(`delivery: mod · ${queued} queued${unresolved ? ` · ${unresolved} unresolved` : ''}${extra}${heldNote}`)

    if (hold) {
      for (const item of queue) {
        await record($, w, item, 'deferred:refresh-hold', entry => !isFinal(entry) && entry?.status !== 'deferred:refresh-hold', { detail: hold })
      }
      show(` · refresh hold (${hold})`)
      return
    }
    const frozen = freeze?.reason ?? null
    if (frozen) {
      const live: Item[] = []
      let deferred = 0
      for (const item of queue) {
        const loaded = await item.load()
        // Control self-lines stay skipped, as without a freeze.
        if (loaded && 'error' in loaded && loaded.error === 'skipped:control') {
          await record($, w, item, loaded.error, entry => !isFinal(entry))
          continue
        }
        if (freeze && loaded && 'text' in loaded && passesFreeze(freeze, loaded)) {
          live.push(item)
          continue
        }
        deferred++
        const status = `deferred:${frozen}`
        await record($, w, item, status, entry => !isFinal(entry) && entry?.status !== status)
      }
      heldNote = ` · ${frozen}, ${deferred} deferred`
      queue = live
      if (!queue.length) {
        show('', 0)
        return
      }
    }
    if (unresolved) {
      // Ordinary mail holds behind an unresolved claim, as before (order is
      // kept, nothing is resent until the operator reconciles). The supervisor's
      // lifecycle legs do not: a refresh cycle must never wait on a reconcile
      // (Pheme, 2026-10-29: one stuck claim held the capsule request and the
      // resume order for hours and the cycle failed). The unresolved item itself
      // is never resent.
      const legs: Item[] = []
      for (const item of queue) {
        if (isUnresolved(entries[item.id])) continue
        if (lifecycleOnly(await item.load())) legs.push(item)
      }
      show(heldOn(Object.keys(entries).find(id => isUnresolved(entries![id])) ?? '<id>'), queue.length)
      if (!legs.length) return
      queue = legs
    }
    if (!ownerPid && config.roomRoot) {
      for (const item of queue) {
        await record($, w, item, 'deferred:admission-no-pid', entry => !isFinal(entry) && entry?.status !== 'deferred:admission-no-pid')
      }
      show(` · admission-no-pid, ${queue.length} deferred`)
      return
    }
    if (admissionFailure !== undefined) {
      for (const item of queue) {
        await record($, w, item, 'deferred:admission-unwritable', entry => !isFinal(entry) && entry?.status !== 'deferred:admission-unwritable', { detail: admissionFailure })
      }
      show(` · admission-unwritable, ${queue.length} deferred`)
      return
    }
    // A main turn in flight, or a pointer admitted for the coming turn: the
    // tick's submit could not enter before the session is idle, and claiming
    // would hide the file from the model's own drain. Lifecycle legs (the
    // supervisor's capsule and resume orders) still go: their claim line is
    // what the supervisor watches for, and their submit was always queued until
    // idle. The queue-level guard is the fast path; the gated claim checks
    // admissions again after any queued sample has bound its files.
    if (guarded(null) || admissionTurns.size) {
      const live: Item[] = []
      for (const item of queue) {
        const file = item.source === 'room' ? roomFile(w, item.id) : null
        if (!guarded(file)) {
          live.push(item)
          continue
        }
        const loaded = await item.load()
        if (lifecycleOnly(loaded)) live.push(item)
      }
      if (!live.length) {
        show(' · turn in flight, the inbox stays visible to the drain')
        return
      }
      queue = live
    }
    show()
    // At most one submit a tick; item-specific claim or admission failures try
    // the next item.
    let deferrals = 0
    let claimTries = 0
    for (const item of queue) {
      const attempts = (entries[item.id]?.attempts ?? 0) + 1

      // The claim on disk comes first, so a claim that fails writes no claim line
      // to undo: the file moves inbox/ to claimed/, out of room_drain's sight for
      // the whole wait for the turn. Already in claimed/ (a failed restore, a
      // crash after the claim): nothing to move.
      const file = item.source === 'room' ? roomFile(w, item.id) : null
      // Turns can start between queue items; jobs have no gated Room claim.
      if (turnInFlight() && !lifecycleOnly(await item.load())) continue
      if ((await $.prompt.read()).text !== '') {
        await record($, w, item, 'deferred:composer-busy', entry => !isFinal(entry) && entry?.status !== 'deferred:composer-busy')
        show(' · composer busy')
        return
      }
      const loaded = await item.load()
      if (loaded === null) continue
      if ('error' in loaded) {
        await record($, w, item, loaded.error, entry => !isFinal(entry))
        return
      }
      // Re-evaluate a turn that began during the composer or body read.
      if (turnInFlight() && !lifecycleOnly(loaded)) continue
      if (file && !item.claimed) {
        if (claimTries >= MAX_CLAIM_TRIES) return
        // An admitted file stays visible to its pointer without spending a try.
        // Moved goes on; blocked/failed defer; absent means room_drain took it.
        const claim = await moveRoom($, w, item, [inboxFile, claimedFile], undefined, false, 'quiet', loaded.lifecycle === true)
        if (claim === 'admitted') continue
        claimTries++
        if (claim !== 'moved') {
          const folder = config.roomRoot ? await exists($, inboxDir(w)) : false
          const down = folder === false
          const consumed = folder === true && claim === 'absent'
          // Never capped into an error: a filesystem hiccup is not a proven
          // non-delivery. The deferral is one line; the same state adds none.
          const status = down ? 'deferred:inbox-missing' : consumed ? 'dropped:consumed' : 'deferred:claim-move'
          await record($, w, item, status, entry => !isFinal(entry) && entry?.status !== status, {
            detail: consumed ? `inbox file missing: ${inboxFile(w, file)}` : folder === null ? 'folder check failed' : `claim move ${claim}`,
          })
          // A deferral goes on to the next item, so one stuck file does not block
          // the rest, but the third ends the tick (the next one retries). A file
          // room_drain already took is not a deferral; every non-admitted try counts toward
          // an overall cap of six, which bounds spawns per tick.
          if (status !== 'dropped:consumed' && ++deferrals >= MAX_CLAIM_DEFERRALS) return
          continue
        }
      }
      // Reserve the attempt in shared state before publishing, so a reloaded
      // generation sees the in-flight admission and preserves its ticket.
      // Its durable claim follows publication, before any possible submit.
      const claimExtra = { attempts, gen: generation, pid: ownerPid }
      const reservation = await record($, w, item, 'submitting', entry => !isFinal(entry), { ...claimExtra, persist: false })
      if (!reservation) return
      const undoReservation = () => transition($, w, item.id, entry =>
        entry?.status === 'submitting' && entry.attempts === attempts && entry.gen === claimExtra.gen ? reservation.prior : null,
      ).catch(() => null)
      // Every closure below acts on this attempt only: a late answer from an
      // older attempt finds a different attempt number and records and moves
      // nothing.
      const own = (entry: FleetDeliveryEntry | undefined) => isUnresolved(entry) && entry?.attempts === attempts
      const settle = async (entered: Awaited<ReturnType<$['prompt']['submit']>>) => {
        if (entered.drop !== undefined) {
          if (await record($, w, item, 'dropped', own, { attempts, detail: clean(entered.drop, 200) })) {
            await restoreRoomFile($, w, item, { status: 'dropped', attempts })
          }
          return
        }
        // A late start after a reconcile still landed: record it, and say so.
        const landed = await record(
          $,
          w,
          item,
          'submitted',
          entry => entry?.attempts === attempts && (isUnresolved(entry) || !isFinal(entry)),
          { attempts, detail: prior => (isUnresolved(prior) ? undefined : 'late start after reconcile') },
        )
        if (landed) {
          await finishRoomFile($, w, item, { status: 'submitted', attempts })
          return
        }
        // Landed under another attempt's number: nothing is recorded, but the
        // operator is told it started.
        const now = (await $.state.get(LEDGER)).value?.[w.seat]?.[item.id]
        if (now && now.attempts !== attempts) {
          await note($, w, item, now, `note: late start from attempt ${attempts}, check the transcript`)
        }
      }
      const rejected = async () => {
        const status = retry('submit-rejected', attempts)
        if ((await record($, w, item, status, own, { attempts })) && status.startsWith('error:')) await restoreRoomFile($, w, item, { status, attempts })
      }
      const defer = async (reason: string, detail?: string, consumesRetry = false, admission = false) => {
        const status = consumesRetry ? retry(reason, attempts) : `deferred:${reason}`
        const count = consumesRetry ? attempts : attempts - 1
        // No submitting line was persisted for a failed admission. Restore
        // shared state silently when the durable status/count are unchanged.
        const unchanged = admission && reservation.prior?.status === status && (reservation.prior.attempts ?? 0) === count
        if (await record($, w, item, status, own, { attempts: count, ...(detail ? { detail } : {}), persist: !unchanged })) {
          await restoreRoomFile($, w, item, { status, attempts: count })
        }
        show(` · ${reason}, 1 ${status.startsWith('error:') ? 'dropped' : 'deferred'}`)
      }
      // Publish before reading either hold. The supervisor writes its phase
      // before waiting for live tickets, then injects its lifecycle leg.
      // Delay the durable submitting line until publication succeeds, so a
      // repeated no-cost admission failure does not churn two ledger lines.
      try { await assertCurrent($) } catch (error) {
        await undoReservation()
        throw error
      }
      const ts = await iso($)
      const attempt = config.roomRoot && ownerPid ? attemptNonce(ownerPid, ts) : null
      const ticket = attempt ? admitFile(w, item, attempt) : null
      const body = ticket ? { version: 1, seat: w.seat, item: item.id, attempt, pid: Number(ownerPid), ts } : null
      if (ticket && body) {
        const failed = await runHost($, ['node', '-e', WRITE, '--', ticket, JSON.stringify(body)])
        let present = failed ? await exists($, ticket) : true
        let squatted = false
        if (failed && present) {
          // A timeout may follow a successful rename, but a directory or a
          // foreign ticket cannot prove this WRITE landed. Never unlink it.
          try {
            const stat = await $.fs.stat(ticket)
            squatted = stat.kind === 'dir'
            present = stat.kind === 'file'
            if (present) {
              const text = await $.fs.read(ticket)
              let landed
              try { landed = JSON.parse(text) } catch { /* Not this attempt's JSON. */ }
              present = landed?.item === body.item && landed?.attempt === body.attempt && landed?.pid === body.pid && landed?.ts === body.ts
            }
          } catch { present = null }
        }
        if (failed && present !== true) {
          admissionFailure = failed
          await probeAdmission($, w)
          const directoryFailed = admissionFailure !== undefined
          // Only proven path/permission failures cost a retry. Transient
          // locks, host exceptions, and unknown publication stay free.
          const permanent = squatted || /^exit \d+ (?:EISDIR|ENOTDIR|EACCES|EINVAL|ENAMETOOLONG)(?:\s|$)/.test(failed)
          await defer('admission-unwritable', failed, !directoryFailed && present === false && permanent, true)
          if (++deferrals >= MAX_CLAIM_DEFERRALS || directoryFailed) return
          continue
        }
      }
      const removeTicket = (noteMissing = false) => ticket && body ? removeAdmission($, w, ticket, item, { status: 'submitting', attempts }, noteMissing) : Promise.resolve()
      // The claim lands before either hold recheck and submit, in $.state and
      // on disk. Whoever loses it submits nothing and releases its ticket.
      // A failed log append is undone; non-delivery is still proven.
      try {
        if (!(await record($, w, item, 'submitting', own, claimExtra, true))) {
          await removeTicket()
          return
        }
      } catch (error) {
        await undoReservation()
        // Always release our ticket here, Superseded included: when the
        // successor's settleStale has already marked this reservation
        // unresolved, the rollback is a no-op and the successor sweep keeps the
        // ticket, so skipping the unlink would leak it for our own generation.
        // Only this attempt's unique path is unlinked; a successor's ticket
        // always has a different filename.
        await removeTicket()
        if (!(error instanceof LogWriteFailed)) throw error
        show(' · log-write-failed, retrying next tick')
        return
      }
      // The hold is read at the start of the tick, and everything above awaited. Re-read both holds
      // here, the last point before the submit, and apply the queue rules again. Nothing has been
      // submitted yet, so the outcome is known, and the attempt count goes back to what it was (a deferral is not
      // a try against RETRY_CAP, as at the queue level): record the deferral over our own `submitting` line
      // (never an unresolved outcome) and put the file back in inbox/ for the next tick.
      const recheck = await cycleHold($, w)
      const refreeze = recheck ? null : await supervisorHold($, w)
      const blocked = recheck ? 'refresh-hold' : refreeze && !passesFreeze(refreeze, loaded) ? refreeze.reason : null
      if (blocked) {
        await removeTicket()
        await defer(blocked, recheck ?? undefined)
        return
      }
      let submit!: ReturnType<$['prompt']['submit']>
      let result
      try {
        // Both hold re-reads precede the entire submit wait budget.
        result = await waitForSubmit($, () => (submit = $.prompt.submit({ text: loaded.text })))
      } catch {
        try {
          await rejected()
        } finally {
          await removeTicket()
        }
        return
      }
      if (result === 'timeout') {
        // Not known to have entered or not: unresolved, never retried, until
        // the late answer comes or the operator reconciles it.
        // The late answer is wired first: a failed append below must not leave it unhandled.
        void submit.then(settle, rejected).finally(() => removeTicket()).catch(() => {})
        await record($, w, item, 'submitting:unresolved', entry => entry?.status === 'submitting' && entry.attempts === attempts, { attempts })
        show(heldOn(item.id))
        return
      }
      try {
        await settle(result)
      } finally {
        await removeTicket(result.drop === undefined)
      }
      const now = (await $.state.get(LEDGER)).value?.[w.seat] ?? {}
      show('', queue.filter(one => !isFinal(now[one.id])).length)
      return
    }
  } catch {
    // A failed tick leaves the ledger as it stood; the next one retries.
  } finally {
    isTicking = false
  }
}

// Starts the 30 s timer, or restarts it when it threw or stopped ticking
// (a refused period ends an interval without saying so).
async function ensureTicking($: $): Promise<void> {
  try {
    const now = await $.clock.now()
    if (timer && now - lastTickAt <= STALE_MS) return
    timer?.cancel()
    lastTickAt = now
    timer = $.clock.every(TICK_MS, () => {
      void $.clock.now().then(now => {
        lastTickAt = now
      })
      // isTicking is set before tick's first await: read it before the call.
      const blocked = isTicking
      void tick($)
      if (blocked) void refreshMarker($).catch(() => {})
    })
  } catch {
    timer = undefined
  }
}

// The undocumented cases (a permission prompt, plan mode, a draft in the
// box): submit one harmless marker after a delay the operator uses to put
// the session in that state, and log what happened. Ignores the owner
// switch, the refresh hold and the composer check on purpose: it is the
// operator's own act. Its lines are log-only, never ledger entries.
async function probe($: $, w: Where): Promise<void> {
  const id = `probe:${await $.clock.now()}`
  const startedAt = await $.clock.now()
  const draft = (await $.prompt.read()).text.length
  const line = async (status: string, detail: string) =>
    appendLog($, w, { id, source: 'probe', at: await iso($), status, detail })
  await line('probe:submitting', `composer-chars=${draft}`)
  try {
    const entered = await $.prompt.submit({
      text: `[delivery-probe ${await iso($)}] A marker from the fleet-delivery mod, testing delivery. Reply with the single word PROBE-OK and do nothing else.`,
    })
    const waited = `waited-ms=${(await $.clock.now()) - startedAt}`
    await (entered.drop !== undefined ? line('probe:dropped', `${waited} ${clean(entered.drop, 160)}`) : line('probe:entered', waited))
  } catch (error) {
    await line('probe:rejected', clean((error as Error)?.name, 60))
  }
}

// Where a command acts: the seat's resolved place with its ledger loaded.
async function commandPlace($: $): Promise<{ w: Where; entries: Entries } | string> {
  await begin($)
  const root = config.installRoot ? await installRoot($) : ''
  const seat = await seatName($)
  if (!root || !seat) return 'not configured (installRoot unset or no valid seat name)'
  const memory = await memoryRoot($, root)
  if (!memory) return 'the memory root could not be resolved (see .aigent/state.json)'
  const w = { root, memory, seat }
  await claimGeneration($)
  const log = await readLog($, w)
  if (log.kind === 'corrupt' || log.kind === 'unreadable') return `${logPath(w)} is ${log.kind}`
  let entries: Entries | null
  try {
    entries = await loadLedger($, w, log)
  } catch (error) {
    if (error instanceof StoreUnreadable) return `the plugin store cannot be read (${error.message}); delivery holds until it can`
    throw error
  }
  return entries ? { w, entries } : `the ledger is not seeded; seed ${logPath(w)} first (README)`
}

const COMMANDS = [
  {
    name: 'delivery-probe',
    description: 'fleet-delivery: after N seconds (default 20) submit one marker prompt and log the outcome',
    argumentHint: '[seconds]',
  },
  {
    name: 'delivery-reconcile',
    description: 'fleet-delivery: settle an unresolved delivery after checking the transcript (not-delivered retries it)',
    argumentHint: '<id> [delivered]',
  },
]

// register receives no engine interface. Emit its configuration warning
// once on the first startup/turn hook, when $.ui.log becomes available.
let warnLongSubmit = false
const warnSubmitTimeout = ($: $) => {
  if (!warnLongSubmit) return
  warnLongSubmit = false
  $.ui.log('fleet-delivery: warning: submitTimeoutMinutes exceeds 10; an unresolved submit defers lifecycle transitions until its own promise settles or its owning process ends.')
}

// -- Native pointer (0.4.0) ---------------------------------------------------
// A Room message a seat sends with room_send is ALSO announced to the
// recipient session through the engine's own cross-session channel
// ($.session.send, the SendMessage tool's own delivery): a short POINTER
// naming the Room file, never its content. The engine queues it inside the
// recipient: a turn of its own when the seat is idle, read inside the
// running turn otherwise, never typed into any prompt box. The recipient's
// model reads the mail with room_drain, the Room's own consumer, which moves
// the file inbox/ -> processed/ as read; this mod writes nothing for it.
// The tick stays exactly what it is today, the fallback: a file the model did
// not drain is delivered through the prompt box under every existing hold,
// and a file room_drain took first is, to the tick, absent. One body read
// either way: a file lies in exactly one of inbox/ (room_drain's) and
// claimed/ (the tick's). No match, no clock, no confirmation, no new ledger
// state.
//
// Two fences, because a pointer must never become the first prompt of a
// post-clear session ahead of the resume (the 2026-10-29 16:36Z failure):
// (1) a seat is announced to only while it publishes a fresh marker in the
//     shared Room saying a mod-owned 0.4.0 session is there to fence itself;
//     a supervisor-owned seat, a seat on an older mod, or a parked seat gets
//     no pointer and its tick (or supervisor) delivers the file as before;
// (2) the recipient re-checks the holds at the moment the pointer becomes a
//     prompt (prompt.submit), not at arrival, so a clear that started after
//     the pointer was queued still drops it; the file waits for the tick.
export const ROOM_SEND_TOOL = 'mcp__agent-room__room_send'
// The fence protocol: the first mod version whose receiver drops a pointer
// under a hold. A marker below it is from a mod without that drop. This is
// not plugin.json's version and does not move with it.
export const FENCE_VERSION = '0.4.0'
// A marker older than this is a seat that is parked, reloaded or no longer mod-owned.
export const MARKER_FRESH_MS = 15 * 60_000
const MARKER_EVERY_MS = 5 * 60_000
let markerAt = 0
let markerCheckedAt = 0
let markerWarned = false
let markerYielded = false
// Marker writes run one after another: a retire asked for during a publish
// waits for that write and then overwrites it, never skips.
function promiseMutex() {
  let tail: Promise<void> = Promise.resolve()
  return <T>(job: () => T | Promise<T>): Promise<T> => {
    const run = tail.then(() => job(), () => job())
    tail = run.then(() => {}, () => {})
    return run
  }
}
const serialMarker = promiseMutex()
let markerState: 'unknown' | 'published' | 'retired' = 'unknown'
// Stamped into the marker so a second mod-owned session in the same seat
// folder (a `claude -p` courier) cannot retire the live seat's marker, and
// the live seat re-publishes at once when the file stops reading as its own.
const markerStamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
// Main-loop turns in flight, by id: turn.start (no agentId) adds, turn.complete
// removes by id whoever ran it (an aborted turn ends through turn.complete with
// reason 'aborted'; there is no turn.abort event). Paired by id so a
// subagent's turn can never leave the main loop looking busy. The tick's own
// submit cannot enter until the session is idle, so claiming inbox/ into
// claimed/ during a turn buys nothing and hides the file from the model's own
// room_drain; the tick waits for the turn to end.
const mainTurns = new Set<string>()
const turnEndWaiters = new Set<(sessionEnd?: boolean) => void>()
const turnInFlight = () => mainTurns.size > 0
// An in-turn pointer releases at that turn's completion. A queued pointer
// releases when the first main turn that started after admission completes.
// Marked before next(e), so the file stays in inbox/ until then.
let turnSeq = 0
type Admission = { seq: number; turnId?: string; token: string }
const admissionTurns = new Map<string, Set<Admission>>()
let promptSeq = 0
type PromptAdmission = { token: string; text: string; files: string[]; replay?: true }
// Engine inputs are frozen. Keep identity outside the event; copied catches
// resolve matching-text FIFOs of pending checks or failed downstream prompts.
let promptTokens = new WeakMap<object, string>()
// Entries leave on settlement or when their last file binding releases.
const promptAdmissions = new Map<string, PromptAdmission>()
let warnedAdmissionCap = false
const resolvePromptToken = (event: { text?: unknown }, fifo: Iterable<{ token: string; text: string }>) =>
  promptTokens.get(event) ?? [...fifo].find(candidate => candidate.text === event.text)?.token
const takePromptAdmission = (event: { text?: unknown }, token = resolvePromptToken(event,
  [...promptAdmissions.values()].filter(admission => admission.replay))): PromptAdmission | undefined => {
  const admission = token !== undefined ? promptAdmissions.get(token) : undefined
  if (admission) promptAdmissions.delete(admission.token)
  return admission
}
const releasePromptAdmission = ({ files, token }: PromptAdmission) => {
  for (const file of files) {
    const bindings = admissionTurns.get(file)
    if (bindings) for (const binding of bindings) if (binding.token === token) bindings.delete(binding)
    if (!bindings?.size) admissionTurns.delete(file)
  }
}
const guarded = (file: string | null) => turnInFlight() || (file !== null && admissionTurns.has(file))
const lifecycleOnly = (loaded: Awaited<ReturnType<Item['load']>>) =>
  loaded !== null && 'text' in loaded && loaded.lifecycle === true
const releaseAdmissions = (turnId: string, upTo: number) => {
  for (const [file, admissions] of admissionTurns) {
    for (const a of admissions) {
      // Sampling reserves the file before hold I/O; it has not entered a turn yet.
      if (pointerChecks.has(a.token)) continue
      if (a.turnId === turnId || (a.turnId === undefined && a.seq < upTo)) admissions.delete(a)
    }
    if (!admissions.size) admissionTurns.delete(file)
  }
  for (const [token, admission] of promptAdmissions) {
    const bound = admission.files.some(file =>
      [...(admissionTurns.get(file) ?? [])].some(binding => binding.token === token))
    if (!bound) promptAdmissions.delete(token)
  }
}
// Only synchronous claim marking and fence decision/binding share this gate; no I/O.
const serialized = promiseMutex()
const tickOwned = new Set<string>()
// A session edge may clear tickOwned while a marked claim is still doing I/O.
const claimsInFlight = new Set<string>()
const resetTurnState = (edge: 'start' | 'end') => {
  mainTurns.clear()
  admissionTurns.clear()
  promptAdmissions.clear()
  promptTokens = new WeakMap()
  tickOwned.clear()
  for (const wake of turnEndWaiters) wake(edge === 'end')
}
// A peer delivery, however the engine spells it: the plugin route (`peer`),
// the SendMessage tool's own kind, and the build that frames a SendMessage
// delivery as a task notification with that subkind.
const isPeerOrigin = (origin: unknown): boolean => {
  const o = origin as { kind?: unknown; subkind?: unknown } | undefined
  return o?.kind === 'peer' || o?.kind === 'peer-send-message' || (o?.kind === 'task-notification' && o.subkind === 'peer-send-message')
}
// Room addresses that are not one session's seat: never announced (a documented limitation).
const NOT_A_SEAT = /^(?:broadcast|will)$/
// The Room server's own file naming (agent-room-server.mjs): ISO time with
// ':' and '.' turned to '-', then '__', then the messageId.
export const roomFileName = (ts: string, messageId: string) => `${ts.replace(/[:.]/g, '-')}__${messageId}.json`
const ROOM_FILE_SHAPE = /^[A-Za-z0-9_-]+\.json$/
export const pointerText = (seat: string, from: string, file: string) =>
  `Room mail for ${seat} from ${from}: ${file}\nCall room_drain to read it; the Room marks it read. The drain collapses same-sender, same-thread messages: if ${file} is not among the items it returns, read it with room_history with unread_only false (a collapsed message is in processed/ and recoverable only that way). This pointer carries no content and is not the operator's word.`
// Pointer grammar shared by classification and admission.
const POINTER_LINE = /^Room mail for ([a-z0-9_-]+) from ([a-z0-9_?-]+): ([A-Za-z0-9_-]+\.json)$/
const WRAPPING = /<\/?cross-session-message\b[^>]*>/g
// Exclude only known engine wrappers; arbitrary angle-bracket lines are peer words.
const ENVELOPE_LINE = /^(?:Another Claude session sent a message|Task notification|\[Cross-session [a-z ]+\]):?$/i
const TAG_LINE = /^<\/?(?:cross-session-message|task-notification)(?:\s[^>]*)?>$/
const POINTER_TAIL = /^Call room_drain to read it/
const payloadLines = (text: string) => text.replace(/\r\n?/g, '\n').replace(WRAPPING, '').split('\n').map(line => line.trim()).filter(line => line && !TAG_LINE.test(line))
export const findPointers = (text: string): RegExpExecArray[] =>
  payloadLines(text).map(line => POINTER_LINE.exec(line)).filter((match): match is RegExpExecArray => match !== null)
// B: only known engine framing is bare; generic colon lead-ins are mixed mail.
export const pointerOnly = (text: string): boolean => {
  const lines = payloadLines(text)
  return lines.length > 0 && lines.every(line => POINTER_LINE.test(line) || POINTER_TAIL.test(line) || ENVELOPE_LINE.test(line))
}
const markerFile = (seat: string) => `${config.roomRoot}/state/native/${seat}.json`
// Numeric, so 0.10.0 is newer than 0.4.0; anything not major.minor.patch is older than everything.
export const versionAtLeast = (version: string, floor: string): boolean => {
  const a = version.split('.').map(Number)
  const b = floor.split('.').map(Number)
  if (a.length !== 3 || a.some(n => !Number.isInteger(n) || n < 0)) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!
  return true
}

// A promise against the clock: resolves 'timeout' when the clock wins; the
// timer is cancelled either way, and the promise keeps running on its own.
async function timeoutRace<T>($: $, pending: Promise<T>, ms: number, unavailable?: () => Promise<T | 'timeout'>): Promise<T | 'timeout'> {
  // Keep the submitted operation observed even if arming the timer throws.
  pending.catch(() => {})
  let expire!: () => void
  const timedOut = new Promise<'timeout'>(done => { expire = () => done('timeout') })
  let expiry: Timer
  try { expiry = $.clock.after(ms, expire) } catch (error) {
    // Only a clock-arm failure takes this path; submit rejection stays intact.
    if (unavailable) return unavailable()
    throw error
  }
  try {
    return await Promise.race([pending, timedOut])
  } finally {
    expiry.cancel()
  }
}

// Row J: one deadline bounds turn WAITs; up to six full submit windows are separate.
async function waitForSubmit<T>($: $, startSubmit: () => Promise<T>): Promise<T | 'timeout'> {
  const submit = startSubmit()
  submit.catch(() => {})
  const turnEnded = Symbol('turn.complete')
  const idle = Symbol('session.end')
  const stopped = Symbol('wait ended')
  let completions = 0
  let sessionEnded = false
  let clockAvailable = true
  let notify!: (reason: typeof turnEnded | typeof idle) => void
  let ended = new Promise<typeof turnEnded | typeof idle>(done => { notify = done })
  let endSession!: (reason: typeof idle) => void
  const sessionEnd = new Promise<typeof idle>(done => { endSession = done })
  let expiry: Timer | undefined
  const wake = (sessionEnd = false) => {
    if (sessionEnd) { sessionEnded = true; expiry?.cancel(); notify(idle); endSession(idle) }
    else { completions++; notify(turnEnded) }
  }
  turnEndWaiters.add(wake)
  const clockless = async (): Promise<T | 'timeout'> => {
    clockAvailable = false
    expiry?.cancel()
    if (sessionEnded || !turnInFlight()) return 'timeout'
    const waiting = Promise.race([submit, ended])
    waiting.catch(() => {})
    const result = await waiting
    return result === turnEnded || result === idle ? 'timeout' : result
  }
  try {
    let expire!: () => void
    const deadline = new Promise<typeof stopped>(done => { expire = () => done(stopped) })
    // Only turn WAITs observe the deadline. It cannot shorten a granted window.
    const pending = Promise.race([submit, deadline])
    pending.catch(() => {})
    for (let windows = 0; windows < TURN_WAIT_ROUNDS; windows++) {
      if (!sessionEnded && !completions && turnInFlight()) {
        // Idle submit windows do not consume the turn WAIT budget.
        if (!expiry) {
          try { expiry = $.clock.after(TURN_WAIT_MS, expire) } catch { return await clockless() }
        }
        const waiting = Promise.race([pending, ended])
        waiting.catch(() => {})
        const result = await waiting
        if (result !== turnEnded && result !== idle) return result === stopped ? 'timeout' : result
      }
      if (sessionEnded) return 'timeout'
      if (completions) {
        completions--
        // Keep wakes received during a window; simultaneous completions each grant one.
        ended = new Promise(done => { notify = done })
      }
      // Session end interrupts WAITs and windows immediately; a late submit
      // settlement still corrects the unresolved ledger entry.
      const result = await timeoutRace<T | typeof idle>($, Promise.race([submit, sessionEnd]), config.submitTimeoutMs, clockless)
      if (result === idle) return 'timeout'
      if (result !== 'timeout' || !clockAvailable) return result
      if (sessionEnded || (!completions && !turnInFlight())) return 'timeout'
    }
    return 'timeout'
  } finally {
    expiry?.cancel()
    turnEndWaiters.delete(wake)
  }
}

// This seat tells the Room it can take pointers: mod-owned, this fence
// version, alive now, and not held. Published only while both holds are
// clear, so a held seat is never announced to and the sender falls back to
// the tick on its own; the receiver's prompt-time drop is the safety net.
// Rewritten every MARKER_EVERY_MS while the file still reads as ours, at
// once when it does not (another session's stamp, a retirement, a torn
// read): the file, not process memory, says whose the marker is.
type Marker = { owner?: unknown; version?: unknown; at?: unknown; stamp?: unknown; sessionId?: unknown }
async function readMarker($: $, seat: string): Promise<Marker | null> {
  try {
    return JSON.parse(await $.fs.read(markerFile(seat))) as Marker
  } catch {
    return null
  }
}
// Ours: written by this module (stamp), or by this same session before a hot
// reload (session id): the new module keeps, refreshes and retires its own
// seat's marker instead of yielding to it for 15 min.
const ours = (marker: Marker | null, sessionId: string | null) => marker?.stamp === markerStamp || (!!sessionId && marker?.sessionId === sessionId)
async function sessionIdOrNull($: $): Promise<string | null> {
  try {
    return (await $.session.id()) || null
  } catch {
    return null
  }
}
async function publishMarker($: $, w: Where): Promise<void> {
  if (!config.roomRoot) return
  await serialMarker(async () => {
    const now = await $.clock.now()
    // The id a sender addresses the pointer to; a /clear gives the process a new
    // one. With no id there is nothing to address: publish nothing, the tick delivers.
    const sessionId = await sessionIdOrNull($)
    if (!sessionId) return
    const current = await readMarker($, w.seat)
    const mine = ours(current, sessionId)
    if (mine && current?.owner === 'mod' && current?.sessionId === sessionId && markerState === 'published' && now - markerAt < MARKER_EVERY_MS) return
    // Another live session's fresh marker (a courier in the seat folder, or the
    // seat's own earlier process): never overwritten, or pointers would flap
    // between the two and the courier's model would drain the seat's inbox.
    if (!mine && current?.owner === 'mod' && typeof current.stamp === 'string' && typeof current.at === 'string' && now - Date.parse(current.at) <= MARKER_FRESH_MS) {
      if (!markerYielded) $.ui.log(`fleet-delivery: another session holds this seat's native marker (stamp ${clean(current.stamp, 20)}); pointers go to it until it retires or its marker ages out`)
      markerYielded = true
      return
    }
    markerYielded = false
    try {
      await $.fs.write(markerFile(w.seat), `${JSON.stringify({ seat: w.seat, owner: 'mod', version: FENCE_VERSION, at: new Date(now).toISOString(), stamp: markerStamp, sessionId })}\n`)
      markerAt = now
      markerState = 'published'
      markerWarned = false
    } catch (error) {
      if (!markerWarned) $.ui.log(`fleet-delivery: could not publish the native marker (${clean((error as Error)?.message, 120)}); peers will not announce to this seat`)
      markerWarned = true
    }
  })
}

// Retired by overwriting: {owner: 'retired'} fails the sender's mod-owned
// check at once, needs no process, and is one write a session.end hook can
// afford. Only a marker that reads back with this module's stamp is
// retired: a second session resolving to the same seat must not take the
// live seat's marker down on its exit. One write per retirement: under a
// hold, when the mod no longer owns the seat, and when the session ends.
async function retireMarker($: $, seat?: string | null): Promise<void> {
  markerAt = 0
  if (!config.roomRoot) return
  // Always enqueued: a retire asked for during an in-flight publish must run
  // after it, not be skipped on the state the publish is about to change.
  await serialMarker(async () => {
    if (markerState === 'retired') return
    seat ??= await seatName($)
    if (!seat) return
    const current = await readMarker($, seat)
    // Unreadable (torn, busy, denied): decide nothing; the next retire reads again.
    if (!current) return
    if (!ours(current, await sessionIdOrNull($))) return
    if (current.owner === 'retired') {
      markerState = 'retired'
      return
    }
    try {
      await $.fs.write(markerFile(seat), `${JSON.stringify({ seat, owner: 'retired', version: FENCE_VERSION, at: await iso($), stamp: markerStamp })}\n`)
      markerState = 'retired'
    } catch {}
  })
}

// The marker's own hold check: published while both holds are clear, retired otherwise.
async function settleMarker($: $, w: Where, hold: string | null): Promise<void> {
  if (hold) await retireMarker($, w.seat)
  else await publishMarker($, w)
}

// From the tick's timer, only when the timer found a tick already in flight
// (a long submit must not age the marker out, and a hold that begins
// meanwhile must retire it); an unblocked tick settles the marker itself.
// While published it looks every tick; retired or unknown, every
// MARKER_EVERY_MS, so an off seat does not re-resolve its owner and memory
// root every 30 s.
async function refreshMarker($: $): Promise<void> {
  if (!config.installRoot || !config.roomRoot) return
  const now = await $.clock.now()
  if (markerState !== 'published' && now - markerCheckedAt < MARKER_EVERY_MS) return
  markerCheckedAt = now
  const place = await resolve($)
  if (!('w' in place)) return retireMarker($)
  await settleMarker($, place.w, (await cycleHold($, place.w)) ?? (await supervisorHold($, place.w))?.reason ?? null)
}

// Whether `seat` can take a pointer right now: a fresh marker from a
// mod-owned session of a version with the fence, carrying the session id
// the pointer is addressed to. Never a bare name: the engine resolves a
// name the way SendMessage does, and a subagent of the sender named like
// the seat would take the pointer with isDelivered true.
async function takesPointers($: $, seat: string): Promise<{ why: string } | { sessionId: string }> {
  const marker = await readMarker($, seat)
  if (!marker) return { why: 'no native marker' }
  if (marker.owner !== 'mod' || typeof marker.version !== 'string' || typeof marker.at !== 'string') return { why: 'marker not mod-owned' }
  if (!versionAtLeast(marker.version, FENCE_VERSION)) return { why: `marker from mod ${marker.version}` }
  const age = (await $.clock.now()) - Date.parse(marker.at)
  if (!Number.isFinite(age) || age > MARKER_FRESH_MS) return { why: 'marker stale' }
  if (typeof marker.sessionId !== 'string' || !marker.sessionId) return { why: 'marker has no session id' }
  return { sessionId: marker.sessionId }
}

const ANNOUNCE_MS = 5_000
const noPointers = new Map<string, string>()
async function announceNative($: $, e: Record<string, unknown>, answered: { text?: string }): Promise<void> {
  const body = typeof e.body === 'string' ? e.body : ''
  if (!answered.text) return
  let out: { messageId?: unknown; ts?: unknown; to?: unknown } = {}
  try {
    out = JSON.parse(answered.text)
  } catch {
    $.ui.log("fleet-delivery: room_send answer was not the Room's JSON; nothing announced")
    return
  }
  // The address the Room published to, never the request's spelling.
  const to = name(out.to)
  if (typeof out.messageId !== 'string' || typeof out.ts !== 'string' || !to || !body) return
  // Not a seat (broadcast, will, …): a documented limitation, never announced.
  if (!SEAT_NAME.test(to) || NOT_A_SEAT.test(to) || CONTROL.test(body.trim())) return
  const file = roomFileName(out.ts, out.messageId)
  if (!ROOM_FILE_SHAPE.test(file)) {
    $.ui.log(`fleet-delivery: Room file name ${file} is outside the pointer grammar; ${to} waits for its tick`)
    return
  }
  if (!config.roomRoot) return
  const announce = (async () => {
    // The sender's own owner and holds have no bearing on the recipient: only
    // the recipient's marker decides.
    const from = (await seatName($)) ?? '?'
    const take = await takesPointers($, to)
    if ('why' in take) {
      // Once per recipient per reason: a 0.3.0 seat would otherwise log every send.
      if (noPointers.get(to) !== take.why) $.ui.log(`fleet-delivery: ${to} takes no pointers (${take.why}); ${to}/${file} waits for its tick (logged once per reason)`)
      noPointers.set(to, take.why)
      return
    }
    const sent = await timeoutRace($, $.session.send({ to: { sessionId: take.sessionId }, text: pointerText(to, from, file) }), ANNOUNCE_MS)
    if (sent === 'timeout') {
      $.ui.log(`fleet-delivery: pointer send unsettled after ${ANNOUNCE_MS / 1000} s; ${to}/${file} waits for its tick if it was not queued`)
      return
    }
    if (sent.isDelivered) {
      $.ui.log(`fleet-delivery: pointer queued ${to}/${file}`)
      noPointers.delete(to)
    }
    else $.ui.log(`fleet-delivery: pointer undelivered (${clean(sent.reason, 120) || 'refused'}); ${to}/${file} waits for its tick`)
  })().catch(error => $.ui.log(`fleet-delivery: pointer send failed (${clean((error as Error)?.message, 120)}); ${to}/${file} waits for its tick`))
  // Awaited inside the hook, the send itself bounded at ANNOUNCE_MS: $ is the
  // hook's for the hook's run, and nothing of ours continues after the race.
  await announce
}

// Decision table A-E, G-H, J in docs/native-delivery.md item 4 (F and I removed).
type Fence = { drop: string } | { admission: PromptAdmission } | null
type PointerState = 'UNREAD' | 'CLAIMED' | 'GONE' | 'UNKNOWN'
type PointerCheck = { settled: boolean; token: string; text: string }
// The engine may settle its catch while the original hook still awaits I/O.
const pointerChecks = new Map<string, PointerCheck>()
const abandonedPointer = 'fleet-delivery: pointer fence did not finish; the pointer is dropped, the file waits for the tick'
const capDrop = 'fleet-delivery: logErr: promptAdmissions cap 64 reached; pointer dropped, the file waits for the tick'
async function pointerHold($: $, text: string, matches: RegExpExecArray[], check: PointerCheck, turnId?: string): Promise<Fence> {
  const seat = await seatName($)
  const mine = matches.filter(match => match[1] === seat)
  const bare = pointerOnly(text)
  if (!seat || !mine.length) return bare ? { drop: `fleet-delivery: pointer dropped (${seat ? 'addressed to another seat' : 'seat unresolved'}); ${matches.map(match => `room:${match[1]}:${match[3]}`).join(', ')}` } : null
  const files = [...new Set(mine.map(match => match[3]!))]
  const named = `room:${seat}:${files.join(',')}`
  const held = (hold: string): Fence => ({ drop: `fleet-delivery: delivery held (${hold}); the ${bare ? 'pointer' : 'mixed mail'} to ${named} is dropped, the ${bare ? 'file waits' : 'files wait'} for the tick` })
  try {
    const root = await installRoot($)
    const memory = root ? await memoryRoot($, root) : null
    if (memory === null) return bare ? held('memory root unresolved') : null
    const w: Where = { root, memory, seat }
    // All filesystem work precedes the gate. A hung sample cannot park a claim.
    const samples = config.roomRoot ? await Promise.all(files.map(file => Promise.all([
      exists($, claimedFile(w, file)), exists($, inboxFile(w, file)),
    ]))) : []
    const legs = await Promise.all(samples.map(async ([claimed, inbox], i) => {
      if (claimed !== false || inbox !== true) return false
      const [item] = await roomItems($, w, { claimed: [], inbox: [files[i]!] })
      return item ? lifecycleOnly(await item.load()) : false
    }))
    let unread = false
    let unknown = false
    const fence: Fence = config.roomRoot ? await serialized((): Fence => {
      // Re-read ownership after sampling; marking always overrides stale disk state.
      const current = samples.map(([claimed, inbox], i): PointerState => {
        if (tickOwned.has(files[i]!) || claimsInFlight.has(files[i]!) || claimed === true) return 'CLAIMED'
        if (claimed === null || inbox === null) return 'UNKNOWN'
        return inbox ? 'UNREAD' : 'GONE'
      })
      unread = current.includes('UNREAD')
      unknown = current.includes('UNKNOWN')
      if (check.settled) return { drop: abandonedPointer }
      if (bare && unknown) return held('file state UNKNOWN')
      const admitted = files.filter((_, i) => current[i] === 'UNREAD' && !legs[i])
      if (bare && !admitted.length) return { drop: `fleet-delivery: pointer dropped (${files.map((file, i) => `${file}: ${legs[i] ? 'lifecycle' : current[i]}`).join(', ')}); nothing unread to admit for ${seat}` }
      if (!admitted.length) return null
      if (promptAdmissions.size >= 64) {
        if (!warnedAdmissionCap) $.ui.log(bare ? capDrop : 'fleet-delivery: logErr: promptAdmissions cap 64 reached; mixed mail enters without admission, the file waits for the tick')
        warnedAdmissionCap = true
        return bare ? { drop: capDrop } : null
      }
      const token = check.token
      const boundTurn = turnId !== undefined && mainTurns.has(turnId) ? turnId : undefined
      for (const file of admitted) {
        const bindings = admissionTurns.get(file) ?? new Set<Admission>()
        bindings.add({ seq: turnSeq, turnId: boundTurn, token })
        admissionTurns.set(file, bindings)
      }
      const admission: PromptAdmission = { token, text, files: admitted }
      promptAdmissions.set(token, admission)
      return { admission }
    }) : null
    if (bare && unknown) return fence
    // Provisional bindings protect files during hold I/O, but a dropped/error
    // result must release them before returning to the hook.
    const release = () => {
      if (fence && 'admission' in fence) {
        releasePromptAdmission(fence.admission)
        promptAdmissions.delete(check.token)
      }
    }
    try {
      if (!check.settled && (bare || unread)) {
        const [cycle, supervisor] = await Promise.all([cycleHold($, w), supervisorHold($, w)])
        const hold = cycle ?? supervisor?.reason
        if (hold) { release(); return bare ? held(hold) : null }
      }
      // A session edge can clear the provisional reservation during hold I/O.
      if (fence && 'admission' in fence && !fence.admission.files.every(file =>
        [...(admissionTurns.get(file) ?? [])].some(binding => binding.token === check.token))) {
        release()
        return bare ? held('pointer binding lost during hold check') : null
      }
      return fence
    } catch (error) { release(); throw error }
  } catch (error) {
    if (bare) return held(`pointer hold check failed: ${clean((error as Error)?.message, 120)}`)
    return null
  }
}

export const register: Register = (on, options) => {
  config = readConfig(options)
  warnLongSubmit = config.submitTimeoutMs > DEFAULT_SUBMIT_TIMEOUT_MIN * 60_000

  on('session.start', async ($, e, next) => {
    resetTurnState('start')
    warnSubmitTimeout($)
    void begin($)
    for (const command of COMMANDS) {
      try {
        await $.command.register(command)
      } catch {}
    }
    await ensureTicking($)
    void tick($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // A turn.complete this hook never hears (a /clear mid-turn, a skipped hook)
    // must not leave the loop looking busy for the life of the process.
    resetTurnState('end')
    if (config.installRoot) await retireMarker($).catch(() => {})
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      mainTurns.add(e.turnId)
      turnSeq++
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const startSeen = mainTurns.delete(e.turnId)
    if (e.agentId === undefined) {
      // Bound admissions release at their own completion; queued ones use sequence order.
      releaseAdmissions(e.turnId, startSeen ? turnSeq : turnSeq + 1)
      // Wake parked submits before any await, including ensureTicking.
      for (const wake of turnEndWaiters) wake()
      warnSubmitTimeout($)
      await ensureTicking($)
      void tick($)
    }
    return next(e)
  })


  on('tool.call', { tool: ROOM_SEND_TOOL }, async ($, e, next) => {
    const answered = await next(e)
    if (!config.installRoot || 'deny' in answered || answered.isError) return answered
    // Awaited inside the hook: the typings promise $ for the hook's own run, not
    // after it returns. The Room's answer is already in hand.
    await announceNative($, e as unknown as Record<string, unknown>, answered as { text?: string })
    return answered
  })

  on('prompt.submit', async ($, e, next) => {
    if (!config.installRoot || !isPeerOrigin(e.origin) || typeof e.text !== 'string') return next(e)
    const token = String(++promptSeq)
    const matches = findPointers(e.text)
    if (!matches.length) return next(e)
    const check: PointerCheck = { settled: false, token, text: e.text }
    pointerChecks.set(token, check)
    promptTokens.set(e, token)
    const fence = await pointerHold($, e.text, matches, check, e.turnId)
    const admission = fence && 'admission' in fence ? fence.admission : undefined
    pointerChecks.delete(token)
    if (!admission) promptTokens.delete(e)
    if (check.settled) {
      if (admission) releasePromptAdmission(admission)
      promptAdmissions.delete(token)
      return { drop: abandonedPointer }
    }
    if (fence && 'drop' in fence) {
      promptAdmissions.delete(token)
      if (fence.drop !== capDrop) $.ui.log(fence.drop)
      return { drop: fence.drop }
    }
    if (!admission) return next(e)
    // Holds may have spanned a turn completion. Start the release lifetime only
    // now, while the sampled reservation has kept claims off the file throughout.
    for (const file of admission.files) {
      for (const binding of admissionTurns.get(file) ?? []) {
        if (binding.token !== token) continue
        binding.seq = turnSeq
        binding.turnId = e.turnId !== undefined && mainTurns.has(e.turnId) ? e.turnId : undefined
      }
    }
    let entered: Awaited<ReturnType<typeof next>>
    try { entered = await next(e) } catch (error) {
      admission.replay = true
      throw error
    }
    promptAdmissions.delete(token)
    if ((entered as { drop?: unknown }).drop !== undefined) releasePromptAdmission(admission)
    return entered
  }).catch(($, e, next) => {
    // The engine skips a hook that throws or overruns and lets the prompt in;
    // an unfinished fence drops BARE pointers, while MIXED mail enters unbound
    // so the peer's words survive. A prompt already passed on is replayed;
    // a replay drop or rejection releases only its exact admission list.
    // `Caught.called`: next(e) then resolves to what the hook's last call settled
    // to, nothing beneath running again (claude-code.d.ts, Caught).
    if (next.called) {
      return (async () => {
        const admission = takePromptAdmission(e)
        let release = true
        try {
          const entered = await next(e)
          release = (entered as { drop?: unknown }).drop !== undefined
          return entered
        } finally {
          if (release && admission) releasePromptAdmission(admission)
        }
      })()
    }
    const token = resolvePromptToken(e, [...pointerChecks.values()].filter(check => !check.settled))
    const check = token !== undefined ? pointerChecks.get(token) : undefined
    if (check) check.settled = true
    // A hook that never called next() owns no replay admission: no text fallback here.
    const admission = token !== undefined ? takePromptAdmission(e, token) : undefined
    if (admission) releasePromptAdmission(admission)
    if (!pointerOnly(e.text)) return next(e)
    $.ui.log(abandonedPointer)
    return { drop: abandonedPointer }
  })

  on('command.run', { command: 'delivery-probe' }, async ($, e) => {
    const place = await commandPlace($)
    if (typeof place === 'string') return { text: `delivery-probe: ${place}` }
    const asked = Number.parseInt(e.args.trim() || String(PROBE_DEFAULT_S), 10)
    const seconds = Number.isFinite(asked) ? Math.min(PROBE_MAX_S, Math.max(0, asked)) : PROBE_DEFAULT_S
    $.clock.after(seconds * 1000, () => void probe($, place.w).catch(() => {}))
    return {
      text: `delivery-probe: armed; one marker prompt is submitted in ${seconds} s. Put the session in the state to test now; the outcome lands in ${logPath(place.w)} as probe:* lines.`,
    }
  }).catch(() => ({ text: 'delivery-probe: could not arm the probe' }))

  on('command.run', { command: 'delivery-reconcile' }, async ($, e) => {
    const [id, verdict] = e.args.trim().split(/\s+/)
    if (!id || (verdict !== undefined && verdict !== 'delivered')) {
      return { text: 'delivery-reconcile: usage /delivery-reconcile <id> [delivered]' }
    }
    const place = await commandPlace($)
    if (typeof place === 'string') return { text: `delivery-reconcile: ${place}` }
    const status = verdict === 'delivered' ? 'reconciled:delivered' : 'reconciled:not-delivered'
    const source = id.split(':')[0] === 'job' ? 'job-results' : 'room'
    const { w } = place
    const entryOf = async () => (await $.state.get(LEDGER)).value?.[w.seat]?.[id]
    const current = await entryOf()
    if (!isUnresolved(current)) return { text: `delivery-reconcile: ${id} is not unresolved; nothing changed` }
    // The log line first: if it cannot be written, the session state is not
    // touched either.
    const at = await iso($)
    const counted = counts(current)
    try {
      await appendLog($, w, { id, source, at, status, ...counted, detail: 'operator' })
    } catch (error) {
      return { text: `delivery-reconcile: could not write ${logPath(w)} (${clean((error as Error)?.message, 120)}); nothing changed, ${id} is still unresolved` }
    }
    const landed = await transition($, w, id, entry => (isUnresolved(entry) ? { status, at, ...counted } : null))
    if (!landed) {
      // It settled between the check and here: make the log's newest line
      // for it match the session again.
      const now = await entryOf()
      if (now) {
        await appendLog($, w, {
          id,
          source,
          at: now.at,
          status: now.status,
          ...counts(now),
          detail: 'settled before the reconcile',
        }).catch(() => {})
      }
      return { text: `delivery-reconcile: ${id} settled meanwhile as ${now?.status ?? 'unknown'}; nothing changed` }
    }
    // Reconciliation settles the ledger only; each pending submit still owns its ticket.
    // Not delivered: the file stays in claimed/ and the tick below sends it again.
    if (status === 'reconciled:delivered') await finishRoomFile($, w, { id, source }, { status, ...counted })
    void tick($)
    return {
      text: `delivery-reconcile: ${id} is ${status}${status === 'reconciled:not-delivered' ? '; it is delivered again on the next tick' : ''}`,
    }
  }).catch(() => ({ text: 'delivery-reconcile: could not reach the ledger' }))
}
