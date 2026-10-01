import { v4 as uuid } from 'uuid'
import type {
  ArchivedPaycheck,
  BudgetMath,
  BudgetState,
  CashBox,
  CashTransaction,
  CashTxType,
  PaycheckBudget,
  PaycheckKey,
  SpendEntry,
  StatRow,
  YearStats,
} from './types'

export const STORAGE_KEY = 'steady-budget-v5'

export function createId() {
  return uuid()
}

export function money(n: number) {
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) / 100
}

export function formatMoney(n: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(money(n))
}

function normalizeMerchant(value: string) {
  return value.trim().replace(/\s+/g, ' ')
}

function merchantKey(value: string) {
  return normalizeMerchant(value).toLowerCase()
}

function makeMutableTemplate() {
  return [
    { id: createId(), name: 'Groceries', percent: 30 },
    { id: createId(), name: 'Gas', percent: 15 },
    { id: createId(), name: 'Car maintenance', percent: 10 },
    { id: createId(), name: 'Eating out', percent: 15 },
    { id: createId(), name: 'Fun money', percent: 20 },
    { id: createId(), name: 'Misc', percent: 10 },
  ]
}

function makeImmutableTemplate() {
  return [
    { id: createId(), name: 'Rent (half)', amount: 600 },
    { id: createId(), name: 'Utilities (half)', amount: 90 },
    { id: createId(), name: 'Car payment (half)', amount: 175 },
    { id: createId(), name: 'Phone (half)', amount: 40 },
    { id: createId(), name: 'Debt payment (half)', amount: 100 },
  ]
}

function makePaycheck(label: string, paycheck: number, withSampleSpend = false): PaycheckBudget {
  const mutable = makeMutableTemplate()
  const eatingOut = mutable.find((m) => m.name === 'Eating out')!
  const misc = mutable.find((m) => m.name === 'Misc')!
  const groceries = mutable.find((m) => m.name === 'Groceries')!
  const gas = mutable.find((m) => m.name === 'Gas')!
  const year = new Date().getFullYear()

  const spending: SpendEntry[] = withSampleSpend
    ? [
        {
          id: createId(),
          date: `${year}-01-12`,
          categoryId: eatingOut.id,
          amount: 28.4,
          merchant: 'DoorDash',
          note: '',
        },
        {
          id: createId(),
          date: `${year}-02-03`,
          categoryId: misc.id,
          amount: 35,
          merchant: 'Smoke City',
          note: '',
        },
        {
          id: createId(),
          date: `${year}-02-18`,
          categoryId: groceries.id,
          amount: 84.22,
          merchant: 'Costco',
          note: '',
        },
        {
          id: createId(),
          date: `${year}-03-22`,
          categoryId: gas.id,
          amount: 48,
          merchant: 'Shell',
          note: '',
        },
      ]
    : []

  return {
    label,
    paycheck,
    savings: 200,
    immutable: makeImmutableTemplate(),
    mutable,
    spending,
  }
}

export function defaultPeriodLabel(paycheckKey: PaycheckKey, when = new Date()) {
  const month = when.toLocaleString('en-US', { month: 'short' })
  const year = when.getFullYear()
  const half = paycheckKey === 'p1' ? '1st half' : '2nd half'
  return `${month} ${year} · ${half}`
}

function clonePaycheck(budget: PaycheckBudget): PaycheckBudget {
  return structuredClone(budget)
}

/** Snapshot current paycheck into History, keep setup, clear spending for the new period. */
export function archivePaycheckPeriod(
  state: BudgetState,
  paycheckKey: PaycheckKey,
  periodLabel: string,
  archivedAt = new Date().toISOString().slice(0, 10),
): BudgetState {
  const current = state.paychecks[paycheckKey]
  const entry: ArchivedPaycheck = {
    id: createId(),
    paycheckKey,
    label: current.label || (paycheckKey === 'p1' ? 'Paycheck 1' : 'Paycheck 2'),
    periodLabel: periodLabel.trim() || defaultPeriodLabel(paycheckKey),
    archivedAt,
    budget: clonePaycheck(current),
  }

  const nextBudget: PaycheckBudget = {
    ...clonePaycheck(current),
    spending: [],
  }

  return {
    ...state,
    paychecks: {
      ...state.paychecks,
      [paycheckKey]: nextBudget,
    },
    history: [entry, ...state.history],
  }
}

export function createDefaultState(): BudgetState {
  const sanDiego = createId()
  const gta = createId()
  return {
    paychecks: {
      p1: makePaycheck('Paycheck 1', 1600, true),
      p2: makePaycheck('Paycheck 2', 1600, false),
    },
    history: [],
    goals: [
      {
        id: sanDiego,
        name: 'San Diego trip',
        target: 1500,
        deposits: [
          {
            id: createId(),
            date: new Date().toISOString().slice(0, 10),
            amount: 250,
            note: 'Starter stash',
          },
        ],
      },
      {
        id: gta,
        name: 'GTA 6',
        target: 70,
        deposits: [
          {
            id: createId(),
            date: new Date().toISOString().slice(0, 10),
            amount: 20,
            note: '',
          },
        ],
      },
    ],
    cashBox: {
      balance: 85,
      history: [
        {
          id: createId(),
          date: new Date().toISOString().slice(0, 10),
          type: 'set',
          amount: 85,
          note: 'Starting cash on hand',
          balanceAfter: 85,
        },
      ],
    },
  }
}

function migrateSpendEntry(raw: Partial<SpendEntry>): SpendEntry {
  const note = typeof raw.note === 'string' ? raw.note : ''
  const merchantRaw =
    typeof raw.merchant === 'string' && raw.merchant.trim() ? raw.merchant : note
  return {
    id: typeof raw.id === 'string' ? raw.id : createId(),
    date: typeof raw.date === 'string' ? raw.date : new Date().toISOString().slice(0, 10),
    categoryId: typeof raw.categoryId === 'string' ? raw.categoryId : '',
    amount: money(Number(raw.amount) || 0),
    merchant: normalizeMerchant(merchantRaw),
    note,
  }
}

function migratePaycheck(raw: Partial<PaycheckBudget> | undefined, fallback: PaycheckBudget): PaycheckBudget {
  if (!raw) return fallback
  return {
    label: typeof raw.label === 'string' ? raw.label : fallback.label,
    paycheck: typeof raw.paycheck === 'number' ? raw.paycheck : fallback.paycheck,
    savings: typeof raw.savings === 'number' ? raw.savings : fallback.savings,
    immutable: Array.isArray(raw.immutable) ? raw.immutable : fallback.immutable,
    mutable: Array.isArray(raw.mutable) ? raw.mutable : fallback.mutable,
    spending: Array.isArray(raw.spending)
      ? raw.spending.map((s) => migrateSpendEntry(s as Partial<SpendEntry>))
      : [],
  }
}

function migrateCashBox(raw: Partial<CashBox> | undefined): CashBox {
  if (!raw) {
    return { balance: 0, history: [] }
  }
  return {
    balance: money(Number(raw.balance) || 0),
    history: Array.isArray(raw.history) ? (raw.history as CashTransaction[]) : [],
  }
}

function migrateArchived(raw: unknown): ArchivedPaycheck[] {
  if (!Array.isArray(raw)) return []
  const out: ArchivedPaycheck[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as Partial<ArchivedPaycheck> & { budget?: Partial<PaycheckBudget> }
    const key: PaycheckKey = row.paycheckKey === 'p2' ? 'p2' : 'p1'
    const fallbackLabel = key === 'p1' ? 'Paycheck 1' : 'Paycheck 2'
    out.push({
      id: typeof row.id === 'string' ? row.id : createId(),
      paycheckKey: key,
      label: typeof row.label === 'string' ? row.label : fallbackLabel,
      periodLabel:
        typeof row.periodLabel === 'string' && row.periodLabel.trim()
          ? row.periodLabel
          : defaultPeriodLabel(key),
      archivedAt:
        typeof row.archivedAt === 'string'
          ? row.archivedAt
          : new Date().toISOString().slice(0, 10),
      budget: migratePaycheck(row.budget, {
        label: fallbackLabel,
        paycheck: 0,
        savings: 0,
        immutable: [],
        mutable: [],
        spending: [],
      }),
    })
  }
  return out
}

function migrateState(raw: Record<string, unknown>): BudgetState {
  const base = createDefaultState()

  // Dual-paycheck shape (v4+)
  if (raw.paychecks && typeof raw.paychecks === 'object') {
    const pcs = raw.paychecks as Record<string, Partial<PaycheckBudget>>
    return {
      paychecks: {
        p1: migratePaycheck(pcs.p1, base.paychecks.p1),
        p2: migratePaycheck(pcs.p2, base.paychecks.p2),
      },
      goals: Array.isArray(raw.goals) ? (raw.goals as BudgetState['goals']) : base.goals,
      cashBox: migrateCashBox(raw.cashBox as Partial<CashBox> | undefined),
      history: migrateArchived(raw.history),
    }
  }

  // Old single-paycheck shape → put everything in Paycheck 1
  const oldSpending = Array.isArray(raw.spending)
    ? (raw.spending as Partial<SpendEntry>[]).map(migrateSpendEntry)
    : []

  return {
    paychecks: {
      p1: {
        label: 'Paycheck 1',
        paycheck: typeof raw.paycheck === 'number' ? raw.paycheck : base.paychecks.p1.paycheck,
        savings: typeof raw.savings === 'number' ? raw.savings : base.paychecks.p1.savings,
        immutable: Array.isArray(raw.immutable)
          ? (raw.immutable as PaycheckBudget['immutable'])
          : base.paychecks.p1.immutable,
        mutable: Array.isArray(raw.mutable)
          ? (raw.mutable as PaycheckBudget['mutable'])
          : base.paychecks.p1.mutable,
        spending: oldSpending,
      },
      p2: {
        ...base.paychecks.p2,
        spending: [],
      },
    },
    goals: Array.isArray(raw.goals) ? (raw.goals as BudgetState['goals']) : base.goals,
    cashBox: migrateCashBox(raw.cashBox as Partial<CashBox> | undefined),
    history: migrateArchived(raw.history),
  }
}

export function loadState(): BudgetState {
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY) ??
      localStorage.getItem('steady-budget-v4') ??
      localStorage.getItem('steady-budget-v3') ??
      localStorage.getItem('steady-budget-v2') ??
      localStorage.getItem('steady-budget-v1')
    if (!raw) return createDefaultState()
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return migrateState(parsed)
  } catch {
    return createDefaultState()
  }
}

export function saveState(state: BudgetState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export function goalSaved(goal: { deposits: { amount: number }[] }) {
  return money(goal.deposits.reduce((sum, d) => sum + (Number(d.amount) || 0), 0))
}

export function goalProgress(goal: { target: number; deposits: { amount: number }[] }) {
  const saved = goalSaved(goal)
  const target = money(goal.target) || 0
  if (target <= 0) return saved > 0 ? 100 : 0
  return Math.min(100, (saved / target) * 100)
}

export function computeBudget(budget: PaycheckBudget): BudgetMath {
  const paycheck = money(budget.paycheck)
  const savings = money(budget.savings)
  const immutableTotal = money(
    budget.immutable.reduce((sum, item) => sum + (Number(item.amount) || 0), 0),
  )
  const afterSavings = money(paycheck - savings)
  const afterImmutable = money(afterSavings - immutableTotal)
  const overFixed = afterImmutable < 0
  const mutableBudgetTotal = overFixed ? 0 : afterImmutable
  const percentTotal = money(
    budget.mutable.reduce((sum, item) => sum + (Number(item.percent) || 0), 0),
  )
  const percentOk = Math.abs(percentTotal - 100) < 0.01

  const mutableAmounts: Record<string, number> = {}
  for (const cat of budget.mutable) {
    const pct = Number(cat.percent) || 0
    mutableAmounts[cat.id] = money((mutableBudgetTotal * pct) / 100)
  }

  const spentByCategory: Record<string, number> = {}
  for (const cat of budget.mutable) spentByCategory[cat.id] = 0
  for (const entry of budget.spending) {
    spentByCategory[entry.categoryId] = money(
      (spentByCategory[entry.categoryId] || 0) + (Number(entry.amount) || 0),
    )
  }

  const remainingByCategory: Record<string, number> = {}
  for (const cat of budget.mutable) {
    remainingByCategory[cat.id] = money(
      (mutableAmounts[cat.id] || 0) - (spentByCategory[cat.id] || 0),
    )
  }

  const totalSpentMutable = money(
    Object.values(spentByCategory).reduce((a, b) => a + b, 0),
  )
  const totalRemainingMutable = money(mutableBudgetTotal - totalSpentMutable)

  return {
    paycheck,
    savings,
    immutableTotal,
    afterSavings,
    afterImmutable,
    mutableBudgetTotal,
    percentTotal,
    percentOk,
    overFixed,
    shortfall: overFixed ? money(Math.abs(afterImmutable)) : 0,
    mutableAmounts,
    spentByCategory,
    remainingByCategory,
    totalSpentMutable,
    totalRemainingMutable,
  }
}

export function allSpending(state: BudgetState): SpendEntry[] {
  const archived = state.history.flatMap((h) => h.budget.spending)
  return [...state.paychecks.p1.spending, ...state.paychecks.p2.spending, ...archived]
}

export function allCategories(state: BudgetState) {
  const map = new Map<string, string>()
  for (const key of ['p1', 'p2'] as PaycheckKey[]) {
    for (const cat of state.paychecks[key].mutable) {
      map.set(cat.id, cat.name)
    }
  }
  for (const archived of state.history) {
    for (const cat of archived.budget.mutable) {
      if (!map.has(cat.id)) map.set(cat.id, cat.name)
    }
  }
  return map
}

export function applyCashTransaction(
  cashBox: CashBox,
  type: CashTxType,
  amountInput: number,
  note: string,
  date: string,
): CashBox {
  const amount = money(Math.abs(amountInput))
  let next = money(cashBox.balance)
  if (type === 'set') next = amount
  if (type === 'add') next = money(next + amount)
  if (type === 'spend') next = money(next - amount)

  const tx: CashTransaction = {
    id: createId(),
    date,
    type,
    amount,
    note: note.trim(),
    balanceAfter: next,
  }

  return {
    balance: next,
    history: [tx, ...cashBox.history],
  }
}

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

export function availableStatYears(state: BudgetState): number[] {
  const years = new Set<number>()
  const current = new Date().getFullYear()
  years.add(current)
  for (const entry of allSpending(state)) {
    const y = Number(entry.date?.slice(0, 4))
    if (Number.isFinite(y)) years.add(y)
  }
  return [...years].sort((a, b) => b - a)
}

export function computeYearStats(state: BudgetState, year: number): YearStats {
  const entries = allSpending(state).filter((e) => e.date?.startsWith(String(year)))
  const total = money(entries.reduce((sum, e) => sum + (Number(e.amount) || 0), 0))
  const catNames = allCategories(state)

  const categoryMap = new Map<string, { label: string; amount: number; count: number }>()
  for (const [id, name] of catNames) {
    categoryMap.set(id, { label: name, amount: 0, count: 0 })
  }
  for (const entry of entries) {
    const existing = categoryMap.get(entry.categoryId) ?? {
      label: catNames.get(entry.categoryId) ?? 'Other / old category',
      amount: 0,
      count: 0,
    }
    existing.amount = money(existing.amount + (Number(entry.amount) || 0))
    existing.count += 1
    categoryMap.set(entry.categoryId, existing)
  }

  const merchantMap = new Map<string, { label: string; amount: number; count: number }>()
  for (const entry of entries) {
    const label = normalizeMerchant(entry.merchant) || normalizeMerchant(entry.note) || 'Unlabeled'
    const key = merchantKey(label)
    const existing = merchantMap.get(key) ?? { label, amount: 0, count: 0 }
    existing.amount = money(existing.amount + (Number(entry.amount) || 0))
    existing.count += 1
    if (!existing.label && label) existing.label = label
    merchantMap.set(key, existing)
  }

  const toRows = (
    map: Map<string, { label: string; amount: number; count: number }>,
  ): StatRow[] =>
    [...map.entries()]
      .map(([key, value]) => ({
        key,
        label: value.label,
        amount: value.amount,
        count: value.count,
        share: total > 0 ? (value.amount / total) * 100 : 0,
      }))
      .filter((row) => row.amount > 0 || row.count > 0)
      .sort((a, b) => b.amount - a.amount)

  const monthTotals = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    label: MONTH_LABELS[i],
    amount: 0,
  }))
  for (const entry of entries) {
    const month = Number(entry.date.slice(5, 7))
    if (month >= 1 && month <= 12) {
      monthTotals[month - 1].amount = money(
        monthTotals[month - 1].amount + (Number(entry.amount) || 0),
      )
    }
  }

  return {
    year,
    total,
    entryCount: entries.length,
    byCategory: toRows(categoryMap),
    byMerchant: toRows(merchantMap),
    byMonth: monthTotals,
  }
}
