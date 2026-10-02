/**
 * Minimal Google Apps Script runtime shim to execute sync/apps-script/Code.gs in Node.
 * Simulates: SpreadsheetApp (container-bound), LockService, PropertiesService, ContentService,
 * Utilities.formatDate, ScriptApp triggers. Range.setValues throws on dimension mismatch like
 * the real service, and strings that look like dates are converted to Date objects unless the
 * column is formatted as plain text ('@'), mimicking Sheets' parsing.
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const CODE_PATH = path.resolve(here, '../apps-script/Code.gs')
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z?)?$/

class Sheet {
  constructor(env, name, rows = [], textCols = []) {
    this.env = env
    this.name = name
    this.rows = rows
    this.textCols = new Set(textCols)
    this.frozen = 0
  }
  getName() { return this.name }
  getLastRow() {
    for (let r = this.rows.length - 1; r >= 0; r--) {
      if ((this.rows[r] || []).some((v) => v !== '' && v != null)) return r + 1
    }
    return 0
  }
  getLastColumn() {
    let max = 0
    for (const row of this.rows) {
      if (!row) continue
      for (let c = row.length - 1; c >= 0; c--) if (row[c] !== '' && row[c] != null) { max = Math.max(max, c + 1); break }
    }
    return max
  }
  getMaxRows() { return Math.max(1000, this.rows.length) }
  setFrozenRows(n) { this.frozen = n }
  clearContents() { this.rows = [] }
  getRange(row, col, numRows = 1, numCols = 1) {
    if (typeof row !== 'number') throw new Error('shim supports numeric getRange only')
    if (row < 1 || col < 1 || numRows < 1 || numCols < 1) throw new Error(`Invalid range ${row},${col},${numRows},${numCols}`)
    return new Range(this, row, col, numRows, numCols)
  }
  /** External append (e.g. the agent via the Sheets API). parse=true mimics USER_ENTERED. */
  externalAppend(values, parse = false) {
    const start = this.getLastRow()
    values.forEach((v, i) => {
      this.rows[start + i] = v.map((x, c) => (parse ? this.env.parse(x, this.textCols.has(c + 1)) : x))
    })
  }
}

class Range {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols })
  }
  getValues() {
    const out = []
    for (let r = 0; r < this.numRows; r++) {
      const src = this.sheet.rows[this.row - 1 + r] || []
      const line = []
      for (let c = 0; c < this.numCols; c++) {
        const v = src[this.col - 1 + c]
        line.push(v === undefined || v === null ? '' : v)
      }
      out.push(line)
    }
    return out
  }
  getValue() { return this.getValues()[0][0] }
  setValues(values) {
    if (!Array.isArray(values) || values.length !== this.numRows)
      throw new Error(`The number of rows in the data does not match the number of rows in the range. The data has ${values.length} but the range has ${this.numRows}.`)
    values.forEach((line, r) => {
      if (line.length !== this.numCols)
        throw new Error(`The number of columns in the data does not match the number of columns in the range. The data has ${line.length} but the range has ${this.numCols}.`)
      const idx = this.row - 1 + r
      const target = (this.sheet.rows[idx] = this.sheet.rows[idx] || [])
      line.forEach((v, c) => {
        const col = this.col + c
        if (typeof v === 'string' && v.length > 50000) throw new Error('Your input contains more than the maximum of 50000 characters in a single cell.')
        target[col - 1] = this.sheet.env.parse(v, this.sheet.textCols.has(col))
      })
    })
    return this
  }
  setValue(v) { return this.setValues([[v]]) }
  clearContent() {
    for (let r = 0; r < this.numRows; r++) {
      const row = this.sheet.rows[this.row - 1 + r]
      if (!row) continue
      for (let c = 0; c < this.numCols; c++) row[this.col - 1 + c] = ''
    }
    return this
  }
  setNumberFormat(fmt) {
    for (let c = 0; c < this.numCols; c++) {
      if (fmt === '@') this.sheet.textCols.add(this.col + c)
      else this.sheet.textCols.delete(this.col + c)
    }
    return this
  }
}

export function createGasEnv({ token = 'test-token-0123456789abcdef0123456789', data = null, now = null } = {}) {
  const logs = []
  const props = new Map(token ? [['SYNC_TOKEN', token]] : [])
  const triggers = []
  const env = { lockBusy: false, logs, props, triggers }

  const sandboxConsole = Object.fromEntries(
    ['log', 'info', 'warn', 'error', 'debug'].map((k) => [k, (...a) => logs.push([k, ...a])]),
  )
  const ctx = vm.createContext({ console: sandboxConsole })
  const CtxDate = vm.runInContext('Date', ctx)
  if (now) {
    // Fixed / controllable clock for deterministic tests.
    vm.runInContext(`(function(){ const R = Date; const clock = { t: ${now} };
      function D(...a){ return a.length ? new R(...a) : new R(clock.t) }
      D.prototype = R.prototype; D.now = () => clock.t; D.parse = R.parse; D.UTC = R.UTC;
      globalThis.Date = D; globalThis.__clock = clock; })()`, ctx)
  }
  env.setNow = (t) => { vm.runInContext(`__clock.t = ${t}`, ctx) }
  env.parse = (v, isText) => {
    if (!isText && typeof v === 'string' && DATE_LIKE.test(v)) return new CtxDate(v)
    return v
  }

  const sheets = new Map()
  const ss = {
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => { const s = new Sheet(env, n); sheets.set(n, s); return s },
    getSheets: () => [...sheets.values()],
  }
  if (data) {
    for (const [name, s] of Object.entries(data.sheets || {})) {
      const rows = s.rows.map((row) => (row || []).map((v) => (v && typeof v === 'object' && v.$date ? new CtxDate(v.$date) : v)))
      sheets.set(name, new Sheet(env, name, rows, s.textCols || []))
    }
    for (const [k, v] of Object.entries(data.props || {})) props.set(k, v)
  }

  Object.assign(ctx, {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    LockService: { getScriptLock: () => ({ tryLock: () => !env.lockBusy, waitLock: () => {}, releaseLock: () => {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (props.has(k) ? props.get(k) : null), setProperty: (k, v) => props.set(k, v) }) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this }, getContent() { return this.text } }),
    },
    Utilities: {
      formatDate: (d, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d),
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1) },
      newTrigger: (fn) => ({ timeBased: () => ({ everyMinutes: (n) => ({ create: () => { const t = { fn, n, getHandlerFunction: () => fn }; triggers.push(t); return t } }) }) }),
    },
    Logger: { log: (...a) => logs.push(['Logger', ...a]) },
  })
  vm.runInContext(fs.readFileSync(CODE_PATH, 'utf8'), ctx, { filename: 'Code.gs' })

  env.ctx = ctx
  env.ss = ss
  env.sheet = (n) => sheets.get(n)
  env.post = (body) => {
    const out = ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } })
    return JSON.parse(out.getContent())
  }
  env.get = () => JSON.parse(ctx.doGet({}).getContent())
  env.run = (fn) => ctx[fn]()
  env.serialize = () => ({
    sheets: Object.fromEntries([...sheets].map(([n, s]) => [n, {
      textCols: [...s.textCols],
      rows: s.rows.map((row) => (row || []).map((v) => (v instanceof CtxDate ? { $date: v.toISOString() } : v))),
    }])),
    props: Object.fromEntries(props),
  })
  /** Sheet as array of objects keyed by header row. */
  env.table = (n) => {
    const s = sheets.get(n)
    if (!s || s.getLastRow() < 1) return []
    const values = s.getRange(1, 1, s.getLastRow(), Math.max(1, s.getLastColumn())).getValues()
    const [head, ...rest] = values
    return rest.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])))
  }
  return env
}
