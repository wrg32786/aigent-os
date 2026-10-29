// fleet-delivery's $.state contract: the delivery ledger of each seat, held
// by the host for the session (it survives a hot reload, and an old module
// and its replacement see the same versioned value). Across sessions it is
// rebuilt from the seat's append-only log, newest line per id.

export type FleetDeliveryEntry = {
  // deferred:* (including deferred:claim-move, deferred:inbox-missing,
  // deferred:native-queued: the native copy was handed to the model, its
  // transcript row is awaited), submitting, submitting:unresolved, submitted,
  // dropped, dropped:consumed, skipped:control, error:*,
  // reconciled:not-delivered, reconciled:delivered,
  // delivered:native (a transcript user row carries the file's tag)
  status: string
  at: string
  attempts?: number
  // The CLI process that wrote a `submitting` claim.
  pid?: string
  // The module generation that wrote a `submitting` claim.
  gen?: number
}

// Item id -> its newest entry, per seat.
export type FleetDeliveryLedger = Record<string, Record<string, FleetDeliveryEntry>>

declare module 'claude-code' {
  interface PluginState {
    // generation: bumped by each loaded module; only the newest writes the log.
    'fleet-delivery': {
      ledger: FleetDeliveryLedger
      generation: number
      // The running main turn, or null between turns; a hot reload mid-turn keeps it.
      turn: { id: string; at: number } | null
      // Room file id -> when its native copy was handed to the model; cleared once the transcript confirms the read.
      'native-pending': Record<string, string>
    }
  }
}
