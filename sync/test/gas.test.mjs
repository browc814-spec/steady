import { describe, expect, it } from 'vitest'
import { createGasEnv } from './gas-shim.mjs'

const TOKEN = 'test-token-0123456789abcdef0123456789'
const T0 = Date.parse('2026-10-02T19:00:00.000Z')

function item(id, kind, parentId, data, updatedAt, extra = {}) {
  return { id, kind, parentId, data: { createdAt: updatedAt, ...data }, updatedAt, deleted: false, updatedBy: 'test', ...extra }
}

function seed(env) {
  return env.post({
    token: TOKEN,
    action: 'push',
    baseRev: 0,
    items: [
      item('p1.label', 'paycheckField', 'p1', { value: 'Paycheck 1' }, '2026-10-01T00:00:00.000Z'),
      item('p1.paycheck', 'paycheckField', 'p1', { value: 1600 }, '2026-10-01T00:00:00.000Z'),
      item('cat-groc', 'category', 'p1', { name: 'Groceries', percent: 30 }, '2026-10-01T00:00:00.000Z'),
      item('bill-rent', 'bill', 'p1', { name: 'Rent', amount: 600 }, '2026-10-01T00:00:00.000Z'),
      item('s1', 'spend', 'p1', { date: '2026-10-01', categoryId: 'cat-groc', amount: 20, merchant: 'Costco', note: '' }, '2026-10-01T00:00:00.000Z'),
      item('goal-1', 'goal', '', { name: 'Trip', target: 1000 }, '2026-10-01T00:00:00.000Z'),
      item('cash-1', 'cashTx', '', { date: '2026-10-01', type: 'set', amount: 50, note: '' }, '2026-10-01T00:00:00.000Z'),
    ],
  })
}

describe('Code.gs (Apps Script) via shim', () => {
  it('doGet is a data-free health check', () => {
    const env = createGasEnv({ token: TOKEN })
    expect(env.get()).toEqual({ ok: true, app: 'steady-sync', schemaVersion: 1 })
  })

  it('rejects missing/wrong token, bad JSON, and unset SYNC_TOKEN', () => {
    const env = createGasEnv({ token: TOKEN })
    expect(env.post({ action: 'pull' }).error).toBe('unauthorized')
    expect(env.post({ token: TOKEN.slice(0, -1) + 'x', action: 'pull' }).error).toBe('unauthorized')
    expect(env.post('{nope').error).toBe('bad_json')
    const unset = createGasEnv({ token: null })
    expect(unset.post({ token: TOKEN, action: 'pull' }).error).toBe('unauthorized')
  })

  it('returns busy when the lock is held', () => {
    const env = createGasEnv({ token: TOKEN })
    env.lockBusy = true
    expect(env.post({ token: TOKEN, action: 'pull' }).error).toBe('busy')
  })

  it('push then pull round-trips items, bumps rev, writes plain-text cells', () => {
    const env = createGasEnv({ token: TOKEN, now: T0 })
    const r1 = seed(env)
    expect(r1).toMatchObject({ ok: true, rev: 1, applied: 7, unchanged: true, stale: false })
    const pull = env.post({ token: TOKEN, action: 'pull', sinceRev: null })
    expect(pull.rev).toBe(1)
    expect(pull.items).toHaveLength(7)
    expect(pull.items.find((i) => i.id === 's1').data.amount).toBe(20)
    const same = env.post({ token: TOKEN, action: 'pull', sinceRev: 1 })
    expect(same).toMatchObject({ ok: true, rev: 1, unchanged: true })
    expect(same.items).toBeUndefined()
    // updatedAt stays a string (column is plain text), not a Date
    const rows = env.table('Items')
    expect(typeof rows[0].updatedAt).toBe('string')
    expect(env.table('Meta')[0]).toMatchObject({ rev: 1, schemaVersion: 1 })
  })

  it('applies last-write-wins per item and reports stale baseRev', () => {
    const env = createGasEnv({ token: TOKEN, now: T0 })
    seed(env)
    // Newer edit wins
    const newer = env.post({ token: TOKEN, action: 'push', baseRev: 1, items: [item('s1', 'spend', 'p1', { date: '2026-10-01', categoryId: 'cat-groc', amount: 25, merchant: 'Costco', note: '' }, '2026-10-02T00:00:00.000Z')] })
    expect(newer).toMatchObject({ rev: 2, applied: 1, stale: false, unchanged: true })
    // Older edit loses, and the client gets the full list back to merge
    const older = env.post({ token: TOKEN, action: 'push', baseRev: 2, items: [item('s1', 'spend', 'p1', { date: '2026-10-01', categoryId: 'cat-groc', amount: 99, merchant: 'Costco', note: '' }, '2026-10-01T12:00:00.000Z')] })
    expect(older.applied).toBe(0)
    expect(older.items.find((i) => i.id === 's1').data.amount).toBe(25)
    expect(older.rev).toBe(2)
    // Stale baseRev still merges safely and returns everything
    const stale = env.post({ token: TOKEN, action: 'push', baseRev: 0, items: [item('s2', 'spend', 'p1', { date: '2026-10-02', categoryId: 'cat-groc', amount: 5, merchant: 'Shell', note: '' }, '2026-10-02T01:00:00.000Z')] })
    expect(stale).toMatchObject({ rev: 3, applied: 1, stale: true })
    expect(stale.items.map((i) => i.id)).toContain('s2')
    // Tombstones
    const del = env.post({ token: TOKEN, action: 'push', baseRev: 3, items: [{ ...item('s2', 'spend', 'p1', {}, '2026-10-02T02:00:00.000Z'), deleted: true }] })
    expect(del.applied).toBe(1)
    const pull = env.post({ token: TOKEN, action: 'pull', sinceRev: null })
    expect(pull.items.find((i) => i.id === 's2').deleted).toBe(true)
    // Invalid items are rejected, not stored
    const bad = env.post({ token: TOKEN, action: 'push', baseRev: 4, items: [{ id: 'x', kind: 'hack', updatedAt: '2026-10-02T00:00:00.000Z' }] })
    expect(bad.rejected).toEqual(['x'])
  })

  it('folds Inbox rows: create, partial update, delete, errors, LWW skip; marks processedAt', () => {
    const env = createGasEnv({ token: TOKEN, now: T0 })
    seed(env)
    env.sheet('Inbox').externalAppend([
      ['n1', 'spend', 'p1', 'upsert', '{"date":"2026-10-02","categoryId":"cat-groc","amount":"12.50","merchant":"Trader Joes"}', '2026-10-02T18:00:00.000Z', 'tammy', ''],
      ['s1', 'spend', '', 'upsert', '{"amount":21}', '2026-10-02T18:01:00.000Z', 'tammy', ''],
      ['cash-1', 'cashTx', '', 'delete', '', '2026-10-02T18:02:00.000Z', 'tammy', ''],
      ['d1', 'deposit', 'goal-1', 'upsert', '{"amount":100,"note":"from tammy"}', '', 'tammy', ''],
      ['bad', 'spend', 'p1', 'upsert', '{"amount":5,"merchant":"x","categoryId":"nope"}', '', 'tammy', ''],
      ['p1.paycheck', 'paycheckField', '', 'upsert', '{"value":1700}', '2026-10-02T18:03:00.000Z', 'tammy', ''],
      ['s1', 'spend', '', 'upsert', '{"amount":1}', '2026-09-01T00:00:00.000Z', 'tammy', ''],
      ['', '', '', '', '', '', '', ''],
    ])
    const pull = env.post({ token: TOKEN, action: 'pull', sinceRev: 1 })
    expect(pull.inboxProcessed).toBe(7)
    expect(pull.rev).toBe(2)
    const byId = Object.fromEntries(pull.items.map((i) => [i.id, i]))
    expect(byId.n1.data).toMatchObject({ amount: 12.5, merchant: 'Trader Joes', note: '', date: '2026-10-02' })
    expect(byId.n1.updatedBy).toBe('tammy')
    expect(byId.s1.data).toMatchObject({ amount: 21, merchant: 'Costco' })
    expect(byId['cash-1'].deleted).toBe(true)
    expect(byId.d1.data).toMatchObject({ amount: 100, note: 'from tammy' })
    expect(byId.d1.data.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(byId.bad).toBeUndefined()
    expect(byId['p1.paycheck'].data.value).toBe(1700)
    const marks = env.table('Inbox').map((r) => String(r.processedAt))
    expect(marks[0]).toMatch(/^2026-10-02T19:00:00.000Z$/)
    expect(marks[4]).toMatch(/^ERROR .*categoryId/)
    expect(marks[6]).toMatch(/^SKIPPED .*newer/)
    // Re-processing is a no-op
    const again = env.post({ token: TOKEN, action: 'pull', sinceRev: 2 })
    expect(again).toMatchObject({ unchanged: true, inboxProcessed: 0 })
  })

  it('handles Date objects from USER_ENTERED appends and future createdAt', () => {
    const env = createGasEnv({ token: TOKEN, now: T0 })
    seed(env)
    // Simulate an append before the Inbox column was text formatted
    env.sheet('Inbox').textCols.clear()
    env.sheet('Inbox').externalAppend([
      ['n2', 'cashTx', '', 'upsert', '{"type":"add","amount":20,"date":"2026-10-02"}', '2026-10-02T18:00:00.000Z', 'tammy', ''],
      ['n3', 'cashTx', '', 'upsert', '{"type":"spend","amount":5}', '2030-01-01T00:00:00.000Z', 'tammy', ''],
    ], true)
    const pull = env.post({ token: TOKEN, action: 'pull', sinceRev: 1 })
    const byId = Object.fromEntries(pull.items.map((i) => [i.id, i]))
    expect(byId.n2.updatedAt).toBe('2026-10-02T18:00:00.000Z')
    expect(byId.n3.updatedAt).toBe(new Date(T0).toISOString()) // clamped to now
  })

  it('rebuilds Transactions and Summary with derived numbers', () => {
    const env = createGasEnv({ token: TOKEN, now: T0 })
    seed(env)
    env.post({ token: TOKEN, action: 'push', baseRev: 1, items: [
      item('cash-2', 'cashTx', '', { date: '2026-10-02', type: 'spend', amount: 12, note: 'lunch' }, '2026-10-02T00:00:00.000Z'),
      item('d1', 'deposit', 'goal-1', { date: '2026-10-02', amount: 250, note: '' }, '2026-10-02T00:00:00.000Z'),
      item('a1', 'archive', '', { paycheckKey: 'p1', label: 'Paycheck 1', periodLabel: 'Sep 2026 · 2nd half', archivedAt: '2026-09-30', budget: { label: 'Paycheck 1', paycheck: 1600, savings: 200, immutable: [], mutable: [{ id: 'cat-old', name: 'Fun', percent: 100 }], spending: [{ id: 'old1', date: '2026-09-20', categoryId: 'cat-old', amount: 40, merchant: '=HYPERLINK("x")', note: '' }] } }, '2026-09-30T00:00:00.000Z'),
    ] })
    const tx = env.table('Transactions')
    expect(tx.map((r) => r.type)).toEqual(expect.arrayContaining(['spend', 'spend (archived)', 'cash set', 'cash spend', 'goal deposit']))
    const archived = tx.find((r) => r.type === 'spend (archived)')
    expect(archived).toMatchObject({ category: 'Fun', amount: 40, period: 'Sep 2026 · 2nd half', date: '2026-09-20' })
    expect(typeof archived.date).toBe('string') // text format kept it from becoming a Date
    const summary = env.table('Summary')
    const get = (k, v) => summary.find((r) => r.key === k && r.value === v)?.extra
    expect(get('Cash box', 'balance')).toBe(38)
    expect(get('Goal', 'Trip')).toBe(250)
    expect(get('Paycheck 1', 'bills total')).toBe(600)
    expect(get('Paycheck 1', 'spent this period')).toBe(20)
  })

  it('splits very large json across overflow columns and reads it back', () => {
    const env = createGasEnv({ token: TOKEN, now: T0 })
    const spending = Array.from({ length: 900 }, (_, i) => ({ id: `x${i}`, date: '2026-09-01', categoryId: 'c', amount: 1, merchant: 'Merchant name '.repeat(3), note: 'n' }))
    const big = item('a-big', 'archive', '', { paycheckKey: 'p1', label: 'P1', periodLabel: 'big', archivedAt: '2026-09-30', budget: { label: 'P1', paycheck: 1, savings: 0, immutable: [], mutable: [], spending } }, '2026-09-30T00:00:00.000Z')
    expect(JSON.stringify(big.data).length).toBeGreaterThan(90000)
    expect(env.post({ token: TOKEN, action: 'push', baseRev: 0, items: [big] }).applied).toBe(1)
    expect(env.table('Items')[0]['json+2']).toBeTruthy()
    const pull = env.post({ token: TOKEN, action: 'pull', sinceRev: null })
    expect(pull.items[0].data.budget.spending).toHaveLength(900)
  })

  it('setupTrigger installs exactly one 5-minute processInbox trigger; processInbox folds rows', () => {
    const env = createGasEnv({ token: TOKEN, now: T0 })
    env.run('setupTrigger')
    env.run('setupTrigger')
    expect(env.triggers).toHaveLength(1)
    expect(env.triggers[0]).toMatchObject({ fn: 'processInbox', n: 5 })
    seed(env)
    env.sheet('Inbox').externalAppend([['g2', 'goal', '', 'upsert', '{"name":"Car","target":500}', '', 'tammy', '']])
    env.run('processInbox')
    expect(env.table('Meta')[0].rev).toBe(2)
    expect(env.table('Items').some((r) => r.id === 'g2')).toBe(true)
    expect(String(env.table('README')[0] ? 'ok' : '')).toBe('ok')
  })

  it('never logs anything (bodies or tokens)', () => {
    const env = createGasEnv({ token: TOKEN, now: T0 })
    seed(env)
    env.post({ token: TOKEN, action: 'pull' })
    env.post({ token: 'wrong', action: 'pull' })
    env.post('{bad')
    expect(env.logs).toEqual([])
  })
})
