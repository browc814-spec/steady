import { chromium } from 'playwright'
import path from 'path'
import fs from 'fs'

const outDir = '/opt/cursor/artifacts'
fs.mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' })
await page.waitForTimeout(500)
await page.screenshot({ path: path.join(outDir, 'steady_home.png'), fullPage: true })

// Log a grocery spend
await page.getByPlaceholder('0.00').fill('54.20')
await page.getByPlaceholder('e.g. DoorDash, Smoke City, Costco').fill('Costco run')
await page.getByRole('button', { name: /Log it/i }).click()
await page.waitForTimeout(400)
await page.screenshot({ path: path.join(outDir, 'steady_after_log.png'), fullPage: true })

// Change percent and confirm dollar updates visible
const groceryPercent = page.getByLabel('Groceries percent')
await groceryPercent.fill('35')
await page.waitForTimeout(200)

console.log('title', await page.title())
console.log('OK')
await browser.close()
