import { chromium } from 'playwright'
import path from 'path'
import fs from 'fs'

const outDir = '/opt/cursor/artifacts'
fs.mkdirSync(outDir, { recursive: true })
const base = process.env.STEADY_URL || 'http://127.0.0.1:4175/'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })

page.on('dialog', async (dialog) => {
  if (dialog.type() === 'prompt') {
    await dialog.accept(dialog.defaultValue() || 'Oct 2026 · 1st half')
    return
  }
  await dialog.accept()
})

await page.goto(base, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: 'Paycheck 1' }).click()
await page.getByRole('button', { name: /Archive & start new/i }).click()
await page.waitForTimeout(400)

const historyTab = page.getByRole('button', { name: /History/i })
await historyTab.click()
await page.waitForTimeout(300)

const body = await page.locator('body').innerText()
if (!/Archived periods/i.test(body)) throw new Error('Missing History hero')
if (!/Oct 2026|1st half/i.test(body)) throw new Error('Missing archived period label')
if (!/DoorDash|Costco|Shell|Smoke City/i.test(body) && !body.includes('purchase')) {
  // detail may be collapsed — open first item
}

let openBody = await page.locator('body').innerText()
if (!/Flexible split/i.test(openBody)) {
  const toggle = page.locator('.history-item-toggle').first()
  if (await toggle.count()) {
    await toggle.click()
    await page.waitForTimeout(200)
  }
  openBody = await page.locator('body').innerText()
}
if (!/Flexible split/i.test(openBody)) throw new Error('Archive detail missing')
if (!/Spending log/i.test(openBody)) throw new Error('Spending log missing in archive')

// Spending should be cleared on Paycheck 1
await page.getByRole('button', { name: 'Paycheck 1', exact: true }).click()
await page.waitForTimeout(200)
const p1 = await page.locator('body').innerText()
if (/DoorDash/i.test(p1)) throw new Error('Spending should be cleared after archive')

await page.screenshot({ path: path.join(outDir, 'steady_history.png'), fullPage: true })
await page.getByRole('button', { name: /History/i }).click()
await page.waitForTimeout(200)
await page.screenshot({ path: path.join(outDir, 'steady_history_tab.png'), fullPage: true })

console.log('OK history archive flow')
await browser.close()
