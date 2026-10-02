#!/usr/bin/env node
/**
 * Local stand-in for the deployed Apps Script web app. Runs the REAL Code.gs through the shim
 * and persists the simulated spreadsheet to a JSON file.
 *
 *   node sync/test/mock-server.mjs --port 8787 --data sync/test/.data/sheet.json --token <token>
 *
 * Like Apps Script: POST bodies are text, responses carry Access-Control-Allow-Origin: *,
 * and OPTIONS preflights are NOT supported (so a client that triggers one fails here too).
 * Test-only admin routes under /__admin/ (not part of the real protocol).
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createGasEnv } from './gas-shim.mjs'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
)
const port = Number(args.port || 8787)
const dataFile = path.resolve(args.data || 'sync/test/.data/sheet.json')
const token = args.token || process.env.STEADY_SYNC_TOKEN || 'test-token-0123456789abcdef0123456789'

function load() {
  const data = fs.existsSync(dataFile) ? JSON.parse(fs.readFileSync(dataFile, 'utf8')) : null
  const env = createGasEnv({ token, data })
  return env
}
function save(env) {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true })
  fs.writeFileSync(dataFile, JSON.stringify(env.serialize()))
}

let offline = false
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    const url = new URL(req.url, 'http://x')
    const send = (status, obj, cors = true) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...(cors ? { 'Access-Control-Allow-Origin': '*' } : {}) })
      res.end(typeof obj === 'string' ? obj : JSON.stringify(obj))
    }
    try {
      if (url.pathname.startsWith('/__admin/')) {
        const env = load()
        if (url.pathname === '/__admin/table') return send(200, env.table(url.searchParams.get('sheet')))
        if (url.pathname === '/__admin/inbox' && req.method === 'POST') {
          const { rows, parse } = JSON.parse(body)
          env.ensure = env.ctx.setup()
          env.sheet('Inbox').externalAppend(rows, !!parse)
          save(env)
          return send(200, { ok: true })
        }
        if (url.pathname === '/__admin/process' && req.method === 'POST') {
          env.run('processInbox')
          save(env)
          return send(200, { ok: true })
        }
        if (url.pathname === '/__admin/offline' && req.method === 'POST') {
          offline = JSON.parse(body).offline === true
          return send(200, { ok: true, offline })
        }
        return send(404, { error: 'no such admin route' })
      }
      if (offline) {
        req.socket.destroy()
        return
      }
      if (req.method === 'OPTIONS') return send(405, 'Method OPTIONS not allowed', false)
      const env = load()
      if (req.method === 'GET') return send(200, env.get())
      if (req.method === 'POST') {
        const out = env.post(body)
        save(env)
        return send(200, out)
      }
      send(405, { error: 'method' })
    } catch (e) {
      send(500, { ok: false, error: 'mock_crash', message: String(e && e.message) })
    }
  })
})
server.listen(port, '127.0.0.1', () => console.log(`mock sync endpoint on http://127.0.0.1:${port}/exec (data: ${dataFile})`))
