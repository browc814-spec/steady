import { v4 as uuid } from 'uuid'
import type { BudgetMath, BudgetState, SpendEntry, StatRow, YearStats } from './types'

export const STORAGE_KEY = 'steady-budget-v3'

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

export function createDefaultState(): BudgetState {
  const year = new Date().getFullYear()
  const groceries = createId()
  const gas = createId()
  const carMaint = createId()
  const eatingOut = createId()
  const fun = createId()
  const misc = createId()
  const sanDiego = createId()
  const gta = createId()

  const spending: SpendEntry[] = [
    { id: createId(), date: `${year}-01-12`, categoryId: eatingOut, amount: 28.4, merchant: 'DoorDash', note: '' },
    { id: createId(), date: `${year}-01-20`, categoryId: eatingOut, amount: 22.1, merchant: 'DoorDash', note: '' },
    { id: createId(), date: `${year}-02-03`, categoryId: misc, amount: 35, merchant: 'Smoke City', note: '' },
    { id: createId(), date: `${year}-02-18`, categoryId: groceries, amount: 84.22, merchant: 'Costco', note: '' },
    { id: createId(), date: `${year}-03-08`, categoryId: eatingOut, amount: 31.5, merchant: 'DoorDash', note: '' },
    { id: createId(), date: `${year}-03-22`, categoryId: gas, amount: 48, merchant: 'Shell', note: '' },
    { id: createId(), date: `${year}-04-11`, categoryId: misc, amount: 40, merchant: 'Smoke City', note: '' },
    { id: createId(), date: `${year}-05-02`, categoryId: fun, amount: 60, merchant: 'Steam', note: 'Sale weekend' },
    { id: createId(), date: `${year}-05-19`, categoryId: eatingOut, amount: 19.75, merchant: 'DoorDash', note: '' },
    { id: createId(), date: `${year}-06-07`, categoryId: groceries, amount: 96.4, merchant: 'Costco', note: '' },
    { id: createId(), date: `${year}-07-14`, categoryId: misc, amount: 30, merchant: 'Smoke City', note: '' },
    { id: createId(), date: `${year}-08-01`, categoryId: carMaint, amount: 75, merchant: 'Jiffy Lube', note: 'Oil change' },
    { id: createId(), date: `${year}-08-23`, categoryId: eatingOut, amount: 26.9, merchant: 'DoorDash', note: '' },
    { id: createId(), date: `${year}-09-09`, categoryId: gas, amount: 52.3, merchant: 'Shell', note: '' },
    { id: createId(), date: `${year}-09-28`, categoryId: misc, amount: 38, merchant: 'Smoke City', note: '' },
  ]

  return {
    paycheck: 3200,
    savings: 400,
    immutable: [
      { id: createId(), name: 'Rent', amount: 1200 },
      { id: createId(), name: 'Utilities', amount: 180 },
      { id: createId(), name: 'Car payment', amount: 350 },
      { id: createId(), name: 'Phone', amount: 80 },
      { id: createId(), name: 'Debt payment', amount: 200 },
    ],
    mutable: [
      { id: groceries, name: 'Groceries', percent: 30 },
      { id: gas, name: 'Gas', percent: 15 },
      { id: carMaint, name: 'Car maintenance', percent: 10 },
      { id: eatingOut, name: 'Eating out', percent: 15 },
      { id: fun, name: 'Fun money', percent: 20 },
      { id: misc, name: 'Misc', percent: 10 },
    ],
    spending,
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
  }
}

function migrateSpendEntry(raw: Partial<SpendEntry>): SpendEntry {
  const note = typeof raw.note === 'string' ? raw.note : ''
  const merchantRaw =
    typeof raw.merchant === 'string' && raw.merchant.trim()
      ? raw.merchant
      : note
  return {
    id: typeof raw.id === 'string' ? raw.id : createId(),
    date: typeof raw.date === 'string' ? raw.date : new Date().toISOString().slice(0, 10),
    categoryId: typeof raw.categoryId === 'string' ? raw.categoryId : '',
    amount: money(Number(raw.amount) || 0),
    merchant: normalizeMerchant(merchantRaw),
    note,
  }
}

function migrateState(raw: Partial<BudgetState>): BudgetState {
  const base = createDefaultState()
  return {
    paycheck: typeof raw.paycheck === 'number' ? raw.paycheck : base.paycheck,
    savings: typeof raw.savings === 'number' ? raw.savings : base.savings,
    immutable: Array.isArray(raw.immutable) ? raw.immutable : base.immutable,
    mutable: Array.isArray(raw.mutable) ? raw.mutable : base.mutable,
    spending: Array.isArray(raw.spending)
      ? raw.spending.map((s) => migrateSpendEntry(s as Partial<SpendEntry>))
      : base.spending,
    goals: Array.isArray(raw.goals) ? raw.goals : base.goals,
  }
}

export function loadState(): BudgetState {
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY) ??
      localStorage.getItem('steady-budget-v2') ??
      localStorage.getItem('steady-budget-v1')
    if (!raw) return createDefaultState()
    const parsed = JSON.parse(raw) as Partial<BudgetState>
    if (!parsed || typeof parsed.paycheck !== 'number') return createDefaultState()
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

export function computeBudget(state: BudgetState): BudgetMath {
  const paycheck = money(state.paycheck)
  const savings = money(state.savings)
  const immutableTotal = money(
    state.immutable.reduce((sum, item) => sum + (Number(item.amount) || 0), 0),
  )
  const afterSavings = money(paycheck - savings)
  const afterImmutable = money(afterSavings - immutableTotal)
  const overFixed = afterImmutable < 0
  const mutableBudgetTotal = overFixed ? 0 : afterImmutable
  const percentTotal = money(
    state.mutable.reduce((sum, item) => sum + (Number(item.percent) || 0), 0),
  )
  const percentOk = Math.abs(percentTotal - 100) < 0.01

  const mutableAmounts: Record<string, number> = {}
  for (const cat of state.mutable) {
    const pct = Number(cat.percent) || 0
    mutableAmounts[cat.id] = money((mutableBudgetTotal * pct) / 100)
  }

  const spentByCategory: Record<string, number> = {}
  for (const cat of state.mutable) spentByCategory[cat.id] = 0
  for (const entry of state.spending) {
    spentByCategory[entry.categoryId] = money(
      (spentByCategory[entry.categoryId] || 0) + (Number(entry.amount) || 0),
    )
  }

  const remainingByCategory: Record<string, number> = {}
  for (const cat of state.mutable) {
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
  for (const entry of state.spending) {
    const y = Number(entry.date?.slice(0, 4))
    if (Number.isFinite(y)) years.add(y)
  }
  return [...years].sort((a, b) => b - a)
}

export function computeYearStats(state: BudgetState, year: number): YearStats {
  const entries = state.spending.filter((e) => e.date?.startsWith(String(year)))
  const total = money(entries.reduce((sum, e) => sum + (Number(e.amount) || 0), 0))

  const categoryMap = new Map<string, { label: string; amount: number; count: number }>()
  for (const cat of state.mutable) {
    categoryMap.set(cat.id, { label: cat.name, amount: 0, count: 0 })
  }
  for (const entry of entries) {
    const existing = categoryMap.get(entry.categoryId) ?? {
      label: 'Other / old category',
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
    // Prefer first non-empty casing as display label
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
