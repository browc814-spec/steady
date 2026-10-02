import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain JS test helper
import { createGasEnv } from '../../sync/test/gas-shim.mjs'
import { applyCashTransaction, archivePaycheckPeriod, createDefaultState, createId, STORAGE_KEY } from '../../src/math.ts'
import type { BudgetState } from '../../src/types.ts'
import { SyncController, type StateUpdater } from '../../src/sync/controller.ts'
import { flattenState, stableStringify } from '../../src/sync/items.ts'
import { markPristine, SYNC_KEYS } from '../../src/sync/storage.ts'
import { OfflineError, ServerError, type Transport } from '../../src/sync/transport.ts'

const TOKEN = 'test-token-0123456789abcdef0123456789'
const URL = 'https://example.invalid/exec'

class MemoryStorage {
  map = new Map<string, string>()
  get length() { return this.map.size }
  key(i: number) { return [...this.map.keys()][i] ?? null }
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null }
  setItem(k: string, v: string) { this.map.set(k, String(v)) }
  removeItem(k: string) { this.map.delete(k) }
  clear() { this.map.clear() }
}

type Env = ReturnType<typeof createGasEnv>

function canon(state: BudgetState) {
  return stableStringify(flattenState(state).map((f) => [f.id, f.kind, f.parentId, f.data]).sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)))
}

/** One simulated browser: own localStorage, own React-like state, own controller. */
class Device {
  storage = new MemoryStorage()
  state: BudgetState
  ctrl!: SyncController
  offline = false
  /** Hook to run while a request is in flight */
  duringRequest: (() => void) | null = null

  constructor(public name: string, env: Env, initial: BudgetState, opts: { pristine?: boolean } = {}) {
    this.state = initial
    this.use(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(initial))
      if (opts.pristine) markPristine(initial)
      const transport: Transport = async (_url, payload) => {
        if (this.offline) throw new OfflineError('offline')
        const hook = this.duringRequest
        this.duringRequest = null
        const res = env.post(JSON.parse(JSON.stringify(payload)))
        if (hook) hook()
        this.use(() => {})
        if (!res.ok) throw new ServerError(res.error, res.message)
        return res
      }
      this.ctrl = new SyncController({
        transport,
        debounceMs: 1e9,
        pollMs: 1e9,
        applyState: async (updater: StateUpdater) => {
          this.use(() => {
            this.state = updater(this.state)
            this.ctrl.absorb(this.state) // the save effect
          })
        },
      })
      this.ctrl.absorb(this.state)
    })
  }

  use<T>(fn: () => T): T {
    ;(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = this.storage
    return fn()
  }

  edit(fn: (s: BudgetState) => BudgetState | void) {
    this.use(() => {
      const draft = structuredClone(this.state)
      this.state = fn(draft) ?? draft
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state))
      this.ctrl.absorb(this.state)
    })
  }

  async connect() {
    this.use(() => {})
    await this.ctrl.connect(URL, TOKEN, this.name)
  }

  async sync() {
    this.use(() => {})
    await this.ctrl.syncNow()
  }

  snap() { return this.ctrl.getSnapshot() }
}

function customState(): BudgetState {
  const s = createDefaultState()
  s.paychecks.p1.paycheck = 2100
  s.paychecks.p1.spending = [{ id: 'real-1', date: '2026-09-28', categoryId: s.paychecks.p1.mutable[0].id, amount: 61.2, merchant: 'Safeway', note: 'fake test data' }]
  s.goals = [{ id: 'goal-car', name: 'Car fund', target: 3000, deposits: [{ id: 'dep-0', date: '2026-09-01', amount: 100, note: '' }] }]
  s.cashBox = { balance: 40, history: [{ id: 'cash-0', date: '2026-09-01', type: 'set', amount: 40, note: '', balanceAfter: 40 }] }
  return s
}

async function settle(...devices: Device[]) {
  for (let i = 0; i < 2; i++) for (const d of devices) await d.sync()
}

describe('SyncController end-to-end against Code.gs', () => {
  it('first sync: upload, pristine adopt, confirm-merge, offline edits, inbox, in-flight edits', async () => {
    const env = createGasEnv({ token: TOKEN })

    // --- Device A has existing data → remote empty → upload
    const A = new Device('phone', env, customState())
    await A.connect()
    expect(A.snap().status).toBe('idle')
    expect(A.use(() => [...A.storage.map.keys()].some((k) => k.startsWith(SYNC_KEYS.presyncPrefix)))).toBe(true)
    const remoteRows = env.table('Items')
    expect(remoteRows.length).toBe(flattenState(A.state).length)
    expect(remoteRows.some((r: { json: string }) => r.json.includes('Safeway'))).toBe(true)

    // --- Device B is the untouched demo → adopts remote, demo never uploaded
    const B = new Device('laptop', env, createDefaultState(), { pristine: true })
    await B.connect()
    expect(B.snap().status).toBe('idle')
    expect(canon(B.state)).toBe(canon(A.state))
    expect(env.table('Items').some((r: { json: string }) => r.json.includes('DoorDash'))).toBe(false)

    // --- Offline edits on both, then converge
    A.offline = true
    const goal = 'goal-car'
    A.edit((s) => { s.paychecks.p1.spending.unshift({ id: 'a-spend', date: '2026-10-02', categoryId: s.paychecks.p1.mutable[0].id, amount: 12, merchant: 'A shop', note: '' }) })
    A.edit((s) => { s.goals[0].deposits.unshift({ id: 'a-dep', date: '2026-10-02', amount: 25, note: 'A' }) })
    A.edit((s) => ({ ...s, cashBox: applyCashTransaction(s.cashBox, 'add', 20, 'atm', '2026-10-02') }))
    await A.sync()
    expect(A.snap().status).toBe('offline')
    expect(A.snap().pending).toBe(3)

    B.edit((s) => { s.goals.find((g) => g.id === goal)!.deposits.unshift({ id: 'b-dep', date: '2026-10-02', amount: 50, note: 'B' }) })
    B.edit((s) => { s.paychecks.p1.spending = s.paychecks.p1.spending.filter((x) => x.id !== 'real-1') })
    B.edit((s) => ({ ...s, cashBox: applyCashTransaction(s.cashBox, 'spend', 5, 'coffee', '2026-10-02') }))
    await B.sync()

    A.offline = false
    await settle(A, B)
    expect(canon(A.state)).toBe(canon(B.state))
    const deps = A.state.goals.find((g) => g.id === goal)!.deposits.map((d) => d.id).sort()
    expect(deps).toEqual(['a-dep', 'b-dep', 'dep-0'])
    expect(A.state.paychecks.p1.spending.map((s) => s.id)).toEqual(['a-spend'])
    expect(A.state.cashBox.balance).toBe(55)
    expect(B.state.cashBox.balance).toBe(55)
    expect(A.snap().pending).toBe(0)

    // --- Archive on A shows up on B
    A.edit((s) => archivePaycheckPeriod(s, 'p1', 'Oct 2026 · 1st half', '2026-10-02'))
    await settle(A, B)
    expect(B.state.history).toHaveLength(1)
    expect(B.state.paychecks.p1.spending).toHaveLength(0)

    // --- Device C has its own (non-demo) data → confirm → merge
    const cState = createDefaultState()
    cState.paychecks.p2.spending = [{ id: 'c-only', date: '2026-09-15', categoryId: cState.paychecks.p2.mutable[0].id, amount: 7, merchant: 'C store', note: '' }]
    const C = new Device('tablet', env, cState)
    await C.connect()
    expect(C.snap().status).toBe('confirm')
    expect(C.snap().confirm!.remoteCount).toBeGreaterThan(0)
    C.use(() => {})
    await C.ctrl.resolveFirstSync('merge')
    await settle(C, A, B)
    expect(A.state.paychecks.p2.spending.some((s) => s.id === 'c-only')).toBe(true)
    expect(canon(A.state)).toBe(canon(C.state))
    expect(canon(B.state)).toBe(canon(C.state))
    // Remote won on shared ids (e.g. p1.paycheck from A, not C's demo 1600)
    expect(C.state.paychecks.p1.paycheck).toBe(2100)

    // --- Agent appends to Inbox → appears on next pull
    const catId = A.state.paychecks.p1.mutable[0].id
    env.sheet('Inbox').externalAppend([[createId(), 'spend', 'p1', 'upsert', JSON.stringify({ date: '2026-10-02', categoryId: catId, amount: 4.5, merchant: 'Tammy test' }), '', 'tammy', '']])
    await A.sync()
    expect(A.state.paychecks.p1.spending.some((s) => s.merchant === 'Tammy test')).toBe(true)

    // --- An edit made while a push is in flight is not lost
    A.edit((s) => { s.paychecks.p2.paycheck = 1111 })
    A.duringRequest = () => A.edit((s) => { s.paychecks.p2.savings = 222 })
    await A.sync()
    expect(A.state.paychecks.p2.savings).toBe(222)
    // The follow-up loop pushed the in-flight edit too
    expect(A.snap().pending).toBe(0)
    expect(env.table('Items').find((r: { id: string }) => r.id === 'p2.savings').json).toContain('222')
    await settle(A, B)
    expect(B.state.paychecks.p2.paycheck).toBe(1111)
    expect(B.state.paychecks.p2.savings).toBe(222)
    expect(canon(A.state)).toBe(canon(B.state))
  })

  it('wrong token surfaces an error and keeps changes queued', async () => {
    const env = createGasEnv({ token: TOKEN })
    const A = new Device('phone', env, customState())
    A.use(() => {})
    await A.ctrl.connect(URL, 'x'.repeat(36), 'phone')
    expect(A.snap().status).toBe('error')
    expect(A.snap().error).toMatch(/Token rejected/)
  })

  it('cancelled first sync turns sync off without touching data', async () => {
    const env = createGasEnv({ token: TOKEN })
    const A = new Device('phone', env, customState())
    await A.connect()
    const C = new Device('tablet', env, customState())
    C.edit((s) => { s.paychecks.p1.paycheck = 5 })
    const before = JSON.stringify(C.state)
    await C.connect()
    expect(C.snap().status).toBe('confirm')
    C.use(() => {})
    await C.ctrl.resolveFirstSync('cancel')
    expect(C.snap().status).toBe('off')
    expect(JSON.stringify(C.state)).toBe(before)
  })
})
