export type Money = number
export type PaycheckKey = 'p1' | 'p2'

export interface ImmutableItem {
  id: string
  name: string
  amount: number
}

export interface MutableCategory {
  id: string
  name: string
  percent: number
}

export interface SpendEntry {
  id: string
  date: string
  categoryId: string
  amount: number
  /** Store / item name used for yearly tallies (e.g. DoorDash, Smoke City) */
  merchant: string
  note: string
}

export interface GoalDeposit {
  id: string
  date: string
  amount: number
  note: string
}

export interface SavingsGoal {
  id: string
  name: string
  target: number
  deposits: GoalDeposit[]
}

export interface PaycheckBudget {
  label: string
  paycheck: number
  savings: number
  immutable: ImmutableItem[]
  mutable: MutableCategory[]
  spending: SpendEntry[]
}

export type CashTxType = 'set' | 'add' | 'spend'

export interface CashTransaction {
  id: string
  date: string
  type: CashTxType
  amount: number
  note: string
  /** Balance after this transaction */
  balanceAfter: number
}

export interface CashBox {
  balance: number
  history: CashTransaction[]
}

/** Frozen copy of one paycheck period for the History tab */
export interface ArchivedPaycheck {
  id: string
  paycheckKey: PaycheckKey
  /** e.g. "Paycheck 1" */
  label: string
  /** e.g. "Oct 2026 · 1st half" */
  periodLabel: string
  archivedAt: string
  budget: PaycheckBudget
}

export interface BudgetState {
  paychecks: Record<PaycheckKey, PaycheckBudget>
  goals: SavingsGoal[]
  cashBox: CashBox
  /** Past paycheck periods, newest first */
  history: ArchivedPaycheck[]
}

export interface BudgetMath {
  paycheck: number
  savings: number
  immutableTotal: number
  afterSavings: number
  afterImmutable: number
  mutableBudgetTotal: number
  percentTotal: number
  percentOk: boolean
  overFixed: boolean
  shortfall: number
  mutableAmounts: Record<string, number>
  spentByCategory: Record<string, number>
  remainingByCategory: Record<string, number>
  totalSpentMutable: number
  totalRemainingMutable: number
}

export interface StatRow {
  key: string
  label: string
  amount: number
  count: number
  share: number
}

export interface YearStats {
  year: number
  total: number
  entryCount: number
  byCategory: StatRow[]
  byMerchant: StatRow[]
  byMonth: { month: number; label: string; amount: number }[]
}
