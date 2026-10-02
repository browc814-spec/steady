import type { BudgetState } from '../types.ts'
import { flattenState, stableStringify, type ItemMap } from './items.ts'

export const SYNC_KEYS = {
  meta: 'steady-sync-meta-v1',
  config: 'steady-sync-config-v1',
  pristine: 'steady-pristine-demo',
  presyncPrefix: 'steady-budget-presync-',
  corruptPrefix: 'steady-budget-corrupt-',
} as const

export interface SyncConfig {
  endpoint: string
  token: string
  /** Name written to updatedBy (e.g. "phone", "laptop") */
  device: string
  enabled: boolean
}

export interface SyncMeta {
  version: 1
  /** Endpoint this meta belongs to (switching endpoints restarts first sync) */
  endpoint: string
  items: ItemMap
  /** Last server revision seen */
  rev: number | null
  /** Ids changed locally and not yet acknowledged by the server (offline queue) */
  dirty: string[]
  firstSyncDone: boolean
  lastSyncAt: string | null
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export function randomDeviceName() {
  const bytes = new Uint8Array(2)
  crypto.getRandomValues(bytes)
  return `device-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

export function loadConfig(): SyncConfig | null {
  const raw = safeGet(SYNC_KEYS.config)
  if (!raw) return null
  try {
    const c = JSON.parse(raw) as Partial<SyncConfig>
    if (typeof c.endpoint !== 'string' || typeof c.token !== 'string') return null
    return {
      endpoint: c.endpoint,
      token: c.token,
      device: typeof c.device === 'string' && c.device ? c.device : randomDeviceName(),
      enabled: c.enabled !== false,
    }
  } catch {
    return null
  }
}

export function saveConfig(config: SyncConfig | null) {
  if (!config) {
    try {
      localStorage.removeItem(SYNC_KEYS.config)
    } catch {
      /* ignore */
    }
    return
  }
  safeSet(SYNC_KEYS.config, JSON.stringify(config))
}

export function loadMeta(): SyncMeta | null {
  const raw = safeGet(SYNC_KEYS.meta)
  if (!raw) return null
  try {
    const m = JSON.parse(raw) as SyncMeta
    if (!m || m.version !== 1 || typeof m.items !== 'object') return null
    return {
      version: 1,
      endpoint: typeof m.endpoint === 'string' ? m.endpoint : '',
      items: m.items ?? {},
      rev: typeof m.rev === 'number' ? m.rev : null,
      dirty: Array.isArray(m.dirty) ? m.dirty.filter((x) => typeof x === 'string') : [],
      firstSyncDone: m.firstSyncDone === true,
      lastSyncAt: typeof m.lastSyncAt === 'string' ? m.lastSyncAt : null,
    }
  } catch {
    return null
  }
}

export function saveMeta(meta: SyncMeta | null) {
  if (!meta) {
    try {
      localStorage.removeItem(SYNC_KEYS.meta)
    } catch {
      /* ignore */
    }
    return true
  }
  return safeSet(SYNC_KEYS.meta, JSON.stringify(meta))
}

/** FNV-1a hash of the canonical flattened state. */
export function stateSignature(state: BudgetState): string {
  const text = stableStringify(flattenState(state).map((f) => [f.id, f.kind, f.parentId, f.data]))
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${text.length}:${h.toString(16)}`
}

/** Remember that this exact state is the untouched demo. */
export function markPristine(state: BudgetState) {
  safeSet(SYNC_KEYS.pristine, stateSignature(state))
}

export function clearPristine() {
  try {
    localStorage.removeItem(SYNC_KEYS.pristine)
  } catch {
    /* ignore */
  }
}

/** True when the state is still exactly the demo data this device generated. */
export function isPristine(state: BudgetState) {
  const sig = safeGet(SYNC_KEYS.pristine)
  return !!sig && sig === stateSignature(state)
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** Store a backup copy under a timestamped key. Returns the key (or null if storage is full). */
export function writeBackup(prefix: string, raw: string): string | null {
  const key = `${prefix}${stamp()}`
  return safeSet(key, raw) ? key : null
}

export function listBackups(): { key: string; size: number }[] {
  const out: { key: string; size: number }[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key) continue
      if (key.startsWith(SYNC_KEYS.presyncPrefix) || key.startsWith(SYNC_KEYS.corruptPrefix)) {
        out.push({ key, size: (localStorage.getItem(key) ?? '').length })
      }
    }
  } catch {
    /* ignore */
  }
  return out.sort((a, b) => (a.key < b.key ? 1 : -1))
}

export function readKey(key: string) {
  return safeGet(key)
}

export function removeKey(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}
