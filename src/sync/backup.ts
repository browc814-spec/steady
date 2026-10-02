import { migrateState } from '../math.ts'
import type { BudgetState, PaycheckBudget, PaycheckKey } from '../types.ts'
import { recomputeCash } from './items.ts'

export interface BackupFile {
  app: 'steady'
  kind: 'steady-backup'
  version: 5
  exportedAt: string
  state: BudgetState
}

export function makeBackup(state: BudgetState): BackupFile {
  return { app: 'steady', kind: 'steady-backup', version: 5, exportedAt: new Date().toISOString(), state }
}

export function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function downloadBackup(state: BudgetState) {
  const day = new Date().toISOString().slice(0, 10)
  downloadText(`steady-backup-${day}.json`, JSON.stringify(makeBackup(state), null, 2))
}

/** Accepts a Steady backup file, a raw steady-budget-v5 blob, or an older v1–v4 blob. */
export function parseBackup(text: string): BudgetState {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('That file is not valid JSON.')
  }
  if (!raw || typeof raw !== 'object') throw new Error('That file does not contain Steady data.')
  const obj = raw as Record<string, unknown>
  const inner = (obj.kind === 'steady-backup' && obj.state && typeof obj.state === 'object'
    ? obj.state
    : obj) as Record<string, unknown>
  const looksLikeSteady =
    'paychecks' in inner || 'spending' in inner || 'immutable' in inner || 'mutable' in inner
  if (!looksLikeSteady) throw new Error('That file does not contain Steady data.')
  return migrateState(inner)
}

function unionById<T extends { id: string }>(current: T[], incoming: T[]) {
  const ids = new Set(current.map((x) => x.id))
  return [...current, ...incoming.filter((x) => !ids.has(x.id))]
}

function byDateDesc<T extends { date: string }>(list: T[]) {
  return list
    .map((x, i) => ({ x, i }))
    .sort((a, b) => (a.x.date === b.x.date ? a.i - b.i : a.x.date < b.x.date ? 1 : -1))
    .map((w) => w.x)
}

/** Merge an imported backup into the current data. Items already present (same id) keep the current version. */
export function mergeStates(current: BudgetState, incoming: BudgetState): BudgetState {
  const paychecks = {} as Record<PaycheckKey, PaycheckBudget>
  for (const key of ['p1', 'p2'] as PaycheckKey[]) {
    const c = current.paychecks[key]
    const i = incoming.paychecks[key]
    paychecks[key] = {
      ...c,
      immutable: unionById(c.immutable, i.immutable),
      mutable: unionById(c.mutable, i.mutable),
      spending: byDateDesc(unionById(c.spending, i.spending)),
    }
  }
  const goalIds = new Set(current.goals.map((g) => g.id))
  const goals = [
    ...current.goals.map((g) => {
      const other = incoming.goals.find((x) => x.id === g.id)
      return other ? { ...g, deposits: byDateDesc(unionById(g.deposits, other.deposits)) } : g
    }),
    ...incoming.goals.filter((g) => !goalIds.has(g.id)),
  ]
  const cash = recomputeCash(byDateDesc(unionById(current.cashBox.history, incoming.cashBox.history)))
  const history = unionById(current.history, incoming.history).sort((a, b) =>
    a.archivedAt === b.archivedAt ? 0 : a.archivedAt < b.archivedAt ? 1 : -1,
  )
  return { paychecks, goals, cashBox: cash, history }
}
