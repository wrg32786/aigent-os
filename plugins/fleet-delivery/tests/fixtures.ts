// Shared fake seat and peer-envelope fixtures for both test runners.
import { pointerText } from '../hooks/register.ts'

// POSIX-absolute paths reach the harness unchanged on every platform.
export const ROOT = '/example/aigent'
export const ROOM = '/example/room'
// ROOT has no vault/memory, so its memory root is ROOT/memory.
export const LOG = `${ROOT}/memory/runtime/mod-delivery-ledger.alpha.jsonl`
export const OWNER = `${ROOT}/.aigent/delivery-owner.json`
export const CYCLE = `${ROOT}/memory/runtime/auto-clear-cycle.json`
export const INBOX = `${ROOM}/inbox/alpha`
export const PROCESSED = `${ROOM}/processed/alpha`
export const CLAIMED = `${ROOM}/claimed/alpha`
export const RENAME =
  'try{const [a,b]=process.argv.slice(-2);const fs=require("fs");fs.mkdirSync(require("path").dirname(b),{recursive:true});fs.renameSync(a,b)}catch(e){process.stderr.write(String(e&&(e.code||e.message)));process.exit(1)}'
export const CONFIGURED = { options: { installRoot: ROOT, roomRoot: ROOM, seat: 'alpha' } }

export const line = (value: object) => {
  const json = JSON.stringify(value)
  return `${json.length} ${json}\n`
}
export const SEED = line({ id: 'seed', source: 'seed', at: '2026-10-07T00:00:00.000Z', status: 'seed' })
export const MOD = '{"owner":{"alpha":"mod"}}'
export const IDLE = JSON.stringify({ state: 'idle', clear_intent: null, hold: null })

export const envelope = (from: string, text: string) =>
  JSON.stringify({ messageId: 'm1', from, to: 'alpha', parts: [{ text }], ts: '2026-10-07T18:00:00.000Z' })
export const ENVELOPE = envelope('beta', 'hello from beta')
// A configured seat: owner mod, seeded log, an idle refresh cycle, one message.
export const READY = { [OWNER]: MOD, [LOG]: SEED, [CYCLE]: IDLE, [`${INBOX}/a.json`]: ENVELOPE }

export const TURN = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const
export const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 }, wait: false } as const

// The engine's peer envelope, measured on a live session 2026-10-29.
export const wrap = (text: string) => `<cross-session-message from="uds:\\\\.\\pipe\\LOCAL\\cc-msg-x" from-name="beta" from-mode="prompting">\n${text}\n</cross-session-message>\n`
export const A_POINTER = pointerText('alpha', 'beta', 'a.json')
export const asPeerPrompt = (text: string) => ({ ...RUN, origin: { kind: 'peer' as const }, text: wrap(text) })
