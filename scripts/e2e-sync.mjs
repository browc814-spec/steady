/**
 * Two-device sync E2E: built app (vite preview) + local mock of the Apps Script endpoint
 * (sync/test/mock-server.mjs runs the real Code.gs through a shim).
 *
 *   npm run build && node scripts/e2e-sync.mjs
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APP_PORT = 4176
const MOCK_PORT = 8788
const APP = `http://127.0.0.1:${APP_PORT}/`
const MOCK = `http://127.0.0.1:${MOCK_PORT}/exec`
const TOKEN = 'e2e-token-' + 'x'.repeat(40)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'steady-e2e-'))
const procs = []

function start(cmd, args, ready) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    procs.push(p)
    let out = ''
    const onData = (d) => {
      out += d
      if (ready.test(out)) resolve(p)
    }
    p.stdout.on('data', onData)
    p.stderr.on('data', onData)
    p.on('exit', (code) => reject(new Error(`${cmd} exited ${code}: ${out}`)))
    setTimeout(() => reject(new Error(`timeout starting ${cmd}: ${out}`)), 20000).unref()
  })
}

let step = 0
let last = Date.now()
function ok(msg) {
  const now = Date.now()
  console.log(`  ✓ ${++step}. ${msg} (${((now - last) / 1000).toFixed(1)}s)`)
  last = now
}
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg)
}

const setupLink = (device) =>
  `${APP}#sync-url=${encodeURIComponent(MOCK)}&sync-token=${TOKEN}&sync-device=${device}`

const seedA = {
  paychecks: {
    p1: {
      label: 'Paycheck 1', paycheck: 2100, savings: 150,
      immutable: [{ id: 'bill-a1', name: 'Rent', amount: 700 }],
      mutable: [{ id: 'cat-a1', name: 'Groceries', percent: 60 }, { id: 'cat-a2', name: 'Fun', percent: 40 }],
      spending: [
        { id: 'sp-a1', date: '2026-09-28', categoryId: 'cat-a1', amount: 61.2, merchant: 'Safeway', note: 'fake' },
        { id: 'sp-a2', date: '2026-09-27', categoryId: 'cat-a2', amount: 15, merchant: 'Cinema', note: '' },
      ],
    },
    p2: {
      label: 'Paycheck 2', paycheck: 2100, savings: 150,
      immutable: [{ id: 'bill-a2', name: 'Phone', amount: 50 }],
      mutable: [{ id: 'cat-b1', name: 'Gas', percent: 100 }],
      spending: [],
    },
  },
  goals: [{ id: 'goal-car', name: 'Car fund', target: 3000, deposits: [{ id: 'dep-a0', date: '2026-09-01', amount: 100, note: '' }] }],
  cashBox: { balance: 40, history: [{ id: 'cash-a0', date: '2026-09-01', type: 'set', amount: 40, note: '', balanceAfter: 40 }] },
  history: [{
    id: 'arch-a0', paycheckKey: 'p2', label: 'Paycheck 2', periodLabel: 'Sep 2026 · 2nd half', archivedAt: '2026-09-30',
    budget: { label: 'Paycheck 2', paycheck: 2100, savings: 150, immutable: [], mutable: [{ id: 'cat-b1', name: 'Gas', percent: 100 }], spending: [{ id: 'sp-old', date: '2026-09-20', categoryId: 'cat-b1', amount: 44, merchant: 'Chevron', note: '' }] },
  }],
}

const seedC = structuredClone(seedA)
seedC.paychecks = {
  p1: { label: 'Paycheck 1', paycheck: 1600, savings: 200, immutable: [], mutable: [{ id: 'cat-c1', name: 'Snacks', percent: 100 }], spending: [{ id: 'sp-c1', date: '2026-09-10', categoryId: 'cat-c1', amount: 3.5, merchant: 'Vending', note: '' }] },
  p2: { label: 'Paycheck 2', paycheck: 1600, savings: 200, immutable: [], mutable: [], spending: [] },
}
seedC.goals = [{ id: 'goal-c', name: 'Bike', target: 400, deposits: [] }]
seedC.cashBox = { balance: 0, history: [] }
seedC.history = []

function canon(s) {
  const out = []
  for (const k of ['p1', 'p2']) {
    const p = s.paychecks[k]
    out.push(`${k}.label=${p.label}`, `${k}.paycheck=${p.paycheck}`, `${k}.savings=${p.savings}`)
    p.immutable.forEach((b) => out.push(`bill:${k}:${b.id}:${b.name}:${b.amount}`))
    p.mutable.forEach((c) => out.push(`cat:${k}:${c.id}:${c.name}:${c.percent}`))
    p.spending.forEach((x) => out.push(`spend:${k}:${x.id}:${x.amount}:${x.merchant}:${x.date}`))
  }
  s.goals.forEach((g) => {
    out.push(`goal:${g.id}:${g.name}:${g.target}`)
    g.deposits.forEach((d) => out.push(`dep:${g.id}:${d.id}:${d.amount}`))
  })
  s.cashBox.history.forEach((t) => out.push(`cash:${t.id}:${t.type}:${t.amount}`))
  out.push(`cashBalance=${s.cashBox.balance}`)
  s.history.forEach((h) => out.push(`arch:${h.id}:${h.budget.spending.map((x) => x.id).sort().join(',')}`))
  return out.sort().join('\n')
}

async function newDevice(browser, { seed, raw } = {}) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, acceptDownloads: true })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  if (seed || raw) {
    await context.addInitScript(({ value }) => {
      if (!localStorage.getItem('e2e-seeded')) {
        localStorage.setItem('steady-budget-v5', value)
        localStorage.setItem('e2e-seeded', '1')
      }
    }, { value: raw ?? JSON.stringify(seed) })
  }
  const page = await context.newPage()
  page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept(d.defaultValue()) : d.accept()))
  page.on('pageerror', (e) => console.error('PAGE ERROR', e))
  return { context, page }
}

const readState = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('steady-budget-v5')))
const keys = (page) => page.evaluate(() => Object.keys(localStorage))

async function waitSynced(page, timeout = 20000) {
  await page.waitForTimeout(150)
  await page.waitForFunction(() => {
    const b = document.querySelector('[data-testid=sync-badge]')
    return b && b.dataset.status === 'idle' && b.dataset.pending === '0'
  }, null, { timeout })
}

async function pullNow(page) {
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await waitSynced(page)
}

async function waitState(page, predicateSrc, arg, timeout = 15000) {
  await page.waitForFunction(
    ([src, a]) => {
      const s = JSON.parse(localStorage.getItem('steady-budget-v5'))
      return new Function('s', 'a', `return (${src})(s, a)`)(s, a)
    },
    [predicateSrc, arg],
    { timeout },
  )
}

async function remoteItems() {
  const res = await fetch(`http://127.0.0.1:${MOCK_PORT}/__admin/table?sheet=Items`)
  return res.json()
}

async function tab(page, name) {
  await page.getByRole('button', { name, exact: true }).click()
}

async function logSpend(page, amount, merchant) {
  await tab(page, 'Paycheck 1')
  await page.getByPlaceholder('0.00').fill(String(amount))
  await page.getByPlaceholder('e.g. DoorDash, Smoke City, Costco').fill(merchant)
  await page.getByRole('button', { name: /Log it/ }).click()
}

async function addDeposit(page, amount) {
  await tab(page, 'Goals')
  await page.getByPlaceholder('25.00').fill(String(amount))
  await page.getByRole('button', { name: 'Add', exact: true }).click()
}

async function cash(page, mode, amount) {
  await page.getByRole('button', { name: /Cash box/ }).click()
  await page.getByRole('button', { name: mode, exact: true }).click()
  await page.getByPlaceholder('0.00').fill(String(amount))
  await page.getByRole('button', { name: /Save cash update/ }).click()
}

async function main() {
  console.log('Starting mock endpoint + preview…')
  await start('node', ['sync/test/mock-server.mjs', '--port', String(MOCK_PORT), '--data', path.join(tmp, 'sheet.json'), '--token', TOKEN], /mock sync endpoint/)
  await start('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(APP_PORT), '--strictPort'], /Local:/)

  const browser = await chromium.launch({ headless: true })

  // ---------------- Device A: existing v5 data, first sync via setup link → upload
  const A = await newDevice(browser, { seed: seedA })
  await A.page.goto(setupLink('phone'))
  await waitSynced(A.page)
  assert(!A.page.url().includes('#'), 'setup fragment stripped from URL')
  assert(!A.page.url().includes(TOKEN), 'token not in URL')
  const aKeys = await keys(A.page)
  assert(aKeys.some((k) => k.startsWith('steady-budget-presync-')), 'presync backup key created')
  const presync = await A.page.evaluate(() => localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('steady-budget-presync-'))))
  assert(canon(JSON.parse(presync)) === canon(seedA), 'presync backup equals original data')
  let items = await remoteItems()
  assert(items.some((r) => r.id === 'sp-a1' && r.json.includes('Safeway')), 'remote has seeded spend')
  assert(items.some((r) => r.id === 'arch-a0'), 'remote has archive')
  assert(canon(await readState(A.page)) === canon(seedA), 'A data unchanged by first sync')
  ok('Device A: existing localStorage migrated & uploaded on first sync; presync backup kept; fragment stripped')

  // Reset demo disabled while sync is on
  await tab(A.page, 'Paycheck 1')
  assert(await A.page.getByRole('button', { name: /Reset demo/ }).isDisabled(), 'Reset demo disabled with sync on')
  ok('Reset demo is disabled while sync is on')

  // ---------------- Device B: fresh (pristine demo) → adopts remote
  const B = await newDevice(browser)
  await B.page.goto(setupLink('laptop'))
  await waitSynced(B.page)
  assert(canon(await readState(B.page)) === canon(await readState(A.page)), 'B adopted A data')
  items = await remoteItems()
  assert(!items.some((r) => r.json.includes('DoorDash')), 'demo data never uploaded')
  ok('Device B: pristine demo adopted the synced data; demo not uploaded')

  // ---------------- Online edit propagates
  await logSpend(A.page, 9.99, 'Online Shop')
  await waitSynced(A.page)
  await pullNow(B.page)
  await waitState(B.page, '(s) => s.paychecks.p1.spending.some((x) => x.merchant === "Online Shop")')
  ok('Online spend on A appears on B after focus pull')

  // ---------------- Offline edits on both sides, then converge
  await A.context.setOffline(true)
  await logSpend(A.page, 12, 'Offline A')
  await addDeposit(A.page, 25)
  await cash(A.page, 'Add cash', 20)
  await A.page.waitForFunction(() => {
    const b = document.querySelector('[data-testid=sync-badge]')
    return b.dataset.status === 'offline' && Number(b.dataset.pending) >= 3
  }, null, { timeout: 10000 }).catch(async () => {
    // status may still be idle until the debounced push notices; force a cycle
    await A.page.evaluate(() => window.dispatchEvent(new Event('focus')))
  })
  const badgeA = await A.page.getByTestId('sync-badge').getAttribute('data-pending')
  assert(Number(badgeA) >= 3, `A has queued changes while offline (pending=${badgeA})`)
  ok(`A offline: 3 edits queued (pending=${badgeA})`)

  await addDeposit(B.page, 50)
  await tab(B.page, 'Paycheck 1')
  await B.page.locator('.spend-item').filter({ hasText: 'Safeway' }).getByRole('button', { name: 'Delete purchase' }).click()
  await cash(B.page, 'Spend cash', 5)
  await waitSynced(B.page)
  ok('B online: deposit on same goal, deleted a spend, cash spend → pushed')

  await A.context.setOffline(false)
  await waitSynced(A.page)
  await pullNow(B.page)
  await pullNow(A.page)
  const sA = await readState(A.page)
  const sB = await readState(B.page)
  assert(canon(sA) === canon(sB), 'A and B converged\nA:\n' + canon(sA) + '\nB:\n' + canon(sB))
  const deps = sA.goals.find((g) => g.id === 'goal-car').deposits.map((d) => d.amount).sort((x, y) => x - y)
  assert(JSON.stringify(deps) === '[25,50,100]', 'both deposits kept: ' + deps)
  assert(!sA.paychecks.p1.spending.some((x) => x.id === 'sp-a1'), 'deleted spend gone on A')
  assert(sA.paychecks.p1.spending.some((x) => x.merchant === 'Offline A'), 'offline spend kept')
  assert(sA.cashBox.balance === 55 && sB.cashBox.balance === 55, `cash replayed to 55 (A ${sA.cashBox.balance}, B ${sB.cashBox.balance})`)
  ok('After reconnect: converged; both deposits kept; delete propagated; cash balance replayed to $55')

  // ---------------- Archive on A → B
  await tab(A.page, 'Paycheck 1')
  await A.page.getByRole('button', { name: /Archive & start new/ }).click()
  await waitSynced(A.page)
  await pullNow(B.page)
  await waitState(B.page, '(s) => s.history.length === 2 && s.paychecks.p1.spending.length === 0')
  ok('Archive on A shows in B History; B Paycheck 1 log cleared')

  // ---------------- Multi-tab on A
  const A2 = await A.context.newPage()
  A2.on('dialog', (d) => d.accept())
  await A2.goto(APP)
  await waitSynced(A2)
  await logSpend(A2, 4.2, 'Second Tab')
  await tab(A.page, 'Paycheck 1')
  await A.page.getByText('Second Tab').first().waitFor({ timeout: 10000 })
  await waitSynced(A2)
  await A2.close()
  ok('Multi-tab: edit in a second tab appears in the first tab (storage event)')

  // ---------------- Device C: own data → confirm → merge
  const C = await newDevice(browser, { seed: seedC })
  await C.page.goto(setupLink('tablet'))
  await C.page.getByTestId('first-sync-dialog').waitFor({ timeout: 15000 })
  assert((await keys(C.page)).some((k) => k.startsWith('steady-budget-presync-')), 'C presync backup')
  await C.page.getByRole('button', { name: 'Merge', exact: true }).click()
  await waitSynced(C.page)
  await pullNow(A.page)
  await pullNow(B.page)
  const sC = await readState(C.page)
  const sA2 = await readState(A.page)
  assert(canon(sA2) === canon(sC) && canon(sC) === canon(await readState(B.page)), 'A, B, C converged after merge')
  assert(sA2.paychecks.p1.spending.some((x) => x.id === 'sp-c1'), 'C-only spend merged into A')
  assert(sA2.goals.some((g) => g.id === 'goal-c') && sA2.goals.some((g) => g.id === 'goal-car'), 'goals unioned')
  assert(sA2.paychecks.p1.paycheck === 2100, 'synced copy won on shared paycheck field')
  ok('Device C (own data): confirmation dialog → merge by id; everyone converged')

  // ---------------- Agent Inbox row
  const catId = sA2.paychecks.p1.mutable[0].id
  await fetch(`http://127.0.0.1:${MOCK_PORT}/__admin/inbox`, {
    method: 'POST',
    body: JSON.stringify({ rows: [['inbox-1', 'spend', 'p1', 'upsert', JSON.stringify({ date: '2026-10-02', categoryId: catId, amount: 7.25, merchant: 'Tammy Added' }), new Date().toISOString(), 'tammy', '']] }),
  })
  await pullNow(B.page)
  await waitState(B.page, '(s) => s.paychecks.p1.spending.some((x) => x.id === "inbox-1" && x.amount === 7.25)')
  const inbox = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__admin/table?sheet=Inbox`)).json()
  assert(/^\d{4}-/.test(String(inbox[0].processedAt)), 'Inbox row marked processed')
  ok('Agent Inbox row folded by the endpoint and pulled by B; processedAt set')

  // ---------------- Export / import
  await tab(A.page, 'Settings')
  const [download] = await Promise.all([A.page.waitForEvent('download'), A.page.getByTestId('export-json').click()])
  const exportPath = path.join(tmp, 'export.json')
  await download.saveAs(exportPath)
  const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'))
  assert(exported.kind === 'steady-backup' && canon(exported.state) === canon(await readState(A.page)), 'export matches state')
  const E = await newDevice(browser)
  await E.page.goto(APP)
  await tab(E.page, 'Settings')
  await E.page.getByTestId('import-json').setInputFiles(exportPath)
  await E.page.getByTestId('import-replace').click()
  await waitState(E.page, '(s, n) => s.paychecks.p1.spending.length === n', exported.state.paychecks.p1.spending.length)
  assert(canon(await readState(E.page)) === canon(exported.state), 'import replace restores exact data')
  await E.page.getByTestId('import-json').setInputFiles(exportPath)
  await E.page.getByTestId('import-merge').click()
  await E.page.waitForTimeout(300)
  assert(canon(await readState(E.page)) === canon(exported.state), 'import merge of same data is idempotent')
  ok('JSON export → import (replace and merge) round-trips exactly')

  // ---------------- Corrupt localStorage is never overwritten
  const D = await newDevice(browser, { raw: '{"paychecks": broken' })
  await D.page.goto(APP)
  await D.page.getByTestId('load-error').waitFor({ timeout: 10000 })
  await logSpend(D.page, 1, 'Should not save')
  await D.page.waitForTimeout(500)
  const dRaw = await D.page.evaluate(() => localStorage.getItem('steady-budget-v5'))
  assert(dRaw === '{"paychecks": broken', 'corrupt data not overwritten')
  const dKeys = await keys(D.page)
  const corruptKey = dKeys.find((k) => k.startsWith('steady-budget-corrupt-'))
  assert(corruptKey && (await D.page.evaluate((k) => localStorage.getItem(k), corruptKey)) === dRaw, 'raw copy kept in backup key')
  ok('Unreadable saved data: error banner shown, original kept + backed up, no overwrite')

  // ---------------- Final no-data-loss check against the store
  items = await remoteItems()
  const live = new Set(items.filter((r) => r.deleted !== true && r.deleted !== 'TRUE').map((r) => r.id))
  for (const id of ['bill-a1', 'bill-a2', 'cat-a1', 'cat-a2', 'cat-b1', 'goal-car', 'dep-a0', 'cash-a0', 'arch-a0', 'goal-c', 'sp-c1', 'inbox-1']) {
    assert(live.has(id), `remote still has ${id}`)
  }
  const deleted = items.find((r) => r.id === 'sp-a1')
  assert(deleted && String(deleted.deleted).toUpperCase() === 'TRUE', 'sp-a1 tombstoned, not dropped')
  await pullNow(A.page)
  await pullNow(B.page)
  await pullNow(C.page)
  const final = canon(await readState(A.page))
  assert(final === canon(await readState(B.page)) && final === canon(await readState(C.page)), 'final convergence')
  ok('Store keeps every live item and a tombstone for the deleted one; all devices identical')

  const t = Date.now()
  await browser.close()
  console.log(`  (browser closed in ${((Date.now() - t) / 1000).toFixed(1)}s)`)
  console.log(`\nE2E sync: all ${step} checks passed`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => {
    for (const p of procs) {
      try {
        process.kill(-p.pid, 'SIGTERM') // whole process group (npx → vite)
      } catch {
        /* already gone */
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true })
    setTimeout(() => process.exit(process.exitCode ?? 0), 200)
  })
