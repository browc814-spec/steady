/**
 * @OnlyCurrentDoc
 *
 * Steady sync endpoint — container-bound Apps Script for the "Steady Budget Sync" sheet.
 * Open the sheet → Extensions → Apps Script → paste this file → deploy as a Web app.
 *
 * Tabs:
 *   Items         canonical store, one row per item:
 *                 id | kind | parentId | updatedAt | deleted | updatedBy | json [| json+1 ...]
 *   Meta          rev | schemaVersion | updatedAt   (values in row 2)
 *   Inbox         agent writes here (append only):
 *                 uuid | kind | parentId | op | json | createdAt | createdBy | processedAt
 *   Transactions  derived, rebuilt after every write (read-only)
 *   Summary       derived, rebuilt after every write (read-only)
 *   README        contract notes
 *
 * Protocol: POST (Content-Type text/plain to avoid a CORS preflight) with a JSON body
 *   { token, action: "ping" | "pull" | "push", device, sinceRev?, baseRev?, items? }
 * Response JSON: { ok: true, rev, ... } or { ok: false, error }.
 * The token is compared with Script Property SYNC_TOKEN. Request bodies are never logged.
 */

var SCHEMA_VERSION = 1;
var ITEM_HEADERS = ['id', 'kind', 'parentId', 'updatedAt', 'deleted', 'updatedBy', 'json'];
var META_HEADERS = ['rev', 'schemaVersion', 'updatedAt'];
var INBOX_HEADERS = ['uuid', 'kind', 'parentId', 'op', 'json', 'createdAt', 'createdBy', 'processedAt'];
var TX_HEADERS = ['date', 'type', 'where', 'category', 'merchant', 'amount', 'note', 'period', 'id'];
var KINDS = ['paycheckField', 'bill', 'category', 'spend', 'goal', 'deposit', 'cashTx', 'archive'];
var PAYCHECK_FIELDS = ['label', 'paycheck', 'savings'];
var JSON_CHUNK = 45000; // Sheets cells hold at most 50,000 characters
var MAX_FUTURE_MS = 5 * 60 * 1000;

var README_LINES = [
  ['Steady Budget Sync — how this sheet works'],
  [''],
  ['Items is the canonical store, written ONLY by the Apps Script. Do not edit, sort, or delete rows in Items, Meta, Transactions or Summary by hand or via the Sheets API.'],
  ['Transactions and Summary are rebuilt automatically after every change (read-only views).'],
  [''],
  ['To add, change or delete data, APPEND a row to Inbox (never edit or delete existing Inbox rows):'],
  ['  uuid       = id of the item. New item: a fresh random UUID. Edit/delete: the existing id from Items. Paycheck settings use ids p1.label, p1.paycheck, p1.savings, p2.label, p2.paycheck, p2.savings.'],
  ['  kind       = spend | cashTx | deposit | goal | bill | category | paycheckField'],
  ['  parentId   = p1 or p2 for spend/bill/category/paycheckField; the goal id for deposit; empty for goal/cashTx'],
  ['  op         = upsert (create, or change only the fields given) | delete'],
  ['  json       = JSON object with the fields, e.g. spend {"date":"2026-10-02","categoryId":"<category id>","amount":12.5,"merchant":"Costco","note":""}'],
  ['               cashTx {"date":"2026-10-02","type":"spend|add|set","amount":20,"note":""} · deposit {"date":"2026-10-02","amount":50,"note":""}'],
  ['               goal {"name":"Trip","target":1500} · bill {"name":"Rent","amount":600} · category {"name":"Gas","percent":15} · paycheckField {"value":1600}'],
  ['  createdAt  = ISO time in UTC, e.g. 2026-10-02T19:40:00.000Z (used for last-write-wins; leave empty for "now")'],
  ['  createdBy  = who wrote it, e.g. tammy'],
  ['  processedAt = leave EMPTY. The script fills it in: an ISO time on success, or "ERROR <time>: reason" / "SKIPPED <time>: reason".'],
  [''],
  ['Inbox rows are processed on every app sync and by a time trigger every ~5 minutes. Amounts are positive numbers in dollars. Dates are YYYY-MM-DD.'],
  ['This sheet contains private financial data. Do not share it.']
];

// ---------------------------------------------------------------- entry points

function doGet() {
  // Health check only; never returns data (GET would require the token in the URL).
  return json_({ ok: true, app: 'steady-sync', schemaVersion: SCHEMA_VERSION });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'bad_json' });
  }
  if (!checkToken_(req && req.token)) return json_({ ok: false, error: 'unauthorized' });

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return json_({ ok: false, error: 'busy' });
  try {
    return json_(handle_(req));
  } catch (err) {
    // Only the message, never the request body.
    return json_({ ok: false, error: 'server_error', message: String((err && err.message) || err).slice(0, 300) });
  } finally {
    lock.releaseLock();
  }
}

/** Time-trigger target: fold Inbox rows into Items and rebuild derived tabs. */
function processInbox() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return;
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    ensureSheets_(ss);
    var store = readStore_(ss);
    var folded = foldInbox_(ss, store);
    if (folded.changed) commit_(ss, store, store.rev + 1);
  } finally {
    lock.releaseLock();
  }
}

/** Run once from the editor: creates/repairs tabs and headers. Safe to re-run. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheets_(ss);
  var store = readStore_(ss);
  rebuildDerived_(ss, store);
}

/** Run once from the editor: installs the 5-minute Inbox trigger (replaces old ones). */
function setupTrigger() {
  setup();
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'processInbox') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('processInbox').timeBased().everyMinutes(5).create();
}

// ---------------------------------------------------------------- request handling

function handle_(req) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheets_(ss);
  var store = readStore_(ss);
  var prevRev = store.rev;
  var action = String(req.action || '');

  if (action === 'ping') {
    return { ok: true, rev: prevRev, schemaVersion: SCHEMA_VERSION, itemCount: Object.keys(store.items).length };
  }
  if (action !== 'pull' && action !== 'push') return { ok: false, error: 'unknown_action' };

  var folded = foldInbox_(ss, store);
  var changed = folded.changed;
  var applied = 0;
  var olderIgnored = 0;
  var rejected = [];

  if (action === 'push') {
    var incoming = Array.isArray(req.items) ? req.items : [];
    for (var i = 0; i < incoming.length; i++) {
      var item = normalizeIncoming_(incoming[i]);
      if (!item) {
        rejected.push(incoming[i] && incoming[i].id ? String(incoming[i].id).slice(0, 100) : '?');
        continue;
      }
      var existing = store.items[item.id];
      if (!existing || (!sameItem_(existing, item) && wins_(item, existing))) {
        store.items[item.id] = item;
        applied++;
        changed = true;
      } else if (!sameItem_(existing, item)) {
        olderIgnored++;
      }
    }
  }

  var rev = prevRev;
  if (changed) {
    rev = prevRev + 1;
    commit_(ss, store, rev);
  }

  var clientRev = action === 'push' ? req.baseRev : req.sinceRev;
  var stale = clientRev !== prevRev || folded.changed;
  var res = { ok: true, rev: rev, schemaVersion: SCHEMA_VERSION, stale: stale, inboxProcessed: folded.count };
  if (action === 'push') {
    res.applied = applied;
    res.rejected = rejected;
  }
  if (action === 'pull' ? clientRev !== rev : stale || olderIgnored > 0 || rejected.length > 0) {
    res.items = itemsToWire_(store.items);
  } else {
    res.unchanged = true;
  }
  return res;
}

// ---------------------------------------------------------------- auth

function checkToken_(given) {
  var expected = PropertiesService.getScriptProperties().getProperty('SYNC_TOKEN');
  if (!expected || expected.length < 24 || typeof given !== 'string') return false;
  if (given.length !== expected.length) return false;
  var diff = 0;
  for (var i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------- store

function ensureSheets_(ss) {
  ensureSheet_(ss, 'Items', ITEM_HEADERS, true);
  var meta = ensureSheet_(ss, 'Meta', META_HEADERS, false);
  if (meta.getLastRow() < 2) meta.getRange(2, 1, 1, 3).setValues([[0, SCHEMA_VERSION, '']]);
  ensureSheet_(ss, 'Inbox', INBOX_HEADERS, true);
  ensureSheet_(ss, 'Transactions', TX_HEADERS, false);
  ensureSheet_(ss, 'Summary', ['key', 'value', 'extra', 'extra2'], false);
  var readme = ss.getSheetByName('README') || ss.insertSheet('README');
  if (String(readme.getRange(1, 1).getValue()) !== README_LINES[0][0]) {
    readme.getRange(1, 1, README_LINES.length, 1).setValues(README_LINES);
  }
}

function ensureSheet_(ss, name, headers, textColumns) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  var current = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  var ok = true;
  for (var i = 0; i < headers.length; i++) if (current[i] !== headers[i]) ok = false;
  if (!ok) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  }
  if (textColumns && !ok) {
    // Plain-text format so ISO strings are not turned into dates.
    sh.getRange(1, 1, sh.getMaxRows(), headers.length + 3).setNumberFormat('@');
  }
  return sh;
}

function readStore_(ss) {
  var meta = ss.getSheetByName('Meta');
  var rev = Number(meta.getRange(2, 1).getValue()) || 0;
  var sh = ss.getSheetByName('Items');
  var items = {};
  var last = sh.getLastRow();
  if (last >= 2) {
    var width = Math.max(ITEM_HEADERS.length, sh.getLastColumn());
    var rows = sh.getRange(2, 1, last - 1, width).getValues();
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var id = String(row[0] || '');
      if (!id) continue;
      var text = '';
      for (var c = 6; c < row.length; c++) text += row[c] === '' || row[c] == null ? '' : String(row[c]);
      var data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch (err) {
        data = { _unparsed: true };
      }
      items[id] = {
        id: id,
        kind: String(row[1] || ''),
        parentId: String(row[2] || ''),
        updatedAt: toIso_(row[3]) || '1970-01-01T00:00:00.000Z',
        deleted: row[4] === true || String(row[4]).toUpperCase() === 'TRUE',
        updatedBy: String(row[5] || ''),
        data: data && typeof data === 'object' ? data : {}
      };
    }
  }
  return { rev: rev, items: items };
}

function commit_(ss, store, rev) {
  writeItems_(ss, store.items);
  var now = new Date().toISOString();
  ss.getSheetByName('Meta').getRange(2, 1, 1, 3).setValues([[rev, SCHEMA_VERSION, now]]);
  store.rev = rev;
  rebuildDerived_(ss, store);
}

function writeItems_(ss, items) {
  var sh = ss.getSheetByName('Items');
  var ids = Object.keys(items).sort(function (a, b) {
    var ka = items[a].kind + '|' + items[a].parentId + '|' + a;
    var kb = items[b].kind + '|' + items[b].parentId + '|' + b;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  var rows = [];
  var width = ITEM_HEADERS.length;
  for (var i = 0; i < ids.length; i++) {
    var it = items[ids[i]];
    var text = JSON.stringify(it.data || {});
    var row = [it.id, it.kind, it.parentId, it.updatedAt, it.deleted === true, it.updatedBy];
    for (var p = 0; p < text.length || p === 0; p += JSON_CHUNK) row.push(text.slice(p, p + JSON_CHUNK));
    if (row.length > width) width = row.length;
    rows.push(row);
  }
  for (var j = 0; j < rows.length; j++) while (rows[j].length < width) rows[j].push('');
  var header = ITEM_HEADERS.slice();
  for (var h = ITEM_HEADERS.length; h < width; h++) header.push('json+' + (h - ITEM_HEADERS.length + 1));
  var oldLastRow = sh.getLastRow();
  var oldLastCol = Math.max(sh.getLastColumn(), ITEM_HEADERS.length);
  sh.getRange(1, 1, 1, width).setValues([header]);
  if (rows.length) {
    var range = sh.getRange(2, 1, rows.length, width);
    range.setNumberFormat('@');
    range.setValues(rows);
  }
  // Clear leftovers (shrunk width or fewer rows); never touch rows we just wrote.
  if (oldLastCol > width) sh.getRange(1, width + 1, Math.max(oldLastRow, 1), oldLastCol - width).clearContent();
  if (oldLastRow > rows.length + 1) sh.getRange(rows.length + 2, 1, oldLastRow - rows.length - 1, Math.max(oldLastCol, width)).clearContent();
}

function itemsToWire_(items) {
  var out = [];
  for (var id in items) {
    if (!Object.prototype.hasOwnProperty.call(items, id)) continue;
    var it = items[id];
    if (KINDS.indexOf(it.kind) < 0) continue;
    out.push({ id: it.id, kind: it.kind, parentId: it.parentId, updatedAt: it.updatedAt, deleted: it.deleted, updatedBy: it.updatedBy, data: it.data });
  }
  return out;
}

// ---------------------------------------------------------------- merge rules (same as client)

function stable_(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(stable_).join(',') + ']';
  var keys = Object.keys(v).filter(function (k) { return v[k] !== undefined; }).sort();
  return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + stable_(v[k]); }).join(',') + '}';
}

function dataKey_(data) {
  var copy = {};
  for (var k in data) if (k !== 'createdAt') copy[k] = data[k];
  return stable_(copy);
}

function wins_(a, b) {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  if (a.updatedBy !== b.updatedBy) return a.updatedBy > b.updatedBy;
  if (a.deleted !== b.deleted) return a.deleted;
  return dataKey_(a.data) > dataKey_(b.data);
}

function sameItem_(a, b) {
  return a.updatedAt === b.updatedAt && a.updatedBy === b.updatedBy && a.deleted === b.deleted &&
    a.kind === b.kind && a.parentId === b.parentId && dataKey_(a.data) === dataKey_(b.data);
}

function normalizeIncoming_(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var id = typeof raw.id === 'string' ? raw.id : '';
  if (!id || id.length > 200) return null;
  if (KINDS.indexOf(raw.kind) < 0) return null;
  var updatedAt = toIso_(raw.updatedAt);
  if (!updatedAt) return null;
  return {
    id: id,
    kind: raw.kind,
    parentId: typeof raw.parentId === 'string' ? raw.parentId : '',
    updatedAt: updatedAt,
    deleted: raw.deleted === true,
    updatedBy: typeof raw.updatedBy === 'string' ? raw.updatedBy.slice(0, 100) : '',
    data: raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : {}
  };
}

function toIso_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString();
  if (typeof v !== 'string' || !v) return '';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)) return v;
  var t = Date.parse(v);
  return isNaN(t) ? '' : new Date(t).toISOString();
}

// ---------------------------------------------------------------- Inbox

function foldInbox_(ss, store) {
  var sh = ss.getSheetByName('Inbox');
  var last = sh.getLastRow();
  var result = { changed: false, count: 0 };
  if (last < 2) return result;
  var rows = sh.getRange(2, 1, last - 1, INBOX_HEADERS.length).getValues();
  var marks = [];
  var nowMs = Date.now();
  var anyNew = false;
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var processed = row[7];
    var blank = row.slice(0, 7).every(function (v) { return v === '' || v == null; });
    if ((processed !== '' && processed != null) || blank) {
      marks.push([processed == null ? '' : processed]);
      continue;
    }
    anyNew = true;
    var mark;
    try {
      var outcome = applyInboxRow_(store, row, nowMs);
      if (outcome.changed) result.changed = true;
      mark = outcome.skipped ? 'SKIPPED ' + new Date(nowMs).toISOString() + ': ' + outcome.skipped : new Date(nowMs).toISOString();
    } catch (err) {
      mark = 'ERROR ' + new Date(nowMs).toISOString() + ': ' + String((err && err.message) || err).slice(0, 200);
    }
    result.count++;
    marks.push([mark]);
  }
  if (anyNew) {
    var range = sh.getRange(2, 8, marks.length, 1);
    range.setNumberFormat('@');
    range.setValues(marks);
  }
  return result;
}

function num_(v, field) {
  var n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
  if (!isFinite(n)) throw new Error(field + ' must be a number');
  return Math.round(n * 100) / 100;
}

function isDate_(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function today_() {
  return Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd');
}

function liveItem_(store, id, kind) {
  var it = store.items[id];
  return it && !it.deleted && (!kind || it.kind === kind) ? it : null;
}

function applyInboxRow_(store, row, nowMs) {
  var id = String(row[0] || '').trim();
  var kind = String(row[1] || '').trim();
  var parentId = String(row[2] || '').trim();
  var op = String(row[3] || 'upsert').trim().toLowerCase();
  var jsonText = row[4];
  var createdBy = String(row[6] || 'inbox').trim().slice(0, 100) || 'inbox';
  if (!id) throw new Error('uuid is required');
  if (KINDS.indexOf(kind) < 0) throw new Error('unknown kind "' + kind + '"');
  if (kind === 'archive') throw new Error('archives can only be created in the app');
  if (op !== 'upsert' && op !== 'delete') throw new Error('op must be upsert or delete');

  var createdMs = row[5] instanceof Date ? row[5].getTime() : Date.parse(String(row[5] || ''));
  if (!isFinite(createdMs) || createdMs > nowMs + MAX_FUTURE_MS) createdMs = nowMs;
  var updatedAt = new Date(Math.min(createdMs, nowMs)).toISOString();

  var existing = store.items[id];
  if (existing && existing.kind !== kind) throw new Error('id belongs to a ' + existing.kind + ', not ' + kind);

  var next;
  if (op === 'delete') {
    if (!existing || existing.deleted) throw new Error('nothing to delete with that id');
    if (kind === 'paycheckField') throw new Error('paycheck fields cannot be deleted; upsert a value instead');
    next = { id: id, kind: kind, parentId: existing.parentId, updatedAt: updatedAt, deleted: true, updatedBy: createdBy, data: existing.data };
  } else {
    var patch = {};
    if (jsonText !== '' && jsonText != null) {
      try {
        patch = typeof jsonText === 'string' ? JSON.parse(jsonText) : jsonText;
      } catch (err) {
        throw new Error('json is not valid JSON');
      }
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('json must be an object');
    }
    var base = existing && !existing.deleted ? existing.data : {};
    var data = {};
    var k;
    for (k in base) data[k] = base[k];
    for (k in patch) if (k !== 'createdAt') data[k] = patch[k];
    var parent = parentId || (existing ? existing.parentId : '');
    var clean = validateData_(store, kind, id, parent, data);
    clean.createdAt = (existing && existing.data && existing.data.createdAt) || updatedAt;
    next = { id: id, kind: kind, parentId: clean._parent, updatedAt: updatedAt, deleted: false, updatedBy: createdBy, data: clean };
    delete clean._parent;
  }

  if (existing && !wins_(next, existing)) {
    return { changed: false, skipped: 'an existing version is newer (' + existing.updatedAt + ')' };
  }
  store.items[id] = next;
  return { changed: true };
}

function validateData_(store, kind, id, parent, d) {
  var out = {};
  var pc = parent === 'p1' || parent === 'p2';
  switch (kind) {
    case 'paycheckField': {
      var m = /^(p1|p2)\.(label|paycheck|savings)$/.exec(id);
      if (!m) throw new Error('paycheckField uuid must be p1.label, p1.paycheck, p1.savings, p2.label, p2.paycheck or p2.savings');
      if (!('value' in d)) throw new Error('json.value is required');
      out.value = m[2] === 'label' ? String(d.value) : num_(d.value, 'value');
      out._parent = m[1];
      return out;
    }
    case 'bill':
    case 'category':
      if (!pc) throw new Error('parentId must be p1 or p2');
      if (!d.name) throw new Error('json.name is required');
      out.name = String(d.name);
      if (kind === 'bill') out.amount = num_(d.amount, 'amount');
      else out.percent = num_(d.percent, 'percent');
      out._parent = parent;
      return out;
    case 'spend': {
      if (!pc) throw new Error('parentId must be p1 or p2');
      var cat = liveItem_(store, String(d.categoryId || ''), 'category');
      if (!cat) throw new Error('json.categoryId must be the id of an existing category (see Items kind=category)');
      if (cat.parentId !== parent) throw new Error('category ' + cat.id + ' belongs to ' + cat.parentId + ', not ' + parent);
      out.date = isDate_(d.date) ? d.date : today_();
      out.categoryId = cat.id;
      out.amount = Math.abs(num_(d.amount, 'amount'));
      out.merchant = String(d.merchant || '').trim();
      out.note = String(d.note || '');
      if (!out.merchant) throw new Error('json.merchant is required');
      out._parent = parent;
      return out;
    }
    case 'goal':
      if (!d.name) throw new Error('json.name is required');
      out.name = String(d.name);
      out.target = num_(d.target, 'target');
      out._parent = '';
      return out;
    case 'deposit':
      if (!liveItem_(store, parent, 'goal')) throw new Error('parentId must be the id of an existing goal');
      out.date = isDate_(d.date) ? d.date : today_();
      out.amount = num_(d.amount, 'amount');
      out.note = String(d.note || '');
      out._parent = parent;
      return out;
    case 'cashTx':
      if (['set', 'add', 'spend'].indexOf(d.type) < 0) throw new Error('json.type must be set, add or spend');
      out.date = isDate_(d.date) ? d.date : today_();
      out.type = d.type;
      out.amount = Math.abs(num_(d.amount, 'amount'));
      out.note = String(d.note || '');
      out._parent = '';
      return out;
  }
  throw new Error('unsupported kind');
}

// ---------------------------------------------------------------- derived tabs

function live_(store, kind, parentId) {
  var out = [];
  for (var id in store.items) {
    var it = store.items[id];
    if (it.deleted || it.kind !== kind) continue;
    if (parentId !== undefined && it.parentId !== parentId) continue;
    out.push(it);
  }
  out.sort(function (a, b) {
    var ca = String(a.data.createdAt || ''), cb = String(b.data.createdAt || '');
    return ca < cb ? -1 : ca > cb ? 1 : a.id < b.id ? -1 : 1;
  });
  return out;
}

function field_(store, key, name, fallback) {
  var it = store.items[key + '.' + name];
  return it && !it.deleted ? it.data.value : fallback;
}

function round2_(n) {
  n = Number(n);
  return isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function rebuildDerived_(ss, store) {
  var catNames = {};
  ['p1', 'p2'].forEach(function (k) {
    live_(store, 'category', k).forEach(function (c) { catNames[c.id] = c.data.name; });
  });
  var archives = live_(store, 'archive');
  archives.forEach(function (a) {
    var cats = (a.data.budget && a.data.budget.mutable) || [];
    cats.forEach(function (c) { if (!catNames[c.id]) catNames[c.id] = c.name; });
  });
  var pcLabel = function (k) { return String(field_(store, k, 'label', k === 'p1' ? 'Paycheck 1' : 'Paycheck 2')); };

  // ---- Transactions
  var tx = [];
  ['p1', 'p2'].forEach(function (k) {
    live_(store, 'spend', k).forEach(function (s) {
      tx.push([s.data.date, 'spend', pcLabel(k), catNames[s.data.categoryId] || 'Unknown', s.data.merchant || '', round2_(s.data.amount), s.data.note || '', 'current', s.id]);
    });
  });
  archives.forEach(function (a) {
    var spending = (a.data.budget && a.data.budget.spending) || [];
    spending.forEach(function (s) {
      tx.push([s.date, 'spend (archived)', a.data.label || '', catNames[s.categoryId] || 'Unknown', s.merchant || '', round2_(s.amount), s.note || '', a.data.periodLabel || '', s.id]);
    });
  });
  var cash = live_(store, 'cashTx');
  cash.sort(function (a, b) {
    var da = String(a.data.date), db = String(b.data.date);
    if (da !== db) return da < db ? -1 : 1;
    return String(a.data.createdAt) < String(b.data.createdAt) ? -1 : 1;
  });
  var balance = 0;
  cash.forEach(function (t) {
    var amt = Math.abs(round2_(t.data.amount));
    if (t.data.type === 'set') balance = amt;
    else if (t.data.type === 'add') balance = round2_(balance + amt);
    else if (t.data.type === 'spend') balance = round2_(balance - amt);
    tx.push([t.data.date, 'cash ' + t.data.type, 'Cash box', '', '', amt, (t.data.note || '') + ' (balance ' + balance + ')', 'current', t.id]);
  });
  var goals = live_(store, 'goal');
  var goalNames = {};
  goals.forEach(function (g) { goalNames[g.id] = g.data.name; });
  live_(store, 'deposit').forEach(function (d) {
    if (!goalNames[d.parentId]) return;
    tx.push([d.data.date, 'goal deposit', goalNames[d.parentId], '', '', round2_(d.data.amount), d.data.note || '', 'current', d.id]);
  });
  tx.sort(function (a, b) { return String(a[0]) < String(b[0]) ? 1 : String(a[0]) > String(b[0]) ? -1 : 0; });
  writeTable_(ss.getSheetByName('Transactions'), TX_HEADERS, tx, [5]);

  // ---- Summary
  var now = new Date().toISOString();
  var rows = [['Last updated (UTC)', now, '', ''], ['Revision', store.rev, '', ''], ['', '', '', '']];
  ['p1', 'p2'].forEach(function (k) {
    var pay = round2_(field_(store, k, 'paycheck', 0));
    var sav = round2_(field_(store, k, 'savings', 0));
    var bills = 0;
    live_(store, 'bill', k).forEach(function (b) { bills += round2_(b.data.amount); });
    var flexible = round2_(Math.max(0, pay - sav - bills));
    var spent = 0;
    live_(store, 'spend', k).forEach(function (s) { spent += round2_(s.data.amount); });
    rows.push([pcLabel(k), 'paycheck', pay, '']);
    rows.push([pcLabel(k), 'savings', sav, '']);
    rows.push([pcLabel(k), 'bills total', round2_(bills), '']);
    rows.push([pcLabel(k), 'flexible to split', flexible, '']);
    rows.push([pcLabel(k), 'spent this period', round2_(spent), '']);
    rows.push([pcLabel(k), 'flexible remaining', round2_(flexible - spent), '']);
    live_(store, 'category', k).forEach(function (c) {
      var budget = round2_(flexible * (Number(c.data.percent) || 0) / 100);
      var used = 0;
      live_(store, 'spend', k).forEach(function (s) { if (s.data.categoryId === c.id) used += round2_(s.data.amount); });
      rows.push([pcLabel(k), 'category: ' + c.data.name + ' (' + c.data.percent + '%)', budget, 'spent ' + round2_(used) + ', left ' + round2_(budget - used)]);
    });
    rows.push(['', '', '', '']);
  });
  rows.push(['Cash box', 'balance', balance, '']);
  rows.push(['', '', '', '']);
  goals.forEach(function (g) {
    var saved = 0;
    live_(store, 'deposit', g.id).forEach(function (d) { saved += round2_(d.data.amount); });
    rows.push(['Goal', g.data.name, round2_(saved), 'target ' + round2_(g.data.target) + ', left ' + round2_(Math.max(0, g.data.target - saved))]);
  });
  rows.push(['', '', '', '']);
  var year = now.slice(0, 4);
  var ytd = 0;
  var byCat = {};
  var byMerchant = {};
  tx.forEach(function (t) {
    if (String(t[1]).indexOf('spend') !== 0 || String(t[0]).slice(0, 4) !== year) return;
    ytd += t[5];
    byCat[t[3]] = round2_((byCat[t[3]] || 0) + t[5]);
    var m = String(t[4] || '(none)');
    byMerchant[m] = round2_((byMerchant[m] || 0) + t[5]);
  });
  rows.push(['Spending ' + year, 'total', round2_(ytd), '']);
  Object.keys(byCat).sort(function (a, b) { return byCat[b] - byCat[a]; }).forEach(function (c) {
    rows.push(['Spending ' + year, 'category: ' + c, byCat[c], '']);
  });
  Object.keys(byMerchant).sort(function (a, b) { return byMerchant[b] - byMerchant[a]; }).slice(0, 15).forEach(function (m) {
    rows.push(['Spending ' + year, 'merchant: ' + m, byMerchant[m], '']);
  });
  writeTable_(ss.getSheetByName('Summary'), ['key', 'value', 'extra', 'extra2'], rows, [2]);
}

function writeTable_(sh, headers, rows, numericCols) {
  var oldLast = sh.getLastRow();
  var width = headers.length;
  sh.getRange(1, 1, 1, width).setValues([headers]);
  if (rows.length) {
    var range = sh.getRange(2, 1, rows.length, width);
    // Text format everywhere except numeric columns (prevents formula injection / date parsing).
    range.setNumberFormat('@');
    for (var i = 0; i < numericCols.length; i++) sh.getRange(2, numericCols[i] + 1, rows.length, 1).setNumberFormat('0.00');
    range.setValues(rows.map(function (r) {
      return r.map(function (v, c) { return numericCols.indexOf(c) >= 0 ? v : v == null ? '' : String(v); });
    }));
  }
  if (oldLast > rows.length + 1) sh.getRange(rows.length + 2, 1, oldLast - rows.length - 1, width).clearContent();
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
