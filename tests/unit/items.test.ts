import { describe, expect, it } from 'vitest'
import { applyCashTransaction, archivePaycheckPeriod, createDefaultState, createId } from '../../src/math.ts'
import type { BudgetState } from '../../src/types.ts'
import {
  BASELINE_TIME,
  buildBaseline,
  diffState,
  flattenState,
  fromWire,
  materialize,
  mergeFirstSync,
  mergeItems,
  recomputeCash,
  stableStringify,
  toWire,
  type ItemMap,
} from '../../src/sync/items.ts'

const T = (s: string) => Date.parse(s)
const clone = <T>(x: T): T => structuredClone(x)

function canon(state: BudgetState) {
  // Compare by content, independent of list order.
  return stableStringify(
    flattenState(state)
      .map((f) => [f.id, f.kind, f.parentId, f.data])
      .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
  )
}

/** Simulate a device: apply an edit to the materialized state and diff it into items. */
function edit(items: ItemMap, device: string, at: string, fn: (s: BudgetState) => BudgetState) {
  const next = fn(clone(materialize(items)))
  return diffState(items, next, device, T(at)).items
}

function converge(a: ItemMap, b: ItemMap) {
  const ab = mergeItems(a, Object.values(b)).items
  const ba = mergeItems(b, Object.values(a)).items
  return { ab, ba }
}

describe('flatten / materialize', () => {
  it('round-trips the demo state with no spurious diffs', () => {
    const state = createDefaultState()
    const base = buildBaseline(state, 'a', T('2026-10-01T00:00:00Z'))
    const again = materialize(base)
    expect(canon(again)).toBe(canon(state))
    expect(diffState(base, again, 'a').changed).toEqual([])
    expect(Object.values(base).every((i) => i.updatedAt === BASELINE_TIME)).toBe(true)
  })

  it('keeps list order: appended lists by createdAt, prepended lists newest first', () => {
    const state = createDefaultState()
    const base = buildBaseline(state, 'a', T('2026-10-01T00:00:00Z'))
    const m = materialize(base)
    expect(m.paychecks.p1.immutable.map((x) => x.id)).toEqual(state.paychecks.p1.immutable.map((x) => x.id))
    expect(m.paychecks.p1.mutable.map((x) => x.id)).toEqual(state.paychecks.p1.mutable.map((x) => x.id))
    expect(m.goals.map((g) => g.id)).toEqual(state.goals.map((g) => g.id))
  })

  it('normalizes odd remote data once, then is stable', () => {
    const items: ItemMap = {
      s: { id: 's', kind: 'spend', parentId: 'p1', updatedAt: '2026-10-01T00:00:00.000Z', deleted: false, updatedBy: 'x', createdAt: '2026-10-01T00:00:00.000Z', data: { amount: '12.345', date: '2026-10-01' } },
      a: { id: 'a', kind: 'archive', parentId: '', updatedAt: '2026-10-01T00:00:00.000Z', deleted: false, updatedBy: 'x', createdAt: '2026-10-01T00:00:00.000Z', data: { paycheckKey: 'p2', archivedAt: '2026-09-30', budget: { spending: [{ id: 'q', amount: 3 }] } } },
    }
    const first = diffState(items, materialize(items), 'dev', T('2026-10-02T00:00:00Z'))
    const second = diffState(first.items, materialize(first.items), 'dev', T('2026-10-02T00:00:01Z'))
    expect(second.changed).toEqual([])
    expect(materialize(first.items).paychecks.p1.spending[0].amount).toBe(12.35)
  })

  it('wire format round-trips', () => {
    const base = buildBaseline(createDefaultState(), 'a')
    for (const it of Object.values(base)) expect(fromWire(toWire(it))).toEqual(it)
    expect(fromWire({ id: 'x', kind: 'evil', parentId: '', updatedAt: '', deleted: false, updatedBy: '', data: {} })).toBeNull()
  })
})

describe('diffState', () => {
  it('records adds, edits and deletes (tombstones) with fresh timestamps', () => {
    const state = createDefaultState()
    const base = buildBaseline(state, 'a')
    const next = clone(state)
    const removed = next.paychecks.p1.spending.shift()!
    next.paychecks.p1.paycheck = 1750
    next.goals[0].deposits.unshift({ id: 'new-dep', date: '2026-10-02', amount: 5, note: '' })
    const d = diffState(base, next, 'phone', T('2026-10-02T10:00:00Z'))
    expect(d.changed.sort()).toEqual([removed.id, 'new-dep', 'p1.paycheck'].sort())
    expect(d.items[removed.id]).toMatchObject({ deleted: true, updatedBy: 'phone', updatedAt: '2026-10-02T10:00:00.000Z' })
    expect(d.items['p1.paycheck'].data).toEqual({ value: 1750 })
    // Deleting a category cascades to its spends via tombstones
    const cat = next.paychecks.p1.mutable[0]
    const next2 = clone(next)
    next2.paychecks.p1.mutable = next2.paychecks.p1.mutable.filter((c) => c.id !== cat.id)
    next2.paychecks.p1.spending = next2.paychecks.p1.spending.filter((s) => s.categoryId !== cat.id)
    const d2 = diffState(d.items, next2, 'phone', T('2026-10-02T10:01:00Z'))
    expect(d2.items[cat.id].deleted).toBe(true)
  })

  it('a local edit always beats the version it replaces even with a slow clock', () => {
    const state = createDefaultState()
    const base = buildBaseline(state, 'a')
    base['p1.paycheck'] = { ...base['p1.paycheck'], updatedAt: '2030-01-01T00:00:00.000Z' }
    const next = clone(state)
    next.paychecks.p1.paycheck = 1
    const d = diffState(base, next, 'a', T('2026-10-02T00:00:00Z'))
    expect(d.items['p1.paycheck'].updatedAt > '2030-01-01T00:00:00.000Z').toBe(true)
  })
})

describe('mergeItems (two devices)', () => {
  const start = () => {
    const s = createDefaultState()
    return buildBaseline(s, 'seed', T('2026-10-01T00:00:00Z'))
  }

  it('is commutative and idempotent', () => {
    const base = start()
    const a = edit(base, 'a', '2026-10-02T01:00:00Z', (s) => ({ ...s, paychecks: { ...s.paychecks, p1: { ...s.paychecks.p1, label: 'A label' } } }))
    const b = edit(base, 'b', '2026-10-02T02:00:00Z', (s) => ({ ...s, paychecks: { ...s.paychecks, p1: { ...s.paychecks.p1, label: 'B label' } } }))
    const { ab, ba } = converge(a, b)
    expect(canon(materialize(ab))).toBe(canon(materialize(ba)))
    expect(materialize(ab).paychecks.p1.label).toBe('B label')
    expect(mergeItems(ab, Object.values(ab)).tookRemote).toEqual([])
  })

  it('field-level LWW for paycheck singletons', () => {
    const base = start()
    const a = edit(base, 'a', '2026-10-02T01:00:00Z', (s) => { s.paychecks.p1.paycheck = 1800; return s })
    const b = edit(base, 'b', '2026-10-02T02:00:00Z', (s) => { s.paychecks.p1.savings = 300; return s })
    const m = materialize(converge(a, b).ab)
    expect(m.paychecks.p1.paycheck).toBe(1800)
    expect(m.paychecks.p1.savings).toBe(300)
  })

  it('keeps goal deposits added concurrently on both devices', () => {
    const base = start()
    const goalId = materialize(base).goals[0].id
    const add = (amount: number) => (s: BudgetState) => {
      const g = s.goals.find((x) => x.id === goalId)!
      g.deposits.unshift({ id: createId(), date: '2026-10-02', amount, note: '' })
      return s
    }
    const a = edit(base, 'a', '2026-10-02T01:00:00Z', add(10))
    const b = edit(base, 'b', '2026-10-02T01:00:05Z', add(20))
    const { ab, ba } = converge(a, b)
    const amounts = materialize(ab).goals.find((g) => g.id === goalId)!.deposits.map((d) => d.amount).sort()
    expect(amounts).toEqual([10, 20, 250])
    expect(canon(materialize(ab))).toBe(canon(materialize(ba)))
  })

  it('delete vs concurrent edit: the later change wins', () => {
    const base = start()
    const spendId = materialize(base).paychecks.p1.spending[0].id
    const del = edit(base, 'a', '2026-10-02T01:00:00Z', (s) => { s.paychecks.p1.spending = s.paychecks.p1.spending.filter((x) => x.id !== spendId); return s })
    const upd = edit(base, 'b', '2026-10-02T00:30:00Z', (s) => { s.paychecks.p1.spending.find((x) => x.id === spendId)!.amount = 99; return s })
    expect(materialize(converge(del, upd).ab).paychecks.p1.spending.find((x) => x.id === spendId)).toBeUndefined()
    const upd2 = edit(base, 'b', '2026-10-02T02:00:00Z', (s) => { s.paychecks.p1.spending.find((x) => x.id === spendId)!.amount = 77; return s })
    expect(materialize(converge(del, upd2).ab).paychecks.p1.spending.find((x) => x.id === spendId)?.amount).toBe(77)
  })

  it('archive on one device + new spend on the other: archive kept, new spend stays current', () => {
    const base = start()
    const oldIds = materialize(base).paychecks.p1.spending.map((s) => s.id)
    const catId = materialize(base).paychecks.p1.mutable[0].id
    const a = edit(base, 'a', '2026-10-02T01:00:00Z', (s) => archivePaycheckPeriod(s, 'p1', 'Oct 2026 · 1st half', '2026-10-02'))
    const b = edit(base, 'b', '2026-10-02T01:00:30Z', (s) => {
      s.paychecks.p1.spending.unshift({ id: 'late', date: '2026-10-02', categoryId: catId, amount: 9, merchant: 'Late', note: '' })
      return s
    })
    const m = materialize(converge(a, b).ab)
    expect(m.history).toHaveLength(1)
    expect(m.history[0].budget.spending.map((s) => s.id).sort()).toEqual(oldIds.sort())
    expect(m.paychecks.p1.spending.map((s) => s.id)).toEqual(['late'])
  })

  it('recomputes the cash balance by replaying merged history', () => {
    let base = start()
    // Make sure seed history is dated before the new ones
    base = edit(base, 'seed', '2026-10-01T00:00:01Z', (s) => { s.cashBox.history.forEach((t) => (t.date = '2026-10-01')); return s })
    const a = edit(base, 'a', '2026-10-02T01:00:00Z', (s) => ({ ...s, cashBox: applyCashTransaction(s.cashBox, 'add', 20, 'atm', '2026-10-02') }))
    const b = edit(base, 'b', '2026-10-02T01:00:10Z', (s) => ({ ...s, cashBox: applyCashTransaction(s.cashBox, 'spend', 5, 'coffee', '2026-10-02') }))
    const m = materialize(converge(a, b).ab)
    expect(m.cashBox.balance).toBe(85 + 20 - 5)
    expect(m.cashBox.history[0].balanceAfter).toBe(100)
    expect(recomputeCash(m.cashBox.history).balance).toBe(100)
  })

  it('first-sync baseline: remote wins on the same id, unique local items are kept', () => {
    const remote = edit(start(), 'phone', '2026-10-02T01:00:00Z', (s) => { s.paychecks.p1.paycheck = 2000; return s })
    const laptopState = clone(materialize(remote))
    laptopState.paychecks.p1.paycheck = 1
    laptopState.paychecks.p2.spending.unshift({ id: 'laptop-only', date: '2026-09-01', categoryId: laptopState.paychecks.p2.mutable[0].id, amount: 3, merchant: 'Laptop', note: '' })
    const laptop = buildBaseline(laptopState, 'laptop')
    const m = mergeItems(laptop, Object.values(remote))
    const s = materialize(m.items)
    expect(s.paychecks.p1.paycheck).toBe(2000)
    expect(s.paychecks.p2.spending.some((x) => x.id === 'laptop-only')).toBe(true)
    expect(m.localAhead).toEqual(['laptop-only'])
  })

  it('mergeFirstSync: remote wins exact baseline ties regardless of device name', () => {
    const remote = buildBaseline(createDefaultState(), 'aaa-phone')
    const localState = materialize(remote)
    localState.paychecks.p1.paycheck = 5
    const local = buildBaseline(localState, 'zzz-tablet')
    expect(materialize(mergeItems(local, Object.values(remote)).items).paychecks.p1.paycheck).toBe(5)
    const m = mergeFirstSync(local, Object.values(remote))
    expect(materialize(m.items).paychecks.p1.paycheck).toBe(1600)
    expect(m.localAhead).toEqual([])
  })

  it('random concurrent edit sequences always converge to the same state', () => {
    let seed = 42
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    const ops: ((s: BudgetState) => BudgetState)[] = [
      (s) => { s.paychecks.p1.spending.unshift({ id: createId(), date: '2026-10-0' + (1 + Math.floor(rand() * 9)), categoryId: s.paychecks.p1.mutable[0]?.id ?? '', amount: Math.round(rand() * 100), merchant: 'M', note: '' }); return s },
      (s) => { s.paychecks.p1.spending.pop(); return s },
      (s) => { s.paychecks.p2.paycheck = Math.round(rand() * 3000); return s },
      (s) => { if (s.goals[0]) s.goals[0].deposits.unshift({ id: createId(), date: '2026-10-02', amount: 1, note: '' }); return s },
      (s) => { s.goals = s.goals.slice(1); return s },
      (s) => ({ ...s, cashBox: applyCashTransaction(s.cashBox, rand() > 0.5 ? 'add' : 'spend', 3, '', '2026-10-02') }),
      (s) => { s.paychecks.p1.mutable.push({ id: createId(), name: 'X', percent: 1 }); return s },
    ]
    for (let round = 0; round < 40; round++) {
      let a = start()
      let b = start()
      for (let k = 0; k < 6; k++) {
        const at = new Date(T('2026-10-02T00:00:00Z') + round * 1000 + k * 10).toISOString()
        a = edit(a, 'a', at, ops[Math.floor(rand() * ops.length)])
        b = edit(b, 'b', at, ops[Math.floor(rand() * ops.length)])
        if (rand() < 0.3) {
          const { ab, ba } = converge(a, b)
          a = ab
          b = ba
        }
      }
      const { ab, ba } = converge(a, b)
      expect(canon(materialize(ab))).toBe(canon(materialize(ba)))
      expect(stableStringify(materialize(ab))).toBe(stableStringify(materialize(ba)))
    }
  })
})
