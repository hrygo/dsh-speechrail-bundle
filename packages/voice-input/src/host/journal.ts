/**
 * Non-sensitive pending-operation journal.
 *
 * The journal exists for exactly one reason: after a reload, a request that was already
 * uploaded must not be forgotten. It stores an operation id, a phase and a timestamp —
 * never audio, text, credentials or a replayable request.
 * @module dsh-voice-input/host/journal
 */

/** One recorded in-flight operation. */
export interface JournalRecord {
  /** Client-generated operation id. */
  readonly operationId: string
  /** `pending` before the upload starts, `unknown` once the outcome could not be proven. */
  readonly phase: 'pending' | 'unknown'
  /** ISO timestamp of the first write. */
  readonly createdAt: string
}

/** What the journal currently holds, or that it cannot be trusted. */
export type JournalState =
  | { readonly available: true; readonly pending: JournalRecord | null }
  | { readonly available: false }

/**
 * Durable store for the single pending operation.
 *
 * Every method answers rather than throws: a caller must be able to distinguish
 * "nothing is pending" from "the medium cannot be read", because only the first
 * permits a new upload.
 */
export interface PendingJournal {
  /** Read the current record, or report the medium as unusable. */
  read(): Promise<JournalState>
  /** Record a pending operation; false means the write did not land. */
  record(entry: JournalRecord): Promise<boolean>
  /** Clear the record when it still belongs to this operation id. */
  clear(operationId: string): Promise<boolean>
  /**
   * Clear the slot without matching an id.
   *
   * Only an explicit user acknowledgement of an *unreadable* record may call this:
   * the user is asserting that no upload of theirs is outstanding. It reads first, so it
   * refuses both when the slot holds a readable record - an upload may have written one
   * after the caller decided - and when the medium cannot be read; unreadable bytes are
   * still overwritten, which is the recovery this exists for.
   */
  reset(): Promise<boolean>
}

/**
 * Unit name of the single-ledger journal.
 *
 * The storage backend validates unit names against `/^[a-z][a-z0-9_]*$/`, so a hyphen
 * makes `kv.open()` reject the descriptor: every journal call would then report the
 * medium as unavailable, the gate would open as unproven, and no upload could ever be
 * sent. `tools/check-journal-unit.mjs` asserts this against the real rule.
 */
/**
 * Durable storage unit for an upload whose outcome is unknown.
 *
 * Deliberately still the 1.x name: the unit is an on-disk record, not a label. Renaming it with the
 * plugin would leave an outstanding unproven upload recorded under a name nothing reads any more -
 * which is exactly the fail-closed gate this journal exists to keep. A migration would be required to
 * rename it safely, and losing the record is worse than an odd filename.
 */
export const JOURNAL_UNIT = 'speechrail_input_pending'

/** Unit format version; a mismatch on disk reads as unusable rather than as empty. */
export const JOURNAL_VERSION = 1

/**
 * Parse a trusted-looking record out of an untrusted stored value.
 * @param value - decoded global slot.
 * @returns the record, or null when the slot is empty or malformed.
 */
export function parseJournalRecord(value: unknown): JournalRecord | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const operationId = candidate.operationId
  const phase = candidate.phase
  const createdAt = candidate.createdAt
  if (typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/u.test(operationId)) return null
  if (phase !== 'pending' && phase !== 'unknown') return null
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) return null
  return { operationId, phase, createdAt }
}

/** Storage-facing subset of one opened unit, so tests can drive the journal directly. */
export interface JournalUnit {
  /** Read the whole unit's global slot. */
  readGlobal(): Promise<unknown>
  /** Replace the whole unit's global slot. */
  writeGlobal(value: unknown): Promise<void>
}

/**
 * Build a journal over one opened unit.
 *
 * A malformed record, a read failure and a write failure all report `available: false`
 * or `false` respectively; none of them is reported as "empty".
 * @param unit - opened storage unit.
 * @returns the journal facade.
 */
export function journalFromUnit(unit: JournalUnit): PendingJournal {
  return {
    async read(): Promise<JournalState> {
      let stored: unknown
      try {
        stored = await unit.readGlobal()
      } catch {
        return { available: false }
      }
      if (stored === null || stored === undefined) return { available: true, pending: null }
      const record = parseJournalRecord(stored)
      if (record === null) return { available: false }
      return { available: true, pending: record }
    },
    async record(entry: JournalRecord): Promise<boolean> {
      try {
        await unit.writeGlobal(entry)
        return true
      } catch {
        return false
      }
    },
    async clear(operationId: string): Promise<boolean> {
      let stored: unknown
      try {
        stored = await unit.readGlobal()
      } catch {
        return false
      }
      const record = parseJournalRecord(stored)
      if (stored !== null && stored !== undefined && record === null) return false
      if (record !== null && record.operationId !== operationId) return false
      try {
        await unit.writeGlobal(null)
        return true
      } catch {
        return false
      }
    },
    async reset(): Promise<boolean> {
      let stored: unknown
      try {
        stored = await unit.readGlobal()
      } catch {
        return false
      }
      // A readable record belongs to a live upload: erasing it would destroy the only
      // evidence that an operation is outstanding. Unreadable bytes are still erased, which
      // is the case this exists for.
      if (parseJournalRecord(stored) !== null) return false
      // Between this read and the write below another task can record an operation, and the
      // storage service offers no compare-and-set to close that gap; the write can therefore
      // erase a record that appeared in it. The gate is still protected, because the core
      // re-checks who holds it after this returns.
      try {
        await unit.writeGlobal(null)
        return true
      } catch {
        return false
      }
    },
  }
}

/** In-memory journal for compositions and tests without a storage medium. */
export function memoryJournal(initial: JournalRecord | null = null): PendingJournal {
  let current = initial
  return {
    read: async () => ({ available: true, pending: current }),
    record: async (entry) => { current = entry; return true },
    clear: async (operationId) => {
      if (current !== null && current.operationId !== operationId) return false
      current = null
      return true
    },
    reset: async () => { current = null; return true },
  }
}
