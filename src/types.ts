export type Money = number

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

export interface BudgetState {
  paycheck: number
  savings: number
  immutable: ImmutableItem[]
  mutable: MutableCategory[]
  spending: SpendEntry[]
  goals: SavingsGoal[]
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
