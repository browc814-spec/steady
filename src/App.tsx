import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, RotateCcw, Wallet, Banknote, Archive, ChevronDown, ChevronRight, History } from 'lucide-react'
import type {
  ArchivedPaycheck,
  BudgetState,
  CashTxType,
  MutableCategory,
  PaycheckBudget,
  PaycheckKey,
  SavingsGoal,
  SpendEntry,
} from './types'
import {
  applyCashTransaction,
  archivePaycheckPeriod,
  availableStatYears,
  computeBudget,
  computeYearStats,
  createDefaultState,
  createId,
  defaultPeriodLabel,
  formatMoney,
  goalProgress,
  goalSaved,
  loadState,
  money,
  saveState,
} from './math'

type MainTab = PaycheckKey | 'cash' | 'goals' | 'history' | 'stats'

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

function parseMoneyInput(value: string) {
  const cleaned = value.replace(/[^0-9.]/g, '')
  const n = Number(cleaned)
  return Number.isFinite(n) ? money(n) : 0
}

function BudgetView({
  paycheckKey,
  budget,
  onChange,
  onResetAll,
  onArchive,
}: {
  paycheckKey: PaycheckKey
  budget: PaycheckBudget
  onChange: (next: PaycheckBudget) => void
  onResetAll: () => void
  onArchive: (periodLabel: string) => void
}) {
  const math = useMemo(() => computeBudget(budget), [budget])
  const [logDate, setLogDate] = useState(todayISO)
  const [logCategoryId, setLogCategoryId] = useState('')
  const [logAmount, setLogAmount] = useState('')
  const [logMerchant, setLogMerchant] = useState('')
  const [logNote, setLogNote] = useState('')

  useEffect(() => {
    if (!logCategoryId && budget.mutable[0]) {
      setLogCategoryId(budget.mutable[0].id)
    } else if (logCategoryId && !budget.mutable.find((c) => c.id === logCategoryId)) {
      setLogCategoryId(budget.mutable[0]?.id ?? '')
    }
  }, [budget.mutable, logCategoryId])

  const patch = (partial: Partial<PaycheckBudget>) => onChange({ ...budget, ...partial })

  const addImmutable = () => {
    patch({
      immutable: [...budget.immutable, { id: createId(), name: 'New bill', amount: 0 }],
    })
  }

  const addMutable = () => {
    patch({
      mutable: [...budget.mutable, { id: createId(), name: 'New category', percent: 0 }],
    })
  }

  const addSpend = () => {
    const amount = parseMoneyInput(logAmount)
    const merchant = logMerchant.trim()
    if (!logCategoryId || amount <= 0 || !merchant) return
    const entry: SpendEntry = {
      id: createId(),
      date: logDate || todayISO(),
      categoryId: logCategoryId,
      amount,
      merchant,
      note: logNote.trim(),
    }
    patch({ spending: [entry, ...budget.spending] })
    setLogAmount('')
    setLogMerchant('')
    setLogNote('')
  }

  const categoryName = (id: string) =>
    budget.mutable.find((c) => c.id === id)?.name ?? 'Unknown'

  const stepsDone = {
    pay: budget.paycheck > 0,
    save: true,
    fixed: budget.immutable.length > 0,
    split: math.percentOk && !math.overFixed,
  }

  const title = paycheckKey === 'p1' ? 'Paycheck 1' : 'Paycheck 2'

  return (
    <>
      <div className="steps" aria-label="Progress" style={{ marginBottom: '1rem' }}>
        <span className={`step-pill ${stepsDone.pay ? 'done' : 'active'}`}>1. Paycheck</span>
        <span className={`step-pill ${stepsDone.save ? 'done' : ''}`}>2. Savings</span>
        <span className={`step-pill ${stepsDone.fixed ? 'done' : ''}`}>3. Bills</span>
        <span className={`step-pill ${stepsDone.split ? 'done' : ''}`}>4. Split</span>
        <span className="step-pill">5. Log</span>
      </div>

      <section className="hero-card">
        <div className="hero-grid">
          <div className="metric">
            <span>{title}</span>
            <strong>{formatMoney(math.paycheck)}</strong>
          </div>
          <div className={`metric ${math.overFixed ? 'danger' : 'warn'}`}>
            <span>Must-pays + savings</span>
            <strong>{formatMoney(math.savings + math.immutableTotal)}</strong>
          </div>
          <div className={`metric ${math.overFixed ? 'danger' : 'accent'}`}>
            <span>{math.overFixed ? 'Short by' : 'Left to split'}</span>
            <strong>
              {formatMoney(math.overFixed ? math.shortfall : math.mutableBudgetTotal)}
            </strong>
          </div>
        </div>
        {math.overFixed ? (
          <p className="hint bad">
            Savings + bills are bigger than this paycheck by {formatMoney(math.shortfall)}.
            Lower savings or a bill to continue.
          </p>
        ) : (
          <p className="hint good">
            After savings and bills on {title}, you have{' '}
            {formatMoney(math.mutableBudgetTotal)} to split across flexible spending.
          </p>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>1. {title}</h2>
            <p>Enter what hits your bank for this half of the month.</p>
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              if (confirm('Reset everything (both paychecks, goals, cash) to the demo?')) {
                onResetAll()
              }
            }}
          >
            <RotateCcw size={16} /> Reset demo
          </button>
        </div>
        <div className="field-row">
          <label className="field">
            <span>Paycheck amount</span>
            <input
              className="input money"
              inputMode="decimal"
              value={budget.paycheck}
              onChange={(e) => patch({ paycheck: parseMoneyInput(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>I want to save from this check</span>
            <input
              className="input money"
              inputMode="decimal"
              value={budget.savings}
              onChange={(e) => patch({ savings: parseMoneyInput(e.target.value) })}
            />
          </label>
        </div>
        <p className="hint">
          After saving {formatMoney(math.savings)}, you have{' '}
          <strong>{formatMoney(math.afterSavings)}</strong> left for bills and spending on
          this paycheck.
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>2. Immutable spending</h2>
            <p>
              Bills for this paycheck only. Tip: put half of monthly bills on each paycheck
              tab.
            </p>
          </div>
          <button type="button" className="btn btn-primary" onClick={addImmutable}>
            <Plus size={16} /> Add bill
          </button>
        </div>
        <div className="list">
          {budget.immutable.map((item) => (
            <div className="list-row" key={item.id}>
              <input
                className="input"
                value={item.name}
                onChange={(e) =>
                  patch({
                    immutable: budget.immutable.map((x) =>
                      x.id === item.id ? { ...x, name: e.target.value } : x,
                    ),
                  })
                }
                aria-label="Bill name"
              />
              <input
                className="input money"
                inputMode="decimal"
                value={item.amount}
                onChange={(e) =>
                  patch({
                    immutable: budget.immutable.map((x) =>
                      x.id === item.id
                        ? { ...x, amount: parseMoneyInput(e.target.value) }
                        : x,
                    ),
                  })
                }
                aria-label={`${item.name} amount`}
              />
              <button
                type="button"
                className="btn btn-danger"
                aria-label={`Delete ${item.name}`}
                onClick={() =>
                  patch({
                    immutable: budget.immutable.filter((x) => x.id !== item.id),
                  })
                }
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
        <div className="totals-bar">
          <span>
            Bills total: <strong>{formatMoney(math.immutableTotal)}</strong>
          </span>
          <span>
            After bills:{' '}
            <strong>{formatMoney(math.overFixed ? 0 : math.mutableBudgetTotal)}</strong>
          </span>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>3. Mutable spending (percent split)</h2>
            <p>Split what’s left after bills. Percents must add up to 100%.</p>
          </div>
          <button type="button" className="btn btn-primary" onClick={addMutable}>
            <Plus size={16} /> Add category
          </button>
        </div>

        {!math.percentOk && (
          <p className="hint warn">
            Your percentages add up to {math.percentTotal}%. They need to equal{' '}
            <strong>100%</strong>.
          </p>
        )}

        <div
          className="mutable-row"
          style={{
            background: 'transparent',
            border: 'none',
            padding: '0 0.65rem',
            color: 'var(--muted)',
            fontSize: '0.8rem',
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}
        >
          <span>Category</span>
          <span>% of leftover</span>
          <span style={{ textAlign: 'right' }}>Dollar amount</span>
          <span />
        </div>

        <div className="list">
          {budget.mutable.map((cat: MutableCategory) => (
            <div className="mutable-row" key={cat.id}>
              <input
                className="input"
                value={cat.name}
                onChange={(e) =>
                  patch({
                    mutable: budget.mutable.map((x) =>
                      x.id === cat.id ? { ...x, name: e.target.value } : x,
                    ),
                  })
                }
                aria-label="Category name"
              />
              <input
                className="input money"
                inputMode="decimal"
                value={cat.percent}
                onChange={(e) =>
                  patch({
                    mutable: budget.mutable.map((x) =>
                      x.id === cat.id
                        ? { ...x, percent: parseMoneyInput(e.target.value) }
                        : x,
                    ),
                  })
                }
                aria-label={`${cat.name} percent`}
              />
              <div className="amount-out">
                {formatMoney(math.mutableAmounts[cat.id] || 0)}
              </div>
              <div className="delete-slot">
                <button
                  type="button"
                  className="btn btn-danger"
                  aria-label={`Delete ${cat.name}`}
                  onClick={() =>
                    patch({
                      mutable: budget.mutable.filter((x) => x.id !== cat.id),
                      spending: budget.spending.filter((s) => s.categoryId !== cat.id),
                    })
                  }
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="totals-bar">
          <span>
            Percents: <strong>{math.percentTotal}%</strong>
          </span>
          <span>
            Leftover being split: <strong>{formatMoney(math.mutableBudgetTotal)}</strong>
          </span>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>4. What’s left in each category</h2>
            <p>Balances for this paycheck after logged purchases.</p>
          </div>
        </div>
        <div className="cat-grid">
          {budget.mutable.map((cat) => {
            const budgeted = math.mutableAmounts[cat.id] || 0
            const spent = math.spentByCategory[cat.id] || 0
            const left = math.remainingByCategory[cat.id] || 0
            const pct = budgeted > 0 ? Math.min(100, (spent / budgeted) * 100) : 0
            const over = left < 0
            return (
              <div className="cat-card" key={cat.id}>
                <h3>{cat.name}</h3>
                <div className="budgeted">
                  Budgeted {formatMoney(budgeted)} · Spent {formatMoney(spent)}
                </div>
                <div className={`left ${over ? 'neg' : ''}`}>
                  {over ? `${formatMoney(Math.abs(left))} over` : `${formatMoney(left)} left`}
                </div>
                <div className={`progress ${over ? 'over' : ''}`}>
                  <i style={{ width: `${over ? 100 : pct}%` }} />
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>5. Log spending</h2>
            <p>Purchases for {title}. Use store names so Statistics can tally them.</p>
          </div>
        </div>

        <div className="log-form">
          <label className="field">
            <span>Date</span>
            <input
              className="input"
              type="date"
              value={logDate}
              onChange={(e) => setLogDate(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Category</span>
            <select
              className="input"
              value={logCategoryId}
              onChange={(e) => setLogCategoryId(e.target.value)}
            >
              {budget.mutable.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Amount</span>
            <input
              className="input money"
              inputMode="decimal"
              placeholder="0.00"
              value={logAmount}
              onChange={(e) => setLogAmount(e.target.value)}
            />
          </label>
          <button type="button" className="btn btn-primary" onClick={addSpend}>
            <Plus size={16} /> Log it
          </button>
        </div>

        <div className="field-row" style={{ marginBottom: '0.9rem' }}>
          <label className="field">
            <span>Store / item name</span>
            <input
              className="input"
              placeholder="e.g. DoorDash, Smoke City, Costco"
              value={logMerchant}
              onChange={(e) => setLogMerchant(e.target.value)}
              list={`merchant-suggestions-${paycheckKey}`}
            />
            <datalist id={`merchant-suggestions-${paycheckKey}`}>
              {[
                ...new Set(
                  budget.spending
                    .map((s) => s.merchant)
                    .filter(Boolean)
                    .sort((a, b) => a.localeCompare(b)),
                ),
              ].map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </label>
          <label className="field">
            <span>Note (optional)</span>
            <input
              className="input"
              placeholder="e.g. lunch special"
              value={logNote}
              onChange={(e) => setLogNote(e.target.value)}
            />
          </label>
        </div>

        <div className="spend-list">
          {budget.spending.length === 0 ? (
            <div className="empty">No purchases logged on {title} yet.</div>
          ) : (
            budget.spending.map((entry) => (
              <div className="spend-item" key={entry.id}>
                <div>
                  <strong>
                    {entry.merchant || 'Unlabeled'} · {categoryName(entry.categoryId)}
                  </strong>
                  <p>
                    {entry.date}
                    {entry.note ? ` · ${entry.note}` : ''}
                  </p>
                </div>
                <strong>{formatMoney(entry.amount)}</strong>
                <button
                  type="button"
                  className="btn btn-danger"
                  aria-label="Delete purchase"
                  onClick={() =>
                    patch({
                      spending: budget.spending.filter((s) => s.id !== entry.id),
                    })
                  }
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Finish this paycheck</h2>
            <p>
              Save a full snapshot to History (pay, bills, splits, and spending). Your setup
              stays; the spending log clears for the next period.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              const suggested = defaultPeriodLabel(paycheckKey)
              const label = window.prompt(
                'Name this period for History (you can change it):',
                suggested,
              )
              if (label === null) return
              if (
                !confirm(
                  `Archive “${label.trim() || suggested}” and clear the spending log for a fresh ${title}?`,
                )
              ) {
                return
              }
              onArchive(label.trim() || suggested)
            }}
          >
            <Archive size={16} /> Archive & start new
          </button>
        </div>
        <p className="hint">
          Tip: do this when the next deposit hits. Past periods stay in the History tab;
          Statistics still counts archived purchases.
        </p>
      </section>
    </>
  )
}

function HistoryView({
  state,
  onDelete,
}: {
  state: BudgetState
  onDelete: (id: string) => void
}) {
  const [openId, setOpenId] = useState<string | null>(state.history[0]?.id ?? null)

  const grouped = useMemo(() => {
    const map = new Map<string, ArchivedPaycheck[]>()
    for (const entry of state.history) {
      const key = entry.archivedAt.slice(0, 7) || 'unknown'
      const list = map.get(key) ?? []
      list.push(entry)
      map.set(key, list)
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [state.history])

  const monthTitle = (ym: string) => {
    const [y, m] = ym.split('-').map(Number)
    if (!y || !m) return ym
    return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' })
  }

  return (
    <>
      <section className="hero-card">
        <div className="hero-grid">
          <div className="metric accent">
            <span>Archived periods</span>
            <strong>{state.history.length}</strong>
          </div>
          <div className="metric">
            <span>Latest</span>
            <strong style={{ fontSize: '1.15rem' }}>
              {state.history[0]?.periodLabel ?? 'None yet'}
            </strong>
          </div>
          <div className="metric warn">
            <span>How to add</span>
            <strong style={{ fontSize: '1.05rem' }}>Finish paycheck → Archive</strong>
          </div>
        </div>
        <p className="hint good">
          Look back at any past Paycheck 1 or 2 — budget setup and spending, frozen in time.
        </p>
      </section>

      {state.history.length === 0 ? (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>No history yet</h2>
              <p>
                When a pay period ends, open Paycheck 1 or 2 and tap{' '}
                <strong>Archive & start new</strong>. That snapshot shows up here.
              </p>
            </div>
          </div>
        </section>
      ) : (
        grouped.map(([ym, entries]) => (
          <section className="card" key={ym}>
            <div className="card-head">
              <div>
                <h2>{monthTitle(ym)}</h2>
                <p>
                  {entries.length} archived paycheck{entries.length === 1 ? '' : 's'}
                </p>
              </div>
            </div>
            <div className="history-list">
              {entries.map((entry) => {
                const math = computeBudget(entry.budget)
                const open = openId === entry.id
                return (
                  <div className={`history-item ${open ? 'open' : ''}`} key={entry.id}>
                    <button
                      type="button"
                      className="history-item-toggle"
                      onClick={() => setOpenId(open ? null : entry.id)}
                      aria-expanded={open}
                    >
                      <span className="history-item-main">
                        {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                        <span>
                          <strong>{entry.periodLabel}</strong>
                          <span className="meta">
                            {entry.label} · archived {entry.archivedAt} ·{' '}
                            {entry.budget.spending.length} purchase
                            {entry.budget.spending.length === 1 ? '' : 's'}
                          </span>
                        </span>
                      </span>
                      <span className="history-item-pay">{formatMoney(math.paycheck)}</span>
                    </button>
                    {open ? (
                      <div className="history-item-body">
                        <div className="hero-grid" style={{ marginBottom: '0.85rem' }}>
                          <div className="metric">
                            <span>Paycheck</span>
                            <strong>{formatMoney(math.paycheck)}</strong>
                          </div>
                          <div className="metric warn">
                            <span>Saved</span>
                            <strong>{formatMoney(math.savings)}</strong>
                          </div>
                          <div className="metric">
                            <span>Bills</span>
                            <strong>{formatMoney(math.immutableTotal)}</strong>
                          </div>
                          <div className={`metric ${math.overFixed ? 'danger' : 'accent'}`}>
                            <span>Left to split</span>
                            <strong>
                              {formatMoney(
                                math.overFixed ? math.shortfall : math.mutableBudgetTotal,
                              )}
                            </strong>
                          </div>
                          <div className="metric">
                            <span>Spent (flexible)</span>
                            <strong>{formatMoney(math.totalSpentMutable)}</strong>
                          </div>
                          <div
                            className={`metric ${math.totalRemainingMutable < 0 ? 'danger' : 'accent'}`}
                          >
                            <span>Left unspent</span>
                            <strong>{formatMoney(math.totalRemainingMutable)}</strong>
                          </div>
                        </div>

                        <h3 className="history-subhead">Bills</h3>
                        {entry.budget.immutable.length === 0 ? (
                          <p className="hint">No bills on this period.</p>
                        ) : (
                          <ul className="history-plain-list">
                            {entry.budget.immutable.map((bill) => (
                              <li key={bill.id}>
                                <span>{bill.name}</span>
                                <strong>{formatMoney(bill.amount)}</strong>
                              </li>
                            ))}
                          </ul>
                        )}

                        <h3 className="history-subhead">Flexible split</h3>
                        <ul className="history-plain-list">
                          {entry.budget.mutable.map((cat) => {
                            const budgeted = math.mutableAmounts[cat.id] || 0
                            const spent = math.spentByCategory[cat.id] || 0
                            return (
                              <li key={cat.id}>
                                <span>
                                  {cat.name}{' '}
                                  <span className="meta">
                                    {cat.percent}% · spent {formatMoney(spent)}
                                  </span>
                                </span>
                                <strong>{formatMoney(budgeted)}</strong>
                              </li>
                            )
                          })}
                        </ul>

                        <h3 className="history-subhead">Spending log</h3>
                        {entry.budget.spending.length === 0 ? (
                          <p className="hint">No purchases logged.</p>
                        ) : (
                          <ul className="history-plain-list">
                            {entry.budget.spending.map((spend) => {
                              const catName =
                                entry.budget.mutable.find((c) => c.id === spend.categoryId)
                                  ?.name ?? 'Category'
                              return (
                                <li key={spend.id}>
                                  <span>
                                    {spend.merchant || 'Unlabeled'} · {catName}
                                    <span className="meta">
                                      {' '}
                                      {spend.date}
                                      {spend.note ? ` · ${spend.note}` : ''}
                                    </span>
                                  </span>
                                  <strong>{formatMoney(spend.amount)}</strong>
                                </li>
                              )
                            })}
                          </ul>
                        )}

                        <div style={{ marginTop: '1rem' }}>
                          <button
                            type="button"
                            className="btn btn-danger"
                            onClick={() => {
                              if (
                                confirm(
                                  `Delete “${entry.periodLabel}” from History? This cannot be undone.`,
                                )
                              ) {
                                onDelete(entry.id)
                                setOpenId(null)
                              }
                            }}
                          >
                            <Trash2 size={16} /> Delete this period
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </section>
        ))
      )}
    </>
  )
}

function CashBoxView({
  state,
  onChange,
}: {
  state: BudgetState
  onChange: (cashBox: BudgetState['cashBox']) => void
}) {
  const [mode, setMode] = useState<CashTxType>('add')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')

  const submit = () => {
    const value = parseMoneyInput(amount)
    if (value <= 0 && mode !== 'set') return
    if (mode === 'set' && amount.trim() === '') return
    onChange(
      applyCashTransaction(state.cashBox, mode, value, note, todayISO()),
    )
    setAmount('')
    setNote('')
  }

  const modeLabel =
    mode === 'set' ? 'Set balance to' : mode === 'add' ? 'Add cash' : 'Spend cash'

  return (
    <>
      <section className="hero-card">
        <div className="hero-grid">
          <div className="metric accent">
            <span>Cash on hand</span>
            <strong>{formatMoney(state.cashBox.balance)}</strong>
          </div>
          <div className="metric">
            <span>Updates logged</span>
            <strong>{state.cashBox.history.length}</strong>
          </div>
          <div className="metric warn">
            <span>Last update</span>
            <strong style={{ fontSize: '1.2rem' }}>
              {state.cashBox.history[0]?.date ?? '—'}
            </strong>
          </div>
        </div>
        <p className="hint good">
          This is physical cash in your wallet / stash — separate from paycheck budgeting.
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Cash box</h2>
            <p>Record what you actually have in cash, then add or spend from it.</p>
          </div>
        </div>

        <div className="steps" style={{ marginBottom: '1rem' }}>
          <button
            type="button"
            className={`step-pill ${mode === 'set' ? 'active' : ''}`}
            onClick={() => setMode('set')}
          >
            Set balance
          </button>
          <button
            type="button"
            className={`step-pill ${mode === 'add' ? 'active' : ''}`}
            onClick={() => setMode('add')}
          >
            Add cash
          </button>
          <button
            type="button"
            className={`step-pill ${mode === 'spend' ? 'active' : ''}`}
            onClick={() => setMode('spend')}
          >
            Spend cash
          </button>
        </div>

        <div className="field-row">
          <label className="field">
            <span>{modeLabel}</span>
            <input
              className="input money"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Note (optional)</span>
            <input
              className="input"
              placeholder="e.g. ATM, tip jar, gas station"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        </div>

        <div className="toolbar" style={{ marginTop: '0.85rem' }}>
          <button type="button" className="btn btn-primary" onClick={submit}>
            <Wallet size={16} /> Save cash update
          </button>
        </div>

        <div className="spend-list" style={{ marginTop: '1.1rem' }}>
          {state.cashBox.history.length === 0 ? (
            <div className="empty">No cash updates yet.</div>
          ) : (
            state.cashBox.history.map((tx) => (
              <div className="spend-item" key={tx.id}>
                <div>
                  <strong>
                    {tx.type === 'set'
                      ? 'Set balance'
                      : tx.type === 'add'
                        ? 'Added cash'
                        : 'Spent cash'}
                  </strong>
                  <p>
                    {tx.date}
                    {tx.note ? ` · ${tx.note}` : ''} · balance {formatMoney(tx.balanceAfter)}
                  </p>
                </div>
                <strong>
                  {tx.type === 'spend' ? '−' : tx.type === 'add' ? '+' : ''}
                  {formatMoney(tx.amount)}
                </strong>
                <button
                  type="button"
                  className="btn btn-danger"
                  aria-label="Delete cash update"
                  onClick={() => {
                    const history = state.cashBox.history.filter((h) => h.id !== tx.id)
                    const balance = history[0]?.balanceAfter ?? 0
                    onChange({ balance, history })
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))
          )}
        </div>
      </section>
    </>
  )
}

function GoalsView({
  state,
  updateGoals,
}: {
  state: BudgetState
  updateGoals: (goals: SavingsGoal[]) => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(state.goals[0]?.id ?? null)
  const [depositAmount, setDepositAmount] = useState('')
  const [depositNote, setDepositNote] = useState('')

  useEffect(() => {
    if (!state.goals.find((g) => g.id === selectedId)) {
      setSelectedId(state.goals[0]?.id ?? null)
    }
  }, [state.goals, selectedId])

  const selected = state.goals.find((g) => g.id === selectedId) ?? null
  const saved = selected ? goalSaved(selected) : 0
  const progress = selected ? goalProgress(selected) : 0
  const remaining = selected ? money(Math.max(0, selected.target - saved)) : 0
  const complete = selected ? saved >= selected.target && selected.target > 0 : false

  const addGoal = () => {
    const goal: SavingsGoal = {
      id: createId(),
      name: 'New goal',
      target: 100,
      deposits: [],
    }
    updateGoals([...state.goals, goal])
    setSelectedId(goal.id)
  }

  const patchGoal = (id: string, patch: Partial<SavingsGoal>) => {
    updateGoals(state.goals.map((g) => (g.id === id ? { ...g, ...patch } : g)))
  }

  const addDeposit = () => {
    if (!selected) return
    const amount = parseMoneyInput(depositAmount)
    if (amount <= 0) return
    patchGoal(selected.id, {
      deposits: [
        {
          id: createId(),
          date: todayISO(),
          amount,
          note: depositNote.trim(),
        },
        ...selected.deposits,
      ],
    })
    setDepositAmount('')
    setDepositNote('')
  }

  return (
    <>
      <section className="hero-card">
        <div className="hero-grid">
          <div className="metric accent">
            <span>Active goals</span>
            <strong>{state.goals.length}</strong>
          </div>
          <div className="metric">
            <span>Total saved toward goals</span>
            <strong>
              {formatMoney(state.goals.reduce((sum, g) => sum + goalSaved(g), 0))}
            </strong>
          </div>
          <div className="metric warn">
            <span>Still to go (all goals)</span>
            <strong>
              {formatMoney(
                state.goals.reduce(
                  (sum, g) => sum + Math.max(0, money(g.target) - goalSaved(g)),
                  0,
                ),
              )}
            </strong>
          </div>
        </div>
        <p className="hint good">
          Make a tab for each thing you’re saving for. Add money anytime and watch the jar
          fill up.
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Savings goals</h2>
            <p>San Diego trip, GTA 6, emergency fund — one tab per goal.</p>
          </div>
          <button type="button" className="btn btn-primary" onClick={addGoal}>
            <Plus size={16} /> New goal
          </button>
        </div>

        {state.goals.length === 0 ? (
          <div className="empty">
            No goals yet. Tap <strong>New goal</strong> to start one.
          </div>
        ) : (
          <>
            <div className="goal-tabs" role="tablist" aria-label="Savings goals">
              {state.goals.map((goal) => {
                const pct = Math.round(goalProgress(goal))
                return (
                  <button
                    key={goal.id}
                    type="button"
                    role="tab"
                    aria-selected={goal.id === selectedId}
                    className={`goal-tab ${goal.id === selectedId ? 'active' : ''}`}
                    onClick={() => setSelectedId(goal.id)}
                  >
                    {goal.name || 'Untitled'}
                    <span className="mini">{pct}%</span>
                  </button>
                )
              })}
            </div>

            {selected && (
              <>
                <div className="goal-fields">
                  <label className="field">
                    <span>What are you saving for?</span>
                    <input
                      className="input"
                      value={selected.name}
                      onChange={(e) => patchGoal(selected.id, { name: e.target.value })}
                      placeholder="e.g. San Diego trip"
                    />
                  </label>
                  <label className="field">
                    <span>How much will it cost?</span>
                    <input
                      className="input money"
                      inputMode="decimal"
                      value={selected.target}
                      onChange={(e) =>
                        patchGoal(selected.id, {
                          target: parseMoneyInput(e.target.value),
                        })
                      }
                    />
                  </label>
                </div>

                <div className="goal-layout">
                  <div className="goal-jar" aria-hidden="true">
                    <div className="goal-jar-lid" />
                    <div className="goal-jar-glass">
                      <div
                        className={`goal-jar-fill ${complete ? 'complete' : ''}`}
                        style={{ height: `${progress}%` }}
                      />
                      <div className="goal-jar-label">{Math.round(progress)}%</div>
                    </div>
                  </div>

                  <div className="goal-stats">
                    <h3>{selected.name || 'Untitled goal'}</h3>
                    <p className="sub">
                      {complete
                        ? `You made it — ${formatMoney(saved)} saved toward ${formatMoney(selected.target)}.`
                        : `${formatMoney(saved)} saved · ${formatMoney(remaining)} to go · goal ${formatMoney(selected.target)}`}
                    </p>

                    <div className="deposit-form">
                      <label className="field">
                        <span>Add money</span>
                        <input
                          className="input money"
                          inputMode="decimal"
                          placeholder="25.00"
                          value={depositAmount}
                          onChange={(e) => setDepositAmount(e.target.value)}
                        />
                      </label>
                      <label className="field">
                        <span>Note (optional)</span>
                        <input
                          className="input"
                          placeholder="From paycheck 1"
                          value={depositNote}
                          onChange={(e) => setDepositNote(e.target.value)}
                        />
                      </label>
                      <button type="button" className="btn btn-primary" onClick={addDeposit}>
                        <Plus size={16} /> Add
                      </button>
                    </div>

                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={() => {
                        if (confirm(`Delete goal “${selected.name}”?`)) {
                          updateGoals(state.goals.filter((g) => g.id !== selected.id))
                        }
                      }}
                    >
                      <Trash2 size={16} /> Delete this goal
                    </button>
                  </div>
                </div>

                <div className="spend-list" style={{ marginTop: '0.85rem' }}>
                  {selected.deposits.length === 0 ? (
                    <div className="empty">No money added to this goal yet.</div>
                  ) : (
                    selected.deposits.map((d) => (
                      <div className="spend-item" key={d.id}>
                        <div>
                          <strong>Added {formatMoney(d.amount)}</strong>
                          <p>
                            {d.date}
                            {d.note ? ` · ${d.note}` : ''}
                          </p>
                        </div>
                        <strong>+{formatMoney(d.amount)}</strong>
                        <button
                          type="button"
                          className="btn btn-danger"
                          aria-label="Remove deposit"
                          onClick={() =>
                            patchGoal(selected.id, {
                              deposits: selected.deposits.filter((x) => x.id !== d.id),
                            })
                          }
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </>
        )}
      </section>
    </>
  )
}

function StatsView({ state }: { state: BudgetState }) {
  const years = useMemo(() => availableStatYears(state), [state])
  const [year, setYear] = useState(years[0] ?? new Date().getFullYear())
  const stats = useMemo(() => computeYearStats(state, year), [state, year])
  const maxMonth = Math.max(...stats.byMonth.map((m) => m.amount), 1)

  useEffect(() => {
    if (!years.includes(year) && years[0]) setYear(years[0])
  }, [years, year])

  return (
    <>
      <section className="hero-card">
        <div className="hero-grid">
          <div className="metric accent">
            <span>{year} total spent</span>
            <strong>{formatMoney(stats.total)}</strong>
          </div>
          <div className="metric">
            <span>Purchases logged</span>
            <strong>{stats.entryCount}</strong>
          </div>
          <div className="metric warn">
            <span>Unique stores / items</span>
            <strong>{stats.byMerchant.length}</strong>
          </div>
        </div>
        <p className="hint good">
          Totals include purchases from both Paycheck 1 and Paycheck 2 for the whole year.
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Statistics</h2>
            <p>Yearly scoreboard by store/item, category, and month.</p>
          </div>
        </div>
        <div className="stat-toolbar">
          <label className="field" style={{ minWidth: 160 }}>
            <span>Year</span>
            <select
              className="input"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
        </div>

        {stats.entryCount === 0 ? (
          <div className="empty">
            No purchases logged in {year} yet. Log spending on a paycheck tab to build
            stats.
          </div>
        ) : (
          <>
            <h3 style={{ margin: '0 0 0.65rem', fontFamily: 'var(--font-display)' }}>
              By store / item
            </h3>
            <div className="stat-list" style={{ marginBottom: '1.25rem' }}>
              {stats.byMerchant.map((row) => (
                <div className="stat-row" key={row.key}>
                  <div>
                    <div className="label">{row.label}</div>
                    <div className="meta">
                      {row.count} purchase{row.count === 1 ? '' : 's'} · {row.share.toFixed(0)}%
                      of yearly spend
                    </div>
                  </div>
                  <div className="amount">{formatMoney(row.amount)}</div>
                  <div className="stat-bar">
                    <i style={{ width: `${row.share}%` }} />
                  </div>
                </div>
              ))}
            </div>

            <h3 style={{ margin: '0 0 0.65rem', fontFamily: 'var(--font-display)' }}>
              By category
            </h3>
            <div className="stat-list" style={{ marginBottom: '1.25rem' }}>
              {stats.byCategory.map((row) => (
                <div className="stat-row" key={row.key}>
                  <div>
                    <div className="label">{row.label}</div>
                    <div className="meta">
                      {row.count} purchase{row.count === 1 ? '' : 's'} · {row.share.toFixed(0)}%
                      of yearly spend
                    </div>
                  </div>
                  <div className="amount">{formatMoney(row.amount)}</div>
                  <div className="stat-bar">
                    <i style={{ width: `${row.share}%` }} />
                  </div>
                </div>
              ))}
            </div>

            <h3 style={{ margin: '0 0 0.65rem', fontFamily: 'var(--font-display)' }}>
              By month
            </h3>
            <div className="month-grid">
              {stats.byMonth.map((m) => (
                <div className="month-cell" key={m.month}>
                  <span>{m.label}</span>
                  <strong>{formatMoney(m.amount)}</strong>
                  <div className="progress" style={{ marginTop: '0.45rem' }}>
                    <i style={{ width: `${(m.amount / maxMonth) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </>
  )
}

export default function App() {
  const [state, setState] = useState<BudgetState>(() => loadState())
  const [tab, setTab] = useState<MainTab>('p1')

  useEffect(() => {
    saveState(state)
  }, [state])

  const setPaycheck = (key: PaycheckKey, next: PaycheckBudget) => {
    setState((s) => ({
      ...s,
      paychecks: { ...s.paychecks, [key]: next },
    }))
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>Steady</h1>
          <p>
            Twice-a-month paycheck budgeting, cash on hand, savings jars, paycheck history,
            and a yearly spending scoreboard.
          </p>
        </div>
      </header>

      <nav className="main-tabs" aria-label="Main">
        <button
          type="button"
          className={`main-tab ${tab === 'p1' ? 'active' : ''}`}
          onClick={() => setTab('p1')}
        >
          Paycheck 1
        </button>
        <button
          type="button"
          className={`main-tab ${tab === 'p2' ? 'active' : ''}`}
          onClick={() => setTab('p2')}
        >
          Paycheck 2
        </button>
        <button
          type="button"
          className={`main-tab ${tab === 'cash' ? 'active' : ''}`}
          onClick={() => setTab('cash')}
        >
          <Banknote size={16} style={{ marginRight: 4 }} />
          Cash box
        </button>
        <button
          type="button"
          className={`main-tab ${tab === 'goals' ? 'active' : ''}`}
          onClick={() => setTab('goals')}
        >
          Goals
        </button>
        <button
          type="button"
          className={`main-tab ${tab === 'history' ? 'active' : ''}`}
          onClick={() => setTab('history')}
        >
          <History size={16} style={{ marginRight: 4 }} />
          History
        </button>
        <button
          type="button"
          className={`main-tab ${tab === 'stats' ? 'active' : ''}`}
          onClick={() => setTab('stats')}
        >
          Statistics
        </button>
      </nav>

      {tab === 'p1' || tab === 'p2' ? (
        <BudgetView
          paycheckKey={tab}
          budget={state.paychecks[tab]}
          onChange={(next) => setPaycheck(tab, next)}
          onResetAll={() => setState(createDefaultState())}
          onArchive={(periodLabel) => {
            setState((s) => archivePaycheckPeriod(s, tab, periodLabel))
            setTab('history')
          }}
        />
      ) : tab === 'cash' ? (
        <CashBoxView
          state={state}
          onChange={(cashBox) => setState((s) => ({ ...s, cashBox }))}
        />
      ) : tab === 'goals' ? (
        <GoalsView
          state={state}
          updateGoals={(goals) => setState((s) => ({ ...s, goals }))}
        />
      ) : tab === 'history' ? (
        <HistoryView
          state={state}
          onDelete={(id) =>
            setState((s) => ({
              ...s,
              history: s.history.filter((h) => h.id !== id),
            }))
          }
        />
      ) : (
        <StatsView state={state} />
      )}

      <p className="footer-note">Saved automatically in this browser. No account needed.</p>
    </div>
  )
}
