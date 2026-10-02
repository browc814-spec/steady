# Steady sync

Steady keeps working offline from `localStorage` (`steady-budget-v5`), and can also sync to a **private
Google Sheet** in Caleb's Drive through a small **Google Apps Script web app**. Every device and the
finance agent share that one copy.

```
 phone / laptop (Steady)  ──POST text/plain {token, action}──▶  Apps Script web app (/exec)
                                                                  │  LockService, token check
 finance agent ──Sheets API: append rows to Inbox──────────────▶  │  folds Inbox → Items
               ◀─Sheets API: read Transactions / Summary / Items─  ▼
                                                   Google Sheet "Steady Budget Sync" (private)
```

- **Sheet:** `Steady Budget Sync`. The id and URL are in `/workspace/steady/secrets/sync.env`, which is outside the repo.
- **Script:** `sync/apps-script/Code.gs` and `sync/apps-script/appsscript.json`. It is **container-bound**: you create it from the sheet with *Extensions → Apps Script*, so it needs no sheet id.
- **Client code:** `src/sync/*` and `src/SettingsView.tsx`.

## Data model

The nested `BudgetState` is flattened into **items**. Each item has a stable id, `updatedAt`, `deleted` (a
tombstone), and `updatedBy`. Devices merge **per item, last-write-wins**:

| kind            | id                                     | parentId     | json fields                                            |
|-----------------|----------------------------------------|--------------|--------------------------------------------------------|
| `paycheckField` | `p1.label` `p1.paycheck` `p1.savings` (same for `p2`) | `p1`/`p2` | `{value}` (field-level LWW)                      |
| `bill`          | uuid                                   | `p1`/`p2`    | `{name, amount}`                                       |
| `category`      | uuid                                   | `p1`/`p2`    | `{name, percent}`                                      |
| `spend`         | uuid                                   | `p1`/`p2`    | `{date, categoryId, amount, merchant, note}`           |
| `goal`          | uuid                                   | *(empty)*    | `{name, target}`                                       |
| `deposit`       | uuid                                   | goal id      | `{date, amount, note}`. Merged one by one, so concurrent deposits are all kept |
| `cashTx`        | uuid                                   | *(empty)*    | `{date, type: set/add/spend, amount, note}`. The balance is recomputed by replaying them |
| `archive`       | uuid                                   | *(empty)*    | `{paycheckKey, label, periodLabel, archivedAt, budget}`. Stored as one unit |

Every item's json also carries `createdAt`, which only orders items that share the same date.

**Sheet tabs**
- **Items**: `id | kind | parentId | updatedAt | deleted | updatedBy | json`. JSON longer than 45,000 characters continues into `json+1`, `json+2`, … (a Sheets cell holds at most 50k characters).
- **Meta**: `rev | schemaVersion | updatedAt` in row 2.
- **Inbox**: `uuid | kind | parentId | op | json | createdAt | createdBy | processedAt`.
- **Transactions** and **Summary**: derived and rebuilt after every write.
- **README**: the Inbox contract.

## Protocol (Apps Script web app)

`POST <url>/exec` with header `Content-Type: text/plain`. Any other content type triggers a CORS preflight, which Apps Script can't answer.

```jsonc
{ "token": "<SYNC_TOKEN>", "device": "phone", "action": "pull", "sinceRev": 12 }       // sinceRev null = everything
{ "token": "…", "device": "phone", "action": "push", "baseRev": 12, "items": [ /* full items */ ] }
{ "token": "…", "action": "ping" }
```

- **Response:** `{ok:true, rev, stale, inboxProcessed, items?|unchanged:true, applied?, rejected?}`, or `{ok:false, error}`. Errors: `unauthorized`, `busy`, `bad_json`, `unknown_action`, `server_error`.
- **Every request** takes the script lock and folds pending Inbox rows first. On a push, the server applies LWW per item, bumps `rev` if anything changed, and rewrites Items, Meta, Transactions and Summary.
- **Stale `baseRev`** (someone else wrote in between) is still merged safely, because LWW per item is commutative. The server then returns the full item list so the client can merge.
- **`GET`** is only a health check (`{ok:true, app:"steady-sync"}`). It never returns data, so the token never has to go in a URL.
- **Bodies are never logged.**

## Client behaviour

- **Single save path:** `App` → `saveState` (localStorage) → `SyncController.absorb(state)`, which diffs the state against the item map. New and changed items get `updatedAt = now`; removed items become tombstones. Changed ids go into the offline queue (`dirty`), and a push follows ~1.5 s after the last edit.
- **When it pulls:** on load, window focus, `visibilitychange`, `online`, and every 2 minutes while the app is visible.
- **Remote merges** run inside a functional `setState`, so an edit made while a request is in flight is folded in first and never overwritten. All child components update through functional updaters as well.
- **Multiple tabs:** a `storage` event listener keeps open tabs in step.
- **Status badge** in the header: Synced / Syncing / Offline · N waiting / Sync error / Sync needs you.
- **First sync on a device:**
  1. Saves a backup key `steady-budget-presync-<time>` and offers a JSON download.
  2. Store empty → uploads this device's data.
  3. This device still has the untouched demo (pristine flag) → adopts the synced copy; the demo is never uploaded.
  4. Both have data → asks: **Merge** (union by id; the synced copy wins on shared ids) / **Use synced data only** / **Not now**.
- **Unreadable localStorage:** the raw text is copied to `steady-budget-corrupt-<time>` and an error banner appears. The app does **not** save, so nothing is overwritten, until you choose Start fresh / Restore from sync copy.
- **Reset demo** asks for confirmation and is disabled while sync is on.
- **Settings tab:** sync URL and token (stored only in this browser's localStorage), device name, Sync now, Turn off sync, **Export JSON**, **Import JSON** (merge or replace, both confirmed), and a list of automatic backups.

## One-time setup (Caleb, in a desktop browser signed in as browc814@gmail.com)

**Create the script**
1. Open the **Steady Budget Sync** sheet (URL in `secrets/sync.env`).
2. In the menu, choose **Extensions → Apps Script**. A new tab opens with a project called *Untitled project* and a file `Code.gs`.
3. Click **Untitled project** at the top, name it `Steady Sync`, and click **Rename**.
4. In `Code.gs`, select all the existing code (`function myFunction…`), delete it, and paste the whole of `sync/apps-script/Code.gs`. Click the 💾 **Save project** icon (or Ctrl/Cmd+S).
5. *(Recommended)* Use the narrow scopes manifest:
   - Click ⚙️ **Project Settings** in the left sidebar and tick **Show "appsscript.json" manifest file in editor**.
   - Go back to **Editor** (`< >` icon), open `appsscript.json`, replace its contents with `sync/apps-script/appsscript.json`, and save.

**Set the token**
6. Click ⚙️ **Project Settings**, scroll to **Script Properties**, and click **Add script property**.
7. Enter Property `SYNC_TOKEN` and Value = the token from `secrets/sync.env`. Click **Save script properties**.

**Authorize**
8. Back in **Editor**, pick **`setupTrigger`** in the function dropdown in the toolbar, then click **▶ Run**.
9. When **Authorization required** appears, click **Review permissions** and choose **browc814@gmail.com**.
10. On **"Google hasn't verified this app"**, click **Advanced** (bottom left), then **Go to Steady Sync (unsafe)**. The warning appears because the script is private and unreviewed. Only Caleb's own account runs it.
11. On the consent screen, tick **Select all** (or each box) and click **Continue** / **Allow**. With the manifest the scopes are only: *this spreadsheet*, and *run when you are not present* (for the 5-minute trigger).
12. The Execution log should end with **Execution completed**. This step formats the tabs and installs the 5-minute Inbox trigger.

**Deploy the web app**
13. Click **Deploy → New deployment**.
14. Click the ⚙️ next to **Select type** and choose **Web app**.
15. Fill in:
    - Description: `Steady sync v1`
    - **Execute as: Me (browc814@gmail.com)**
    - **Who has access: Anyone**. It must be *Anyone*, not *Anyone with Google account*, or the app can't reach it. The token is what protects it.
16. Click **Deploy**. If asked to authorize again, repeat steps 9–11.
17. Copy the **Web app URL** (`https://script.google.com/macros/s/…/exec`) and click **Done**.
18. Check it: open the URL in a browser tab. It should show `{"ok":true,"app":"steady-sync","schemaVersion":1}`.

**Changing the code later:** paste the new code, then **Deploy → Manage deployments**, select the deployment, click ✏️ **Edit**, set **Version: New version**, and click **Deploy**. The URL stays the same. A *New deployment* would create a new URL.

## Connecting devices

**Do the phone first** (the device with the real data), so it seeds the empty sheet.

**Option A: setup link.** Open this once in the browser where Steady's data lives:

```
https://browc814-spec.github.io/steady/#sync-url=<URL-encoded /exec URL>&sync-token=<token>&sync-device=phone
```

- The part after `#` is never sent to any server.
- The app stores the URL and token, then removes the fragment from the address bar right away.
- The link contains the secret. Send it only through a private channel and delete the message afterwards. It may stay in browser history.
- To build it:

  ```bash
  source /workspace/steady/secrets/sync.env
  node -e 'const p=new URLSearchParams({"sync-url":process.env.STEADY_SYNC_URL,"sync-token":process.env.STEADY_SYNC_TOKEN,"sync-device":"phone"});console.log("https://browc814-spec.github.io/steady/#"+p)'
  ```

**Option B: by hand.** In Steady, open **Settings → Sync**, paste the URL and token, name the device, and tap **Turn on sync**.

## Finance agent (Inbox contract)

**Read:** `Transactions` (flattened spends, cash, deposits, archived spends), `Summary`, and for ids, `Items`. Ignore rows where `deleted` is `TRUE`.

**Write:** **append** rows to `Inbox` (RAW, not parsed), with exactly 8 columns:

| uuid | kind | parentId | op | json | createdAt | createdBy | processedAt |
|---|---|---|---|---|---|---|---|
| new random UUID, or an existing id to edit/delete | see the table above (not `archive`) | `p1`/`p2`, goal id, or empty | `upsert` or `delete` | JSON object (only the fields to change, when editing) | ISO UTC time, or empty for now | `tammy` | **empty** |

- **Never** edit Items, Meta, Transactions or Summary, and never edit, sort or delete Inbox rows. The script owns those tabs and the `processedAt` column.
- `processedAt` is filled in with an ISO time on success, `ERROR <time>: reason`, or `SKIPPED <time>: reason` (when a newer version already exists).
- A `spend` needs `categoryId` = the id of a live `category` in the **same** paycheck, plus `amount` and `merchant`. `date` defaults to today in PT.
- Changes reach the phone on its next sync: when the app opens or regains focus, or every 2 minutes while it is open. Transactions and Summary refresh on every app sync and every ~5 minutes by trigger.

## Security notes

- **The sheet** is owned by browc814@gmail.com and not shared. The web app runs as Caleb, reaches only this spreadsheet (`@OnlyCurrentDoc` + `spreadsheets.currentonly`), and refuses every request without the 64-character `SYNC_TOKEN` (compared in constant time).
- **Token storage:** the token lives only in Script Properties, `secrets/sync.env` on the agents' box, and each device's localStorage. It is not in the repo or the built bundle.
- **Rotating the token:** change `SYNC_TOKEN` in Script Properties, then reconnect each device (Settings → Turn off sync → turn on with the new token).
- **Shared origin warning:** `https://browc814-spec.github.io` is one origin for *all* of Caleb's GitHub Pages sites (for example `/live-journal/`). Any page served there can read Steady's localStorage, including the budget data and the sync token. Only publish trusted code on that GitHub account, or move Steady to its own domain later.
- **Clocks:** last-write-wins uses device clocks. A device with a badly wrong clock can win or lose edits it shouldn't. Edits always beat the version they replace locally.
- **Quotas:** Apps Script consumer quotas are far above this usage (one short request per sync; a 5-minute trigger is ~288 runs/day).

## Tests

```bash
npm test                         # vitest: merge logic, controller vs real Code.gs (shim), Apps Script behaviour
npm run build && npm run test:e2e   # Playwright: 3 devices + mock endpoint, offline/online, deletes, deposits, cash, archive, Inbox, export/import, corrupt storage
npm run mock-sync -- --port 8787 --data /tmp/sheet.json --token <token>   # local endpoint for manual testing
```

- `sync/test/gas-shim.mjs` runs the **real** `Code.gs` in Node with stand-ins for SpreadsheetApp, LockService, PropertiesService, ContentService, ScriptApp and Utilities.
- The shim mimics Sheets' habit of turning date-like strings into Date objects unless the cells are plain text, and it throws on range-size mismatches.
- `sync/test/mock-server.mjs` serves that code over HTTP like a deployment would: CORS `*`, no preflight support.
