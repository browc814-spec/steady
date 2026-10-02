import type { BudgetState } from '../types.ts'
import {
  buildBaseline,
  diffState,
  fromWire,
  liveCount,
  materialize,
  mergeFirstSync,
  mergeItems,
  toWire,
  type ItemMap,
  type SyncItem,
} from './items.ts'
import {
  SYNC_KEYS,
  clearPristine,
  isPristine,
  loadConfig,
  loadMeta,
  randomDeviceName,
  saveConfig,
  saveMeta,
  writeBackup,
  type SyncConfig,
  type SyncMeta,
} from './storage.ts'
import { OfflineError, ServerError, fetchTransport, type Transport } from './transport.ts'

export type SyncStatus = 'off' | 'idle' | 'syncing' | 'offline' | 'error' | 'confirm'

export interface SyncSnapshot {
  status: SyncStatus
  configured: boolean
  enabled: boolean
  endpoint: string
  device: string
  lastSyncAt: string | null
  pending: number
  error: string | null
  /** Pre-sync backup created during this session's first sync (localStorage key) */
  backupKey: string | null
  confirm: { localCount: number; remoteCount: number } | null
}

export type StateUpdater = (prev: BudgetState) => BudgetState

export interface ControllerDeps {
  /** Run an updater against the latest React state; resolves once it has run. */
  applyState: (updater: StateUpdater) => Promise<void>
  transport?: Transport
  now?: () => number
  debounceMs?: number
  pollMs?: number
}

function union(a: string[], b: string[]) {
  if (!b.length) return a
  const set = new Set(a)
  for (const x of b) set.add(x)
  return [...set]
}

function toMap(items: SyncItem[]): ItemMap {
  const map: ItemMap = {}
  for (const it of items) map[it.id] = it
  return map
}

function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

export class SyncController {
  private deps: ControllerDeps
  private transport: Transport
  private config: SyncConfig | null
  private meta: SyncMeta | null
  private latest: BudgetState | null = null
  private blocked = false
  private snapshot: SyncSnapshot
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private running: Promise<void> | null = null
  private again = false
  private pendingRemote: { items: SyncItem[]; rev: number } | null = null
  private detach: (() => void) | null = null

  constructor(deps: ControllerDeps) {
    this.deps = deps
    this.transport = deps.transport ?? fetchTransport
    this.config = loadConfig()
    this.meta = loadMeta()
    if (this.meta && (!this.config || this.meta.endpoint !== this.config.endpoint)) {
      this.meta = null
      saveMeta(null)
    }
    this.snapshot = this.compute({ status: 'off', error: null, backupKey: null, confirm: null })
  }

  // ------------------------------------------------------------------ external store API
  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getSnapshot = () => this.snapshot

  private compute(patch: Partial<SyncSnapshot>): SyncSnapshot {
    const base = this.snapshot ?? ({} as SyncSnapshot)
    const next: SyncSnapshot = {
      ...base,
      ...patch,
      configured: !!this.config,
      enabled: this.enabled,
      endpoint: this.config?.endpoint ?? '',
      device: this.config?.device ?? '',
      lastSyncAt: this.meta?.lastSyncAt ?? null,
      pending: this.meta?.dirty.length ?? 0,
    }
    if (!this.enabled && next.status !== 'confirm') next.status = 'off'
    return next
  }

  private emit(patch: Partial<SyncSnapshot> = {}) {
    this.snapshot = this.compute(patch)
    for (const fn of this.listeners) fn()
  }

  get enabled() {
    return !!this.config && this.config.enabled && !!this.config.endpoint && !!this.config.token && !this.blocked
  }

  private get now() {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private persistMeta() {
    if (this.meta && !saveMeta(this.meta)) {
      this.emit({ status: 'error', error: 'Browser storage is full; sync data could not be saved.' })
    }
  }

  // ------------------------------------------------------------------ lifecycle
  setBlocked(blocked: boolean) {
    this.blocked = blocked
    this.emit()
  }

  /** Attach focus/visibility/online listeners and do an initial sync. Idempotent. */
  start() {
    if (this.detach) return
    if (typeof window !== 'undefined') {
      const onFocus = () => void this.syncNow()
      const onVisibility = () => void this.syncNow()
      window.addEventListener('focus', onFocus)
      window.addEventListener('online', onFocus)
      document.addEventListener('visibilitychange', onVisibility)
      const offline = () => this.emit({ status: this.enabled ? 'offline' : 'off' })
      window.addEventListener('offline', offline)
      this.poll = setInterval(() => {
        if (typeof document === 'undefined' || document.visibilityState === 'visible') void this.syncNow()
      }, this.deps.pollMs ?? 120000)
      this.detach = () => {
        window.removeEventListener('focus', onFocus)
        window.removeEventListener('online', onFocus)
        window.removeEventListener('offline', offline)
        document.removeEventListener('visibilitychange', onVisibility)
      }
    } else {
      this.detach = () => {}
    }
    void this.syncNow()
  }

  stop() {
    this.detach?.()
    this.detach = null
    if (this.poll) clearInterval(this.poll)
    if (this.timer) clearTimeout(this.timer)
    this.poll = null
    this.timer = null
  }

  /** Another tab changed localStorage: re-read config + meta. */
  reloadFromStorage() {
    this.config = loadConfig()
    this.meta = loadMeta()
    if (this.meta && this.config && this.meta.endpoint !== this.config.endpoint) this.meta = null
    this.emit()
  }

  // ------------------------------------------------------------------ configuration
  connect(endpoint: string, token: string, device?: string) {
    const url = endpoint.trim()
    const changed = !this.config || this.config.endpoint !== url
    this.config = {
      endpoint: url,
      token: token.trim(),
      device: (device ?? this.config?.device ?? '').trim() || randomDeviceName(),
      enabled: true,
    }
    saveConfig(this.config)
    if (changed || !this.meta) {
      this.meta = null
      saveMeta(null)
    }
    this.pendingRemote = null
    this.emit({ status: 'idle', error: null, confirm: null })
    return this.syncNow()
  }

  setDevice(device: string) {
    if (!this.config) return
    this.config = { ...this.config, device: device.trim() || this.config.device }
    saveConfig(this.config)
    this.emit()
  }

  /** Forget endpoint, token and sync bookkeeping (local budget data stays). */
  disconnect() {
    this.config = null
    this.meta = null
    this.pendingRemote = null
    saveConfig(null)
    saveMeta(null)
    if (this.timer) clearTimeout(this.timer)
    this.emit({ status: 'off', error: null, confirm: null })
  }

  // ------------------------------------------------------------------ local changes
  /** Record the committed state (called from the single save path). Idempotent. */
  absorb(state: BudgetState) {
    this.latest = state
    if (!this.enabled || !this.meta) return
    const { items, changed } = diffState(this.meta.items, state, this.config!.device, this.now)
    if (!changed.length) return
    this.meta = { ...this.meta, items, dirty: union(this.meta.dirty, changed) }
    this.persistMeta()
    this.emit()
    if (this.meta.firstSyncDone) this.schedulePush()
  }

  private schedulePush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.syncNow()
    }, this.deps.debounceMs ?? 1500)
  }

  private ensureMeta() {
    if (this.meta || !this.config || !this.latest) return
    this.meta = {
      version: 1,
      endpoint: this.config.endpoint,
      items: buildBaseline(this.latest, this.config.device, this.now),
      rev: null,
      dirty: [],
      firstSyncDone: false,
      lastSyncAt: null,
    }
    this.persistMeta()
  }

  // ------------------------------------------------------------------ sync cycle
  syncNow(): Promise<void> {
    if (!this.enabled) return Promise.resolve()
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.again = false
        await this.cycle()
      } while (this.again && this.enabled && this.snapshot.status !== 'confirm')
    })().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async cycle() {
    this.ensureMeta()
    if (!this.meta || this.snapshot.status === 'confirm') return
    if (!isOnline()) {
      this.emit({ status: 'offline' })
      return
    }
    this.emit({ status: 'syncing' })
    try {
      if (!this.meta.firstSyncDone) {
        const done = await this.firstSync()
        if (!done) return
      } else if (this.meta.dirty.length) {
        await this.push()
      } else {
        await this.pull()
      }
      if (this.meta) {
        this.meta = { ...this.meta, lastSyncAt: new Date(this.now).toISOString() }
        this.persistMeta()
      }
      this.emit({ status: this.enabled ? 'idle' : 'off', error: null })
    } catch (e) {
      if (e instanceof OfflineError) this.emit({ status: 'offline' })
      else if (e instanceof ServerError && e.code === 'unauthorized')
        this.emit({ status: 'error', error: 'Token rejected by the sync endpoint.' })
      else this.emit({ status: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  }

  private base() {
    return { token: this.config!.token, device: this.config!.device }
  }

  private async pull() {
    const res = await this.transport(this.config!.endpoint, {
      ...this.base(),
      action: 'pull',
      sinceRev: this.meta!.rev,
    })
    if (res.items) await this.applyRemote(this.parse(res.items), res.rev, [])
    else this.setRev(res.rev)
    if (this.meta && this.meta.dirty.length) await this.push()
  }

  private async push() {
    const meta = this.meta!
    const sent = meta.dirty.map((id) => meta.items[id]).filter(Boolean)
    const stamps = new Map(sent.map((it) => [it.id, it.updatedAt]))
    const res = await this.transport(this.config!.endpoint, {
      ...this.base(),
      action: 'push',
      baseRev: meta.rev,
      items: sent.map(toWire),
    })
    if (!this.meta) return
    // Acknowledge items that did not change locally while the request was in flight.
    const acked = new Set<string>()
    for (const [id, ts] of stamps) if (this.meta.items[id]?.updatedAt === ts) acked.add(id)
    for (const id of meta.dirty) if (!this.meta.items[id]) acked.add(id)
    this.meta = { ...this.meta, dirty: this.meta.dirty.filter((id) => !acked.has(id)) }
    this.persistMeta()
    if (res.items) await this.applyRemote(this.parse(res.items), res.rev, [...stamps.keys()])
    else this.setRev(res.rev)
    if (this.meta && this.meta.dirty.length) this.again = true
  }

  private parse(items: unknown[]): SyncItem[] {
    return items.map((w) => fromWire(w as never)).filter((x): x is SyncItem => !!x)
  }

  private setRev(rev: number) {
    if (!this.meta) return
    this.meta = { ...this.meta, rev }
    this.persistMeta()
  }

  /** Merge remote items with local ones inside a state updater so in-flight edits survive. */
  private applyRemote(remote: SyncItem[], rev: number, justSent: string[]) {
    return this.deps.applyState((prev) => {
      if (!this.meta) return prev
      this.absorb(prev) // flush any edit not yet seen by the save path (idempotent)
      const m = mergeItems(this.meta.items, remote)
      const sentSet = new Set(justSent)
      const took = new Set(m.tookRemote)
      const dirty = union(
        this.meta.dirty.filter((id) => !took.has(id)),
        m.localAhead.filter((id) => !sentSet.has(id)),
      )
      this.meta = { ...this.meta, items: m.items, rev, dirty }
      this.persistMeta()
      if (!m.tookRemote.length) return prev
      const next = materialize(this.meta.items)
      this.latest = next
      return next
    })
  }

  /** Returns false when waiting for the user to confirm a merge. */
  private async firstSync(): Promise<boolean> {
    if (!this.snapshot.backupKey && this.latest) {
      const key = writeBackup(SYNC_KEYS.presyncPrefix, JSON.stringify(this.latest))
      this.emit({ backupKey: key })
    }
    const res = await this.transport(this.config!.endpoint, { ...this.base(), action: 'pull', sinceRev: null })
    const remote = this.parse(res.items ?? [])

    if (liveCount(remote) === 0) {
      // Empty store: upload everything this device has.
      await this.deps.applyState((prev) => {
        if (!this.meta) return prev
        this.absorb(prev)
        const m = mergeItems(this.meta.items, remote)
        this.meta = { ...this.meta, items: m.items, rev: res.rev, dirty: m.localAhead, firstSyncDone: true }
        this.persistMeta()
        return m.tookRemote.length ? materialize(m.items) : prev
      })
      if (this.meta?.dirty.length) await this.push()
      return true
    }

    if (this.latest && isPristine(this.latest)) {
      // Untouched demo data: adopt the synced copy, discard the demo.
      this.adoptRemote(remote, res.rev)
      await this.deps.applyState(() => materialize(this.meta!.items))
      return true
    }

    this.pendingRemote = { items: remote, rev: res.rev }
    this.emit({
      status: 'confirm',
      confirm: { localCount: liveCount(this.meta!.items), remoteCount: liveCount(remote) },
    })
    return false
  }

  private adoptRemote(remote: SyncItem[], rev: number) {
    this.meta = { ...this.meta!, items: toMap(remote), rev, dirty: [], firstSyncDone: true }
    this.persistMeta()
    clearPristine()
    this.latest = materialize(this.meta.items)
  }

  /** User decision for the first sync when both this device and the store have data. */
  async resolveFirstSync(choice: 'merge' | 'remote' | 'cancel') {
    const pending = this.pendingRemote
    this.pendingRemote = null
    if (choice === 'cancel' || !pending || !this.meta) {
      if (this.config) {
        this.config = { ...this.config, enabled: false }
        saveConfig(this.config)
      }
      this.meta = null
      saveMeta(null)
      this.emit({ status: 'off', confirm: null })
      return
    }
    if (choice === 'remote') {
      this.adoptRemote(pending.items, pending.rev)
      await this.deps.applyState(() => materialize(this.meta!.items))
    } else {
      await this.deps.applyState((prev) => {
        if (!this.meta) return prev
        this.absorb(prev)
        const m = mergeFirstSync(this.meta.items, pending.items)
        this.meta = { ...this.meta, items: m.items, rev: pending.rev, dirty: m.localAhead, firstSyncDone: true }
        this.persistMeta()
        clearPristine()
        const next = materialize(m.items)
        this.latest = next
        return next
      })
    }
    this.emit({ status: 'idle', confirm: null })
    await this.syncNow()
  }

  /** Re-enable after a cancelled first sync. */
  enable() {
    if (!this.config) return
    this.config = { ...this.config, enabled: true }
    saveConfig(this.config)
    this.emit({ status: 'idle', error: null })
    void this.syncNow()
  }

  /** Items currently tracked (for tests / diagnostics). */
  debugMeta() {
    return this.meta
  }
}
