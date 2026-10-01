import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, RotateCcw } from 'lucide-react'
import type { BudgetState, MutableCategory, SavingsGoal, SpendEntry } from './types'
import {
  availableStatYears,
  computeBudget,
  computeYearStats,
  createDefaultState,
  createId,
  formatMoney,
  goalProgress,
  goalSaved,
  loadState,
  money,
  saveState,
} from './math'

type MainTab = 'budget' | 'goals' | 'stats'

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

function parseMoneyInput(value: string) {
  const cleaned = value.replace(/[^0-9.]/g, '')
  const n = Number(cleaned)
  return Number.isFinite(n) ? money(n) : 0
}

function BudgetView({
  state,
  math,
  update,
  onReset,
}: {
  state: BudgetState
  math: ReturnType<typeof computeBudget>
  update: (patch: Partial<BudgetState>) => void
  onReset: () => void
}) {
  const [logDate, setLogDate] = useState(todayISO)
  const [logCategoryId, setLogCategoryId] = useState('')
  const [logAmount, setLogAmount] = useState('')
  const [logMerchant, setLogMerchant] = useState('')
  const [logNote, setLogNote] = useState('')

  useEffect(() => {
    if (!logCategoryId && state.mutable[0]) {
      setLogCategoryId(state.mutable[0].id)
    } else if (logCategoryId && !state.mutable.find((c) => c.id === logCategoryId)) {
      setLogCategoryId(state.mutable[0]?.id ?? '')
    }
  }, [state.mutable, logCategoryId])

  const addImmutable = () => {
    update({
      immutable: [...state.immutable, { id: createId(), name: 'New bill', amount: 0 }],
    })
  }

  const addMutable = () => {
    update({
      mutable: [...state.mutable, { id: createId(), name: 'New category', percent: 0 }],
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
    update({ spending: [entry, ...state.spending] })
    setLogAmount('')
    setLogMerchant('')
    setLogNote('')
  }

  const categoryName = (id: string) =>
    state.mutable.find((c) => c.id === id)?.name ?? 'Unknown'

  const stepsDone = {
    pay: state.paycheck > 0,
    save: true,
    fixed: state.immutable.length > 0,
    split: math.percentOk && !math.overFixed,
  }

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
            <span>Paycheck</span>
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
            Your savings + bills are bigger than your paycheck by{' '}
            {formatMoney(math.shortfall)}. Lower savings or a bill amount to continue.
          </p>
        ) : (
          <p className="hint good">
            After savings and bills, you have {formatMoney(math.mutableBudgetTotal)} to
            split across groceries, gas, fun, and the rest.
          </p>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>1. Your paycheck</h2>
            <p>Type what hits your bank this pay period. Just the number.</p>
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              if (confirm('Reset everything back to the starter example?')) {
                onReset()
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
              value={state.paycheck}
              onChange={(e) => update({ paycheck: parseMoneyInput(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>I want to save</span>
            <input
              className="input money"
              inputMode="decimal"
              value={state.savings}
              onChange={(e) => update({ savings: parseMoneyInput(e.target.value) })}
            />
          </label>
        </div>
        <p className="hint">
          After saving {formatMoney(math.savings)}, you have{' '}
          <strong>{formatMoney(math.afterSavings)}</strong> left for bills and spending.
          Tip: move some of that savings into a Goals tab below.
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>2. Immutable spending</h2>
            <p>Rent, bills, debt, subscriptions — stuff that doesn’t change much.</p>
          </div>
          <button type="button" className="btn btn-primary" onClick={addImmutable}>
            <Plus size={16} /> Add bill
          </button>
        </div>
        <div className="list">
          {state.immutable.map((item) => (
            <div className="list-row" key={item.id}>
              <input
                className="input"
                value={item.name}
                onChange={(e) =>
                  update({
                    immutable: state.immutable.map((x) =>
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
                  update({
                    immutable: state.immutable.map((x) =>
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
                  update({
                    immutable: state.immutable.filter((x) => x.id !== item.id),
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
            <p>
              Tell Steady what % of the leftover each category gets. It fills in the dollar
              amounts for you.
            </p>
          </div>
          <button type="button" className="btn btn-primary" onClick={addMutable}>
            <Plus size={16} /> Add category
          </button>
        </div>

        {!math.percentOk && (
          <p className="hint warn">
            Your percentages add up to {math.percentTotal}%. They need to equal{' '}
            <strong>100%</strong> before this is ready.
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
          {state.mutable.map((cat: MutableCategory) => (
            <div className="mutable-row" key={cat.id}>
              <input
                className="input"
                value={cat.name}
                onChange={(e) =>
                  update({
                    mutable: state.mutable.map((x) =>
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
                  update({
                    mutable: state.mutable.map((x) =>
                      x.id === cat.id
                        ? { ...x, percent: parseMoneyInput(e.target.value) }
                        : x,
                    ),
                  })
                }
                aria-label={`${cat.name} percent`}
              />
              <div className="amount-out" aria-label={`${cat.name} budgeted amount`}>
                {formatMoney(math.mutableAmounts[cat.id] || 0)}
              </div>
              <div className="delete-slot">
                <button
                  type="button"
                  className="btn btn-danger"
                  aria-label={`Delete ${cat.name}`}
                  onClick={() => {
                    update({
                      mutable: state.mutable.filter((x) => x.id !== cat.id),
                      spending: state.spending.filter((s) => s.categoryId !== cat.id),
                    })
                  }}
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
            <p>Live balances after your logged purchases.</p>
          </div>
        </div>
        <div className="cat-grid">
          {state.mutable.map((cat) => {
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
        <div className="totals-bar">
          <span>
            Spent from flexible budget:{' '}
            <strong>{formatMoney(math.totalSpentMutable)}</strong>
          </span>
          <span>
            Still available: <strong>{formatMoney(math.totalRemainingMutable)}</strong>
          </span>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>5. Log spending</h2>
            <p>
              Bought something? Add the store/item name (DoorDash, Smoke City, Costco…) so
              Statistics can tally it all year.
            </p>
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
              {state.mutable.map((cat) => (
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
              list="merchant-suggestions"
            />
            <datalist id="merchant-suggestions">
              {[
                ...new Set(
                  state.spending
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
          {state.spending.length === 0 ? (
            <div className="empty">No purchases logged yet.</div>
          ) : (
            state.spending.map((entry) => (
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
                    update({
                      spending: state.spending.filter((s) => s.id !== entry.id),
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
    </>
  )
}

function GoalsView({
  state,
  update,
}: {
  state: BudgetState
  update: (patch: Partial<BudgetState>) => void
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
    update({ goals: [...state.goals, goal] })
    setSelectedId(goal.id)
  }

  const patchGoal = (id: string, patch: Partial<SavingsGoal>) => {
    update({
      goals: state.goals.map((g) => (g.id === id ? { ...g, ...patch } : g)),
    })
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
                          placeholder="From this paycheck"
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
                          update({
                            goals: state.goals.filter((g) => g.id !== selected.id),
                          })
                        }
                      }}
                    >
                      <Trash2 size={16} /> Delete this goal
                    </button>
                  </div>
                </div>

                <div className="totals-bar">
                  <span>
                    Progress: <strong>{Math.round(progress)}%</strong>
                  </span>
                  <span>
                    Deposits: <strong>{selected.deposits.length}</strong>
                  </span>
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
          Every logged purchase piles up here for the year — by category and by store/item
          name (DoorDash, Smoke City, and anything else you type).
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Statistics</h2>
            <p>Pick a year. Steady totals everything you logged in that year.</p>
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
            No purchases logged in {year} yet. Log spending on the paycheck tab with a store
            / item name to start building stats.
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
  const [tab, setTab] = useState<MainTab>('budget')
  const math = useMemo(() => computeBudget(state), [state])

  useEffect(() => {
    saveState(state)
  }, [state])

  const update = (patch: Partial<BudgetState>) => setState((s) => ({ ...s, ...patch }))

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>Steady</h1>
          <p>
            Idiot-proof paycheck budgeting, savings goal jars, and a year-long spending
            scoreboard.
          </p>
        </div>
      </header>

      <nav className="main-tabs" aria-label="Main">
        <button
          type="button"
          className={`main-tab ${tab === 'budget' ? 'active' : ''}`}
          onClick={() => setTab('budget')}
        >
          This paycheck
        </button>
        <button
          type="button"
          className={`main-tab ${tab === 'goals' ? 'active' : ''}`}
          onClick={() => setTab('goals')}
        >
          Savings goals
        </button>
        <button
          type="button"
          className={`main-tab ${tab === 'stats' ? 'active' : ''}`}
          onClick={() => setTab('stats')}
        >
          Statistics
        </button>
      </nav>

      {tab === 'budget' ? (
        <BudgetView
          state={state}
          math={math}
          update={update}
          onReset={() => setState(createDefaultState())}
        />
      ) : tab === 'goals' ? (
        <GoalsView state={state} update={update} />
      ) : (
        <StatsView state={state} />
      )}

      <p className="footer-note">Saved automatically in this browser. No account needed.</p>
    </div>
  )
}
