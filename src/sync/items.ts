/**
 * Item-level representation of BudgetState for syncing.
 *
 * The React app keeps working with the nested BudgetState. For sync, the state is flattened
 * into independent items keyed by a stable id. Every item carries updatedAt / deleted
 * (tombstone) / updatedBy so two devices can merge per item with last-write-wins.
 *
 * Kinds and parentId rules (must match sync/apps-script/Code.gs and the Inbox contract):
 *   paycheckField  id "p1.label" | "p1.paycheck" | "p1.savings" (same for p2)  parent "p1"|"p2"  data {value}
 *   bill           uuid  parent "p1"|"p2"  data {name, amount}
 *   category       uuid  parent "p1"|"p2"  data {name, percent}
 *   spend          uuid  parent "p1"|"p2"  data {date, categoryId, amount, merchant, note}
 *   goal           uuid  parent ""         data {name, target}
 *   deposit        uuid  parent goal id    data {date, amount, note}
 *   cashTx         uuid  parent ""         data {date, type, amount, note}   (balance is derived)
 *   archive        uuid  parent ""         data {paycheckKey, label, periodLabel, archivedAt, budget}
 */
import type {
  ArchivedPaycheck,
  BudgetState,
  CashBox,
  CashTransaction,
  CashTxType,
  GoalDeposit,
  ImmutableItem,
  MutableCategory,
  PaycheckBudget,
  PaycheckKey,
  SavingsGoal,
  SpendEntry,
} from '../types.ts'

export type ItemKind =
  | 'paycheckField'
  | 'bill'
  | 'category'
  | 'spend'
  | 'goal'
  | 'deposit'
  | 'cashTx'
  | 'archive'

export const ITEM_KINDS: ItemKind[] = [
  'paycheckField',
  'bill',
  'category',
  'spend',
  'goal',
  'deposit',
  'cashTx',
  'archive',
]

export type ItemData = Record<string, unknown>

/** One synced record. Mirrors a row of the Items sheet (json = {...data, createdAt}). */
export interface SyncItem {
  id: string
  kind: ItemKind
  parentId: string
  /** ISO timestamp of last change (LWW clock) */
  updatedAt: string
  deleted: boolean
  updatedBy: string
  /** ISO timestamp used for stable ordering (ties within the same date) */
  createdAt: string
  data: ItemData
}

export type ItemMap = Record<string, SyncItem>

/** Updates "older than anything": used for items that existed before sync was introduced. */
export const BASELINE_TIME = '1970-01-01T00:00:00.000Z'

const PAYCHECK_KEYS: PaycheckKey[] = ['p1', 'p2']
const PAYCHECK_FIELDS = ['label', 'paycheck', 'savings'] as const

/** Lists that the UI prepends to (newest first). Others are appended (oldest first). */
const PREPEND_KINDS = new Set<ItemKind>(['spend', 'deposit', 'cashTx', 'archive'])

function round2(n: number) {
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) / 100
}

function num(v: unknown, fallback = 0) {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function str(v: unknown, fallback = '') {
  return typeof v === 'string' ? v : v == null ? fallback : String(v)
}

/** Deterministic JSON (sorted keys) for equality checks. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

/** A flattened item before timestamps are attached. */
export interface FlatItem {
  id: string
  kind: ItemKind
  parentId: string
  data: ItemData
  /** index within its list, used to derive createdAt for brand new items */
  index: number
  listSize: number
}

function pushList<T>(
  out: FlatItem[],
  list: T[],
  kind: ItemKind,
  parentId: string,
  toData: (x: T) => ItemData,
  getId: (x: T) => string,
) {
  list.forEach((x, index) => {
    out.push({ id: getId(x), kind, parentId, data: toData(x), index, listSize: list.length })
  })
}

export function billData(b: ImmutableItem): ItemData {
  return { name: str(b.name), amount: round2(num(b.amount)) }
}
export function categoryData(c: MutableCategory): ItemData {
  return { name: str(c.name), percent: num(c.percent) }
}
export function spendData(s: SpendEntry): ItemData {
  return {
    date: str(s.date),
    categoryId: str(s.categoryId),
    amount: round2(num(s.amount)),
    merchant: str(s.merchant),
    note: str(s.note),
  }
}
export function goalData(g: SavingsGoal): ItemData {
  return { name: str(g.name), target: round2(num(g.target)) }
}
export function depositData(d: GoalDeposit): ItemData {
  return { date: str(d.date), amount: round2(num(d.amount)), note: str(d.note) }
}
export function cashTxData(t: CashTransaction): ItemData {
  return { date: str(t.date), type: t.type, amount: round2(Math.abs(num(t.amount))), note: str(t.note) }
}
export function archiveData(a: ArchivedPaycheck): ItemData {
  return {
    paycheckKey: a.paycheckKey,
    label: str(a.label),
    periodLabel: str(a.periodLabel),
    archivedAt: str(a.archivedAt),
    budget: normalizeBudget(a.budget, a.paycheckKey === 'p2' ? 'Paycheck 2' : 'Paycheck 1'),
  }
}

/** Flatten nested state into items (no timestamps). Ids are unique across the whole state. */
export function flattenState(state: BudgetState): FlatItem[] {
  const out: FlatItem[] = []
  for (const key of PAYCHECK_KEYS) {
    const pc = state.paychecks[key]
    PAYCHECK_FIELDS.forEach((field, index) => {
      out.push({
        id: `${key}.${field}`,
        kind: 'paycheckField',
        parentId: key,
        data: { value: field === 'label' ? str(pc.label) : round2(num(pc[field])) },
        index,
        listSize: PAYCHECK_FIELDS.length,
      })
    })
    pushList(out, pc.immutable, 'bill', key, billData, (b) => b.id)
    pushList(out, pc.mutable, 'category', key, categoryData, (c) => c.id)
    pushList(out, pc.spending, 'spend', key, spendData, (s) => s.id)
  }
  pushList(out, state.goals, 'goal', '', goalData, (g) => g.id)
  for (const g of state.goals) {
    pushList(out, g.deposits, 'deposit', g.id, depositData, (d) => d.id)
  }
  pushList(out, state.cashBox.history, 'cashTx', '', cashTxData, (t) => t.id)
  pushList(out, state.history, 'archive', '', archiveData, (a) => a.id)

  // Guard against accidental duplicate ids (keep the first occurrence).
  const seen = new Set<string>()
  return out.filter((it) => {
    if (seen.has(it.id)) return false
    seen.add(it.id)
    return true
  })
}

function iso(ms: number) {
  return new Date(ms).toISOString()
}

/** createdAt for an item that is new in this diff, preserving its list position. */
function createdFor(flat: FlatItem, nowMs: number) {
  return PREPEND_KINDS.has(flat.kind)
    ? iso(nowMs - flat.index) // index 0 is the newest
    : iso(nowMs - (flat.listSize - flat.index)) // last index is the newest
}

/**
 * Build the initial item map for data that existed before sync. Items get BASELINE_TIME as
 * updatedAt so that, when merged with an existing remote store, the remote copy wins on any
 * id collision while items unique to this device are still kept.
 */
export function buildBaseline(state: BudgetState, device: string, nowMs = Date.now()): ItemMap {
  const map: ItemMap = {}
  for (const flat of flattenState(state)) {
    map[flat.id] = {
      id: flat.id,
      kind: flat.kind,
      parentId: flat.parentId,
      updatedAt: BASELINE_TIME,
      deleted: false,
      updatedBy: device,
      createdAt: createdFor(flat, nowMs),
      data: flat.data,
    }
  }
  return map
}

export interface DiffResult {
  items: ItemMap
  changed: string[]
}

/**
 * Compare the current state with the item map. New/changed items get updatedAt = now; items
 * missing from the state become tombstones. Pure: returns a new map, never mutates `items`.
 */
export function diffState(
  items: ItemMap,
  state: BudgetState,
  device: string,
  nowMs = Date.now(),
): DiffResult {
  const next: ItemMap = { ...items }
  const changed: string[] = []
  const now = iso(nowMs)
  const present = new Set<string>()

  for (const flat of flattenState(state)) {
    present.add(flat.id)
    const prev = items[flat.id]
    if (
      prev &&
      !prev.deleted &&
      prev.kind === flat.kind &&
      prev.parentId === flat.parentId &&
      stableStringify(prev.data) === stableStringify(flat.data)
    ) {
      continue
    }
    next[flat.id] = {
      id: flat.id,
      kind: flat.kind,
      parentId: flat.parentId,
      updatedAt: laterThan(now, prev?.updatedAt),
      deleted: false,
      updatedBy: device,
      createdAt: prev?.createdAt || createdFor(flat, nowMs),
      data: flat.data,
    }
    changed.push(flat.id)
  }

  for (const id of Object.keys(items)) {
    const prev = items[id]
    if (prev.deleted || present.has(id)) continue
    next[id] = {
      ...prev,
      deleted: true,
      updatedAt: laterThan(now, prev.updatedAt),
      updatedBy: device,
    }
    changed.push(id)
  }

  return { items: next, changed }
}

/** Ensure a local edit always beats the version it replaces, even with a skewed clock. */
function laterThan(now: string, prev: string | undefined) {
  if (!prev || now > prev) return now
  return iso(Date.parse(prev) + 1)
}

/** True when a should replace b under last-write-wins. Deterministic on both devices. */
export function wins(a: SyncItem, b: SyncItem): boolean {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt
  if (a.updatedBy !== b.updatedBy) return a.updatedBy > b.updatedBy
  if (a.deleted !== b.deleted) return a.deleted // delete wins exact ties
  return stableStringify(a.data) > stableStringify(b.data)
}

export function sameItem(a: SyncItem | undefined, b: SyncItem | undefined) {
  if (!a || !b) return a === b
  return (
    a.updatedAt === b.updatedAt &&
    a.updatedBy === b.updatedBy &&
    a.deleted === b.deleted &&
    a.kind === b.kind &&
    a.parentId === b.parentId &&
    stableStringify(a.data) === stableStringify(b.data)
  )
}

export interface MergeResult {
  items: ItemMap
  /** ids where the remote version was taken (local view must be refreshed) */
  tookRemote: string[]
  /** ids where local is newer than remote (must be pushed) */
  localAhead: string[]
}

/** Per-item last-write-wins merge. Commutative and idempotent. */
export function mergeItems(local: ItemMap, remote: SyncItem[]): MergeResult {
  const items: ItemMap = { ...local }
  const tookRemote: string[] = []
  const remoteIds = new Set<string>()
  for (const r of remote) {
    if (!r || !r.id) continue
    remoteIds.add(r.id)
    const l = items[r.id]
    if (!l || (!sameItem(l, r) && wins(r, l))) {
      items[r.id] = r
      tookRemote.push(r.id)
    }
  }
  const localAhead: string[] = []
  const remoteById = new Map(remote.map((r) => [r.id, r]))
  for (const id of Object.keys(items)) {
    const r = remoteById.get(id)
    if (!r || !sameItem(items[id], r)) {
      if (!r || wins(items[id], r)) localAhead.push(id)
    }
  }
  return { items, tookRemote, localAhead }
}

function byCreated(a: SyncItem, b: SyncItem) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Newest first: date desc, then createdAt desc. */
function byDateDesc(dateKey: string) {
  return (a: SyncItem, b: SyncItem) => {
    const da = str(a.data[dateKey])
    const db = str(b.data[dateKey])
    if (da !== db) return da < db ? 1 : -1
    return -byCreated(a, b)
  }
}

/**
 * Replay cash transactions oldest → newest and recompute balanceAfter + balance.
 * `history` is newest first (as stored in state).
 */
export function recomputeCash(history: CashTransaction[]): CashBox {
  const chronological = [...history].reverse()
  let balance = 0
  const withBalance = chronological.map((tx) => {
    const amount = round2(Math.abs(num(tx.amount)))
    if (tx.type === 'set') balance = amount
    else if (tx.type === 'add') balance = round2(balance + amount)
    else if (tx.type === 'spend') balance = round2(balance - amount)
    return { ...tx, amount, balanceAfter: balance }
  })
  return { balance, history: withBalance.reverse() }
}

/** Canonical archived budget (same shape both when flattening and materializing). */
export function normalizeBudget(raw: unknown, fallbackLabel: string): PaycheckBudget {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Partial<PaycheckBudget>
  const arr = <T,>(v: unknown) => (Array.isArray(v) ? (v as T[]) : [])
  return {
    label: str(b.label, fallbackLabel),
    paycheck: round2(num(b.paycheck)),
    savings: round2(num(b.savings)),
    immutable: arr<ImmutableItem>(b.immutable).map((x) => ({ id: str(x?.id), ...billData(x) }) as ImmutableItem),
    mutable: arr<MutableCategory>(b.mutable).map((x) => ({ id: str(x?.id), ...categoryData(x) }) as MutableCategory),
    spending: arr<SpendEntry>(b.spending).map((x) => ({ id: str(x?.id), ...spendData(x) }) as SpendEntry),
  }
}

/** Build the nested BudgetState from live (non-deleted) items. Deterministic ordering. */
export function materialize(items: ItemMap): BudgetState {
  const live = Object.values(items).filter((it) => !it.deleted)
  const ofKind = (kind: ItemKind, parentId?: string) =>
    live.filter((it) => it.kind === kind && (parentId === undefined || it.parentId === parentId))

  const paychecks = {} as Record<PaycheckKey, PaycheckBudget>
  for (const key of PAYCHECK_KEYS) {
    const field = (name: string) => items[`${key}.${name}`]
    const label = field('label')
    const paycheck = field('paycheck')
    const savings = field('savings')
    paychecks[key] = {
      label:
        label && !label.deleted ? str(label.data.value) : key === 'p1' ? 'Paycheck 1' : 'Paycheck 2',
      paycheck: paycheck && !paycheck.deleted ? round2(num(paycheck.data.value)) : 0,
      savings: savings && !savings.deleted ? round2(num(savings.data.value)) : 0,
      immutable: ofKind('bill', key)
        .sort(byCreated)
        .map((it) => ({ id: it.id, name: str(it.data.name), amount: round2(num(it.data.amount)) })),
      mutable: ofKind('category', key)
        .sort(byCreated)
        .map((it) => ({ id: it.id, name: str(it.data.name), percent: num(it.data.percent) })),
      spending: ofKind('spend', key)
        .sort(byDateDesc('date'))
        .map((it) => ({
          id: it.id,
          date: str(it.data.date),
          categoryId: str(it.data.categoryId),
          amount: round2(num(it.data.amount)),
          merchant: str(it.data.merchant),
          note: str(it.data.note),
        })),
    }
  }

  const goals: SavingsGoal[] = ofKind('goal')
    .sort(byCreated)
    .map((g) => ({
      id: g.id,
      name: str(g.data.name),
      target: round2(num(g.data.target)),
      deposits: ofKind('deposit', g.id)
        .sort(byDateDesc('date'))
        .map((d) => ({
          id: d.id,
          date: str(d.data.date),
          amount: round2(num(d.data.amount)),
          note: str(d.data.note),
        })),
    }))

  const cashHistory: CashTransaction[] = ofKind('cashTx')
    .sort(byDateDesc('date'))
    .map((t) => ({
      id: t.id,
      date: str(t.data.date),
      type: (['set', 'add', 'spend'].includes(str(t.data.type)) ? t.data.type : 'add') as CashTxType,
      amount: round2(Math.abs(num(t.data.amount))),
      note: str(t.data.note),
      balanceAfter: 0,
    }))

  const history: ArchivedPaycheck[] = ofKind('archive')
    .sort(byDateDesc('archivedAt'))
    .map((a) => {
      const key: PaycheckKey = a.data.paycheckKey === 'p2' ? 'p2' : 'p1'
      const fallback = key === 'p1' ? 'Paycheck 1' : 'Paycheck 2'
      return {
        id: a.id,
        paycheckKey: key,
        label: str(a.data.label, fallback),
        periodLabel: str(a.data.periodLabel),
        archivedAt: str(a.data.archivedAt),
        budget: normalizeBudget(a.data.budget, fallback),
      }
    })

  return { paychecks, goals, cashBox: recomputeCash(cashHistory), history }
}

/** Count of live items (used to detect an empty remote store). */
export function liveCount(items: ItemMap | SyncItem[]) {
  const list = Array.isArray(items) ? items : Object.values(items)
  return list.filter((it) => !it.deleted).length
}

/** Wire format (what the endpoint sends/receives): data includes createdAt. */
export interface WireItem {
  id: string
  kind: string
  parentId: string
  updatedAt: string
  deleted: boolean
  updatedBy: string
  data: ItemData
}

export function toWire(it: SyncItem): WireItem {
  return {
    id: it.id,
    kind: it.kind,
    parentId: it.parentId,
    updatedAt: it.updatedAt,
    deleted: it.deleted,
    updatedBy: it.updatedBy,
    data: { ...it.data, createdAt: it.createdAt },
  }
}

export function fromWire(w: WireItem): SyncItem | null {
  if (!w || typeof w.id !== 'string' || !w.id) return null
  if (!ITEM_KINDS.includes(w.kind as ItemKind)) return null
  const data = { ...(w.data && typeof w.data === 'object' ? w.data : {}) }
  const createdAt = typeof data.createdAt === 'string' && data.createdAt ? data.createdAt : ''
  delete data.createdAt
  const updatedAt = typeof w.updatedAt === 'string' && w.updatedAt ? w.updatedAt : BASELINE_TIME
  return {
    id: w.id,
    kind: w.kind as ItemKind,
    parentId: typeof w.parentId === 'string' ? w.parentId : '',
    updatedAt,
    deleted: w.deleted === true,
    updatedBy: typeof w.updatedBy === 'string' ? w.updatedBy : '',
    createdAt: createdAt || updatedAt,
    data,
  }
}
