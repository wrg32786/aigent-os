// fleet-delivery's $.state contract: the delivery ledger of each seat, held
// by the host for the session (it survives a hot reload, and an old module
// and its replacement see the same versioned value). Across sessions it is
// rebuilt from the seat's append-only log, newest line per id.

export type FleetDeliveryEntry = {
  // deferred:*, submitting, submitting:unresolved, submitted, dropped,
  // skipped:control, error:*, reconciled:not-delivered, reconciled:delivered
  status: string
  at: string
  attempts?: number
}

// Item id -> its newest entry, per seat.
export type FleetDeliveryLedger = Record<string, Record<string, FleetDeliveryEntry>>

declare module 'claude-code' {
  interface PluginState {
    // generation: bumped by each loaded module; only the newest writes the log.
    'fleet-delivery': { ledger: FleetDeliveryLedger; generation: number }
  }
}
