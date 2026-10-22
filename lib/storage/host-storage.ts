/**
 * Host API Local Storage adapter
 *
 * Uses hostLocalStorage from product-sdk when running inside Polkadot Desktop.
 * Falls back to in-memory storage (cleared on refresh) when outside host.
 * Each "table" is stored as a single JSON key.
 */

"use client"

import { isInHost } from "@/lib/host/detect"

// Event system for reactivity (replaces Dexie's useLiveQuery)
const storageEvents = new EventTarget()

export function onStorageChange(table: string, callback: () => void): () => void {
  const handler = () => callback()
  storageEvents.addEventListener(`change:${table}`, handler)
  return () => storageEvents.removeEventListener(`change:${table}`, handler)
}

function notifyChange(table: string) {
  storageEvents.dispatchEvent(new Event(`change:${table}`))
}

// Lazy-loaded hostLocalStorage (only available in host)
type StorageDriver = {
  readJSON: (key: string) => Promise<any>
  writeJSON: (key: string, value: unknown) => Promise<undefined>
  clear: (key: string) => Promise<undefined>
}
let _hostStorage: StorageDriver | null = null
let _hostFailed = false

// In-memory fallback for non-host environments AND for in-host sessions
// where the host bridge throws (e.g. autoconnect failed). Once a host
// write/read throws we switch to memory for the rest of the session
// rather than keep failing every operation.
const memoryStore: Record<string, any> = {}

const memoryDriver: StorageDriver = {
  readJSON: async (key: string) => memoryStore[key] ?? null,
  writeJSON: async (key: string, value: unknown) => {
    memoryStore[key] = value
    return undefined
  },
  clear: async (key: string) => {
    delete memoryStore[key]
    return undefined
  },
}

async function getStorage(): Promise<StorageDriver> {
  if (_hostFailed) return memoryDriver
  if (_hostStorage) return _hostStorage

  if (isInHost()) {
    try {
      // Two clients, one store. The codec-2 SDK exposes the same
      // read/write/clear shape, so only the import differs — but it has to be
      // chosen, not both loaded (see lib/host/runtime-init.ts).
      const hostLocalStorage = await (async () => {
        const { isTruApiRuntime } = await import("@/lib/host/detect")
        if (isTruApiRuntime()) {
          const { loadHostSdk } = await import("@/lib/host/sdk")
          const store = await (await loadHostSdk()).getHostLocalStorage()
          if (!store) throw new Error("host localStorage unavailable on the TrUAPI runtime")
          return store
        }
        return (await import("@novasamatech/host-api-wrapper")).hostLocalStorage
      })()
      // Wrap host driver so a runtime error (StorageErr::Unknown when the
      // host bridge is unhealthy) demotes us to memory instead of throwing
      // on every subsequent call.
      _hostStorage = {
        readJSON: async (key) => {
          try {
            return await hostLocalStorage.readJSON(key)
          } catch (err) {
            // Missing keys come back as `""` from the host bridge and the
            // SDK's JSON.parse blows up with `SyntaxError: Unexpected end
            // of JSON input`. That's not a real failure — every fresh
            // install hits it for every table on first read. Treat it as
            // "no data" without demoting the entire session.
            if (err instanceof SyntaxError) return null
            demoteToMemory("readJSON", err)
            return memoryDriver.readJSON(key)
          }
        },
        writeJSON: async (key, value) => {
          try {
            await hostLocalStorage.writeJSON(key, value)
            return undefined
          } catch (err) {
            demoteToMemory("writeJSON", err)
            return memoryDriver.writeJSON(key, value)
          }
        },
        clear: async (key) => {
          try {
            await hostLocalStorage.clear(key)
            return undefined
          } catch (err) {
            demoteToMemory("clear", err)
            return memoryDriver.clear(key)
          }
        },
      }
      console.log("[HostStorage] Using host API localStorage")
      return _hostStorage as StorageDriver
    } catch {
      console.warn("[HostStorage] Failed to load hostLocalStorage, using memory fallback")
    }
  }

  _hostStorage = memoryDriver
  console.log("[HostStorage] Using in-memory fallback (not in host)")
  return _hostStorage
}

function demoteToMemory(op: string, err: unknown): void {
  if (_hostFailed) return
  _hostFailed = true
  _hostStorage = memoryDriver
  console.warn(
    `[HostStorage] host ${op} failed — switching to in-memory store for the rest of the session.`,
    err,
  )
}

// Auto-increment ID counter per table
const idCounters: Record<string, number> = {}

function nextId(table: string): number {
  if (!idCounters[table]) idCounters[table] = 0
  return ++idCounters[table]
}

/**
 * Read all records from a table
 */
export async function readTable<T>(table: string): Promise<T[]> {
  const storage = await getStorage()
  let data: any
  try {
    data = await storage.readJSON(table)
  } catch {
    // readJSON throws on empty/invalid data
    data = null
  }
  const records = Array.isArray(data) ? (data as T[]) : []

  // Track max ID for auto-increment
  if (records.length > 0) {
    const maxId = Math.max(...records.map((r: any) => r.id || 0))
    if (maxId > (idCounters[table] || 0)) {
      idCounters[table] = maxId
    }
  }

  return records
}

/**
 * Write all records to a table
 */
export async function writeTable<T>(table: string, records: T[]): Promise<void> {
  const storage = await getStorage()
  await storage.writeJSON(table, records)
  notifyChange(table)
}

/**
 * Add a record to a table (with auto-increment ID)
 */
export async function addRecord<T extends { id?: number }>(table: string, record: T): Promise<number> {
  const records = await readTable<T>(table)
  const id = nextId(table)
  records.push({ ...record, id })
  await writeTable(table, records)
  return id
}

/**
 * Update a record by ID
 */
export async function updateRecord<T extends { id?: number }>(
  table: string,
  id: number,
  updates: Partial<T>
): Promise<void> {
  const records = await readTable<T>(table)
  const idx = records.findIndex((r) => r.id === id)
  if (idx >= 0) {
    records[idx] = { ...records[idx], ...updates }
    await writeTable(table, records)
  }
}

/**
 * Find records matching a field value
 */
export async function findByField<T>(table: string, field: keyof T, value: any): Promise<T[]> {
  const records = await readTable<T>(table)
  return records.filter((r) => r[field] === value)
}

/**
 * Find first record matching a field value
 */
export async function findFirstByField<T>(table: string, field: keyof T, value: any): Promise<T | undefined> {
  const records = await readTable<T>(table)
  return records.find((r) => r[field] === value)
}

/**
 * Clear all records from a table
 */
export async function clearTable(table: string): Promise<void> {
  const storage = await getStorage()
  await storage.clear(table)
  notifyChange(table)
}
