/**
 * Host API local storage adapter.
 *
 * Inside a Polkadot host every "table" is one JSON value under its own key in
 * the host's local storage. Outside a host (a plain browser tab, unit tests)
 * the same tables live in memory and are gone on reload.
 *
 * Three rules keep the records honest:
 *
 *   - **A failed host call is an error, never a quiet switch to memory.** The
 *     session used to demote itself to memory on the first host error and
 *     report every later write as done; the sales, pending claims and report
 *     locks written after that vanished on reload. Now the caller gets a
 *     `StorageError`, and the storage health (`onStorageHealth`) says why, so
 *     the app can stop taking payments and tell the merchant.
 *   - **Changes to one table run one at a time** (`mutateTable`). Every write
 *     reads the whole table, changes it and writes it back; two of those that
 *     overlap used to drop one of the changes.
 *   - **A table that cannot be read is never written over.** Garbage under a
 *     table's key used to read as empty and be replaced by the next write.
 */

"use client"

import { awaitHostRuntime, isInHost, onTruApi } from "@/lib/host/detect"

// ── change events (re-render the hooks that read a table) ──────────────────

const storageEvents = new EventTarget()

export function onStorageChange(table: string, callback: () => void): () => void {
  const handler = () => callback()
  storageEvents.addEventListener(`change:${table}`, handler)
  return () => storageEvents.removeEventListener(`change:${table}`, handler)
}

function notifyChange(table: string) {
  storageEvents.dispatchEvent(new Event(`change:${table}`))
}

// ── errors and health ───────────────────────────────────────────────────────

/**
 * Why a storage call failed:
 *
 *   full        — the host refused the write: its storage is full
 *   unavailable — the host bridge failed or is missing
 *   timeout     — the host did not answer in time
 *   corrupt     — the stored table is not a JSON array; left untouched
 */
export type StorageFailure = "full" | "unavailable" | "timeout" | "corrupt"

export class StorageError extends Error {
  override readonly name = "StorageError"
  constructor(
    readonly kind: StorageFailure,
    readonly op: "read" | "write" | "clear",
    readonly table: string,
    options?: { cause?: unknown },
  ) {
    super(`storage ${op} of "${table}" failed: ${kind}`, options)
  }
}

export type StorageHealth = { ok: true } | { ok: false; kind: StorageFailure; table: string }

/**
 * Open failures, by table ("*" for the driver as a whole), with the kind of
 * call that failed. What clears one is what proves it gone:
 *
 *   - a failed write (full, unavailable, timeout) — a write to that same
 *     table going through; a small write elsewhere fitting proves nothing;
 *   - a corrupt table — a clean read of it;
 *   - a failed read (unavailable, timeout) — any call going through: the
 *     bridge answers again;
 *   - "*" — any call going through.
 */
type Failure = {
  kind: StorageFailure
  op: StorageError["op"]
  /** A full store has since shown room for a sale's write: it no longer stops sales. */
  saleRoom?: boolean
}
const failures = new Map<string, Failure>()
const healthEvents = new EventTarget()
let health: StorageHealth = { ok: true }
let saleHealth: StorageHealth = { ok: true }

const BRIDGE_LEVEL: ReadonlySet<StorageFailure> = new Set(["unavailable", "timeout"])
const SEVERITY: Record<StorageFailure, number> = { corrupt: 3, full: 2, unavailable: 1, timeout: 0 }

/** The tables a sale needs: its record, and the claim kept for a restart. */
export const SALE_TABLES = ["sales", "pendingClaims"] as const
const SALE_TABLE_SET: ReadonlySet<string> = new Set(SALE_TABLES)

/**
 * A failure that stops a sale: on a table it needs, the driver, the bridge
 * itself, or a full store (one quota for every table: a store that refused
 * one write will refuse the sale's).
 */
function blocksSales(table: string, f: Failure): boolean {
  return (
    SALE_TABLE_SET.has(table) ||
    table === "*" ||
    (f.kind === "full" && !f.saleRoom) ||
    (f.op === "read" && BRIDGE_LEVEL.has(f.kind))
  )
}

/** Room a sale's writes need: its record and its pending claim, with margin. */
const SALE_ROOM = 4096

// Tables read this session: on recovery each gets a change event, so the
// screens that failed to read them load again.
const knownTables = new Set<string>()
// Last known stored size of each table, and how much more room a write the
// host refused as full needed (with some margin) — what a probe must find.
const storedLen = new Map<string, number>()
const neededRoom = new Map<string, number>()

function worstOf(entries: Iterable<[string, Failure]>): StorageHealth {
  let worst: { table: string; kind: StorageFailure } | null = null
  for (const [table, f] of entries) {
    if (!worst || SEVERITY[f.kind] > SEVERITY[worst.kind]) worst = { table, kind: f.kind }
  }
  return worst ? { ok: false, kind: worst.kind, table: worst.table } : { ok: true }
}

function sameHealth(a: StorageHealth, b: StorageHealth): boolean {
  if (a.ok || b.ok) return a.ok === b.ok
  return a.kind === b.kind && a.table === b.table
}

function recompute(): void {
  const nextHealth = worstOf(failures)
  const nextSale = worstOf([...failures].filter(([t, f]) => blocksSales(t, f)))
  const recovered = nextHealth.ok && !health.ok
  const changed = !sameHealth(nextHealth, health) || !sameHealth(nextSale, saleHealth)
  if (!sameHealth(nextHealth, health)) health = nextHealth
  if (!sameHealth(nextSale, saleHealth)) saleHealth = nextSale
  if (changed) healthEvents.dispatchEvent(new Event("change"))
  if (recovered) for (const table of knownTables) notifyChange(table)
}

/** A failure that only a write (or a clean read, for corrupt) can clear. */
function isSticky(f: Failure): boolean {
  return f.op !== "read" || f.kind === "corrupt" || f.kind === "full"
}

function recordFailure(table: string, kind: StorageFailure, op: StorageError["op"]): void {
  const existing = failures.get(table)
  const next: Failure = { kind, op }
  // A passing bridge hiccup must not replace what only a write or a clean
  // read can clear — any success would then wipe both.
  if (existing && isSticky(existing) && !isSticky(next)) return
  failures.set(table, next)
  recompute()
}

/** A call on `table` went through: clear what it proves. */
function recordSuccess(table: string, op: StorageError["op"]): void {
  let changed = false
  for (const [t, f] of [...failures]) {
    const proves =
      (BRIDGE_LEVEL.has(f.kind) && (f.op === "read" || t === "*")) ||
      (t === table && op !== "read" && f.op !== "read" && f.kind !== "corrupt") ||
      (t === table && op === "clear")
    if (proves) {
      failures.delete(t)
      neededRoom.delete(t)
      changed = true
    } else if (
      f.kind === "full" &&
      !f.saleRoom &&
      !SALE_TABLE_SET.has(t) &&
      t !== "*" &&
      op === "write" &&
      SALE_TABLE_SET.has(table)
    ) {
      // A sale's table took a write: there is room for sales, whatever the
      // larger write elsewhere still needs.
      failures.set(t, { ...f, saleRoom: true })
      changed = true
    }
  }
  if (changed) recompute()
}

/** `table` read and parsed cleanly. */
function recordCleanRead(table: string): void {
  if (failures.get(table)?.kind === "corrupt") {
    failures.delete(table)
    recompute()
  }
}

/** The storage as a whole: the worst open failure, on any table. */
export function getStorageHealth(): StorageHealth {
  return health
}

/** Whether a sale can be kept: failures on the tables it needs, the driver or the bridge. */
export function getSaleStorageHealth(): StorageHealth {
  return saleHealth
}

export function onStorageHealth(callback: (health: StorageHealth) => void): () => void {
  const handler = () => callback(health)
  healthEvents.addEventListener("change", handler)
  return () => healthEvents.removeEventListener("change", handler)
}

/** A raw driver call that is not recorded against any table (for probes). */
async function rawCall(call: () => Promise<unknown>): Promise<void> {
  await withTimeout(call(), "write", PROBE_KEY)
}

/**
 * Find out whether the storage can keep a sale again, by doing what a sale
 * does. The tables a sale needs, and every table with an open failure, are
 * read and parsed; a table whose write failed is written back in place,
 * after first finding as much free room as the refused write needed (a
 * scratch value of that size, removed again). A driver or bridge failure is
 * probed with a small scratch write. Resolves to the sale health afterwards;
 * `getStorageHealth()` has the rest.
 */
export async function probeStorage(): Promise<StorageHealth> {
  const toCheck = [...new Set<string>([...SALE_TABLES, ...[...failures.keys()].filter((t) => t !== "*")])]
  try {
    const driver = await getDriver()

    /** Find `size` characters of free room with a scratch value, removed again. */
    const findRoom = async (size: number): Promise<boolean> => {
      try {
        await rawCall(() => driver.writeString(PROBE_KEY, "x".repeat(size)))
      } catch {
        await rawCall(() => driver.clear(PROBE_KEY)).catch(() => undefined)
        return false
      }
      // A scratch value left behind would hold the very room just found.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await rawCall(() => driver.clear(PROBE_KEY))
          return true
        } catch {
          // try once more
        }
      }
      return false
    }

    const star = failures.get("*")
    const bridgeDown = (star && BRIDGE_LEVEL.has(star.kind)) || [...failures.values()].some((f) => f.op === "read" && BRIDGE_LEVEL.has(f.kind))
    if (bridgeDown) {
      try {
        await rawCall(() => driver.writeString(PROBE_KEY, "[]"))
        recordSuccess(PROBE_KEY, "read")
      } catch (err) {
        const kind = classify(err)
        recordFailure("*", kind, "write")
        if (kind === "full") neededRoom.set("*", SALE_ROOM)
        return saleHealth
      }
    }
    if (failures.get("*")?.kind === "full") {
      if (!(await findRoom(neededRoom.get("*") ?? SALE_ROOM))) return saleHealth
      failures.delete("*")
      neededRoom.delete("*")
      recompute()
    }
    for (const table of toCheck) {
      const f = failures.get(table)
      if (f && f.op !== "read" && f.kind !== "corrupt") {
        const need = neededRoom.get(table) ?? 0
        if (f.kind === "full" && !SALE_TABLE_SET.has(table) && !f.saleRoom) {
          // A table sales do not use: room for a sale is enough to sell.
          if (await findRoom(SALE_ROOM)) {
            failures.set(table, { ...f, saleRoom: true })
            recompute()
          }
        }
        if (need > 0 && !(await findRoom(need))) continue
        await mutateTable(table, (records) => ({ records, result: undefined }))
      } else {
        await readTable(table)
      }
    }
  } catch {
    // The failing call already recorded itself.
  }
  return saleHealth
}

const PROBE_KEY = "storageProbe"

// ── drivers ─────────────────────────────────────────────────────────────────

/** The raw string surface both host clients share. */
type Driver = {
  readString: (key: string) => Promise<string | undefined>
  writeString: (key: string, value: string) => Promise<unknown>
  clear: (key: string) => Promise<unknown>
}

const memoryStore = new Map<string, string>()

const memoryDriver: Driver = {
  readString: async (key) => memoryStore.get(key) ?? "",
  writeString: async (key, value) => {
    memoryStore.set(key, value)
  },
  clear: async (key) => {
    memoryStore.delete(key)
  },
}

let driverPromise: Promise<Driver> | null = null

/**
 * The host's storage inside a host, memory outside one. Decided once the host
 * runtime is known: a TrUAPI bootstrap can land after the page's own scripts,
 * and a choice made from an early synchronous look would lock the whole
 * session into memory. A host driver that fails to load is not cached, so the
 * next call tries again.
 */
function getDriver(): Promise<Driver> {
  if (!driverPromise) {
    const loading = loadDriver()
    driverPromise = loading
    loading.catch(() => {
      if (driverPromise === loading) driverPromise = null
    })
  }
  return driverPromise
}

async function loadDriver(): Promise<Driver> {
  if (typeof window === "undefined") return memoryDriver
  await awaitHostRuntime()
  if (!isInHost()) {
    console.log("[HostStorage] Not in a host — using in-memory storage")
    return memoryDriver
  }
  try {
    // Two clients, one store; each is loaded only on the runtime that uses it.
    if (await onTruApi()) {
      const { loadHostSdk } = await import("@/lib/host/sdk")
      const store = await (await loadHostSdk()).getHostLocalStorage()
      if (!store) throw new Error("host localStorage unavailable on the TrUAPI runtime")
      console.log("[HostStorage] Using host API localStorage (TrUAPI)")
      return store
    }
    const { hostLocalStorage } = await import("@novasamatech/host-api-wrapper")
    console.log("[HostStorage] Using host API localStorage")
    return hostLocalStorage
  } catch (err) {
    const error = new StorageError("unavailable", "read", "*", { cause: err })
    recordFailure("*", "unavailable", "read")
    throw error
  }
}

/** For tests: forget the chosen driver, the memory tables and the health. */
export function resetStorageForTests(): void {
  driverPromise = null
  memoryStore.clear()
  locks.clear()
  lingering.clear()
  failures.clear()
  storedLen.clear()
  neededRoom.clear()
  knownTables.clear()
  health = { ok: true }
  saleHealth = { ok: true }
}

/** For tests: use `driver` as the host's storage. */
export function useStorageDriverForTests(driver: Driver): void {
  driverPromise = Promise.resolve(driver)
}

export type StorageDriver = Driver

// ── host calls ──────────────────────────────────────────────────────────────

/** How long one host storage call may take. */
let CALL_TIMEOUT_MS = 15_000
/** For tests. */
export function setStorageTimeoutForTests(ms: number): void {
  CALL_TIMEOUT_MS = ms
}
/** A call the bridge failed (not a refusal) is tried once more after this. */
const RETRY_DELAY_MS = 300

function classify(err: unknown): StorageFailure {
  if (err instanceof StorageError) return err.kind
  const name = err instanceof Error ? `${err.name} ${err.message}` : String(err)
  if (/StorageErr::Full|\bfull\b|quota/i.test(name)) return "full"
  return "unavailable"
}

/**
 * Writes that timed out but may still land, by table. The next change to the
 * table waits for them (up to `LINGER_MS`), so a late write cannot replace a
 * newer table.
 */
const lingering = new Map<string, { settled: Promise<unknown>; until: number }>()
const LINGER_MS = 60_000

function withTimeout<T>(call: Promise<T>, op: StorageError["op"], table: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (op !== "read") {
        const settledCall = call.then(
          () => undefined,
          () => undefined,
        )
        const previous = lingering.get(table)?.settled ?? Promise.resolve()
        const entry = { settled: Promise.all([previous, settledCall]), until: Date.now() + LINGER_MS }
        lingering.set(table, entry)
        void entry.settled.then(() => {
          if (lingering.get(table) === entry) lingering.delete(table)
        })
      }
      reject(new StorageError("timeout", op, table))
    }, CALL_TIMEOUT_MS)
    call.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/** Wait for writes to `table` that timed out but may still land. */
async function awaitLingering(table: string): Promise<void> {
  const entry = lingering.get(table)
  if (!entry) return
  const left = entry.until - Date.now()
  // A write that never answers is given up on after LINGER_MS, once.
  if (left > 0) await Promise.race([entry.settled, new Promise((r) => setTimeout(r, left))])
  if (lingering.get(table) === entry) lingering.delete(table)
}

/**
 * One host storage call, with a timeout and one retry for a bridge failure (a
 * full store is not retried). A failure is recorded against the table and
 * rejects with a `StorageError`; a success clears what it proves.
 */
async function hostCall<T>(op: StorageError["op"], table: string, call: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const value = await withTimeout(call(), op, table)
      recordSuccess(table, op)
      return value
    } catch (err) {
      lastError = err
      if (classify(err) === "full") break
      // A write that timed out may still land: retrying could race it.
      if (op !== "read" && classify(err) === "timeout") break
      if (attempt === 0) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
    }
  }
  const kind = classify(lastError)
  console.warn(`[HostStorage] host ${op} of "${table}" failed (${kind})`, lastError)
  recordFailure(table, kind, op)
  throw lastError instanceof StorageError ? lastError : new StorageError(kind, op, table, { cause: lastError })
}

// ── tables ──────────────────────────────────────────────────────────────────

/**
 * Read all records of a table. A missing table is empty; a table that is
 * stored but is not a JSON array rejects with a `corrupt` StorageError, and
 * is never written over.
 */
export async function readTable<T>(table: string): Promise<T[]> {
  knownTables.add(table)
  const driver = await getDriver()
  const raw = await hostCall("read", table, () => driver.readString(table))
  storedLen.set(table, raw?.length ?? 0)
  if (raw == null || raw === "") {
    recordCleanRead(table)
    return []
  }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (err) {
    recordFailure(table, "corrupt", "read")
    throw new StorageError("corrupt", "read", table, { cause: err })
  }
  if (data == null) {
    recordCleanRead(table)
    return []
  }
  if (!Array.isArray(data)) {
    recordFailure(table, "corrupt", "read")
    throw new StorageError("corrupt", "read", table)
  }
  recordCleanRead(table)
  return data as T[]
}

async function writeRaw<T>(table: string, records: T[]): Promise<void> {
  const driver = await getDriver()
  const json = JSON.stringify(records)
  try {
    await hostCall("write", table, () => driver.writeString(table, json))
    storedLen.set(table, json.length)
  } catch (err) {
    if (err instanceof StorageError && err.kind === "full") {
      // What a probe must find room for before calling this table writable.
      neededRoom.set(table, Math.max(0, json.length - (storedLen.get(table) ?? 0)) + 1024)
    }
    throw err
  }
}

// One queue per table: a change waits for the one before it to finish.
const locks = new Map<string, Promise<unknown>>()

/**
 * Change a table under its lock: read it, let `change` return the new records
 * (or `null` to leave it as it is), write them back. Changes to one table run
 * one after another, so none overwrites another. `change` must not call
 * `writeTable`/`mutateTable` for the same table — that would wait on itself.
 */
export function mutateTable<T, R = void>(
  table: string,
  change: (records: T[]) => { records: T[] | null; result: R } | Promise<{ records: T[] | null; result: R }>,
): Promise<R> {
  const run = async () => {
    await awaitLingering(table)
    const records = await readTable<T>(table)
    const { records: next, result } = await change(records)
    if (next) {
      await writeRaw(table, next)
      notifyChange(table)
    }
    return result
  }
  const previous = locks.get(table) ?? Promise.resolve()
  const current = previous.then(run, run)
  const settled = current.catch(() => undefined)
  locks.set(table, settled)
  void settled.then(() => {
    if (locks.get(table) === settled) locks.delete(table)
  })
  return current
}

/** Replace a table's records (under its lock). */
export async function writeTable<T>(table: string, records: T[]): Promise<void> {
  await mutateTable<T>(table, () => ({ records, result: undefined }))
}

/** The next id for a table: one above the highest stored. */
function nextIdIn(records: Array<{ id?: number }>): number {
  let max = 0
  for (const r of records) if (typeof r.id === "number" && r.id > max) max = r.id
  return max + 1
}

/** Add a record with the next id. */
export function addRecord<T extends { id?: number }>(table: string, record: T): Promise<number> {
  return mutateTable<T, number>(table, (records) => {
    const id = nextIdIn(records)
    return { records: [...records, { ...record, id }], result: id }
  })
}

/** Merge `updates` into the record with `id`. */
export function updateRecord<T extends { id?: number }>(table: string, id: number, updates: Partial<T>): Promise<void> {
  return mutateTable<T>(table, (records) => {
    const idx = records.findIndex((r) => r.id === id)
    if (idx < 0) return { records: null, result: undefined }
    const next = [...records]
    next[idx] = { ...next[idx], ...updates }
    return { records: next, result: undefined }
  })
}

/**
 * Merge into every record that matches: `update` sees each match as it is
 * now (under the lock) and returns the fields to change, or null to skip it.
 * Resolves to how many changed.
 */
export function updateWhere<T>(
  table: string,
  matches: (record: T) => boolean,
  update: (record: T) => Partial<T> | null,
): Promise<number> {
  return mutateTable<T, number>(table, (records) => {
    let changed = 0
    const next = records.map((r) => {
      if (!matches(r)) return r
      const fields = update(r)
      if (!fields) return r
      changed += 1
      return { ...r, ...fields }
    })
    return { records: changed > 0 ? next : null, result: changed }
  })
}

/** Find records matching a field value. */
export async function findByField<T>(table: string, field: keyof T, value: unknown): Promise<T[]> {
  const records = await readTable<T>(table)
  return records.filter((r) => r[field] === value)
}

/** Find the first record matching a field value. */
export async function findFirstByField<T>(table: string, field: keyof T, value: unknown): Promise<T | undefined> {
  const records = await readTable<T>(table)
  return records.find((r) => r[field] === value)
}

/** Remove a table (under its lock). */
export async function clearTable(table: string): Promise<void> {
  const run = async () => {
    await awaitLingering(table)
    const driver = await getDriver()
    await hostCall("clear", table, () => driver.clear(table))
    notifyChange(table)
  }
  const previous = locks.get(table) ?? Promise.resolve()
  const current = previous.then(run, run)
  const settled = current.catch(() => undefined)
  locks.set(table, settled)
  void settled.then(() => {
    if (locks.get(table) === settled) locks.delete(table)
  })
  return current
}
