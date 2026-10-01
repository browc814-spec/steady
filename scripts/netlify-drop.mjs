import { chromium } from 'playwright'
import path from 'path'
import fs from 'fs'

const zipPath = '/tmp/steady-dist.zip'
const outDir = '/opt/cursor/artifacts'
fs.mkdirSync(outDir, { recursive: true })

if (!fs.existsSync(zipPath)) {
  console.error('Missing zip', zipPath)
  process.exit(1)
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })

await page.goto('https://app.netlify.com/drop', { waitUntil: 'domcontentloaded', timeout: 90000 })
await page.waitForTimeout(3000)
await page.screenshot({ path: path.join(outDir, 'steady_netlify_drop_page.png') })

const inputs = page.locator('input[type="file"]')
const count = await inputs.count()
console.log('file inputs:', count)
console.log('url:', page.url())
console.log('title:', await page.title())

if (count === 0) {
  console.log((await page.locator('body').innerText()).slice(0, 800))
  await browser.close()
  process.exit(2)
}

await inputs.first().setInputFiles(zipPath)
console.log('uploaded zip, waiting for deploy...')

const link = page.locator('a[href*=".netlify.app"]').first()
try {
  await link.waitFor({ timeout: 180000 })
  const href = await link.getAttribute('href')
  console.log('DEPLOY_URL=' + href)
  await page.screenshot({ path: path.join(outDir, 'steady_netlify_drop_success.png') })
  // Also capture any claim/site text
  console.log('BODY_SNIP:', (await page.locator('body').innerText()).slice(0, 600))
} catch (e) {
  await page.screenshot({ path: path.join(outDir, 'steady_netlify_drop_timeout.png') })
  console.log('Timed out:', e.message)
  console.log((await page.locator('body').innerText()).slice(0, 1200))
}

await browser.close()
