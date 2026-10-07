// fleet-band's $.state contract: one snapshot, written by the refresh
// (60 s timer, turn end, or a command run) and read by the band.
// A field left out is not configured (skipped); null is configured but
// unreadable (drawn as "?").

export type FleetBandHeldReason =
  | 'hold-without-release'
  | 'released'
  | 'no-hold-in-tail'
  | 'log-over-read-cap'
  | 'log-unreadable'

export type FleetBandHeld = {
  seat: string
  state: 'held' | 'clear' | 'unknown'
  reason: FleetBandHeldReason
}

export type FleetBandPending = {
  id: string
  job: string
  summary: string
  producedAt: string
}

export type FleetBandSnapshot = {
  at: number
  seat: string
  ctxPercent: number | null
  roomUnread?: number | null
  pending?: FleetBandPending[] | null
  needsYou?: string[] | null
  held?: FleetBandHeld[]
}

declare module 'claude-code' {
  interface PluginState {
    'fleet-band': { snapshot: FleetBandSnapshot | null }
  }
}
