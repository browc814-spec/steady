import { useRef, useState } from 'react'
import { Cloud, CloudOff, Download, RefreshCw, Upload, AlertTriangle } from 'lucide-react'
import type { BudgetState } from './types'
import type { SyncController, SyncSnapshot } from './sync/controller'
import { materialize } from './sync/items'
import { downloadBackup, downloadText, parseBackup } from './sync/backup'
import { listBackups, loadMeta, readKey, removeKey } from './sync/storage'

function timeLabel(iso: string | null) {
  if (!iso) return 'never'
  const d = new Date(iso)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function statusText(snap: SyncSnapshot) {
  if (!snap.configured) return 'Sync off'
  switch (snap.status) {
    case 'off':
      return 'Sync paused'
    case 'syncing':
      return 'Syncing…'
    case 'offline':
      return snap.pending ? `Offline · ${snap.pending} waiting` : 'Offline'
    case 'error':
      return 'Sync error'
    case 'confirm':
      return 'Sync needs you'
    default:
      return snap.pending ? `${snap.pending} waiting…` : `Synced ${timeLabel(snap.lastSyncAt)}`
  }
}

export function SyncBadge({ snap, onClick }: { snap: SyncSnapshot; onClick: () => void }) {
  const tone =
    !snap.configured || snap.status === 'off'
      ? 'muted'
      : snap.status === 'error' || snap.status === 'confirm'
        ? 'bad'
        : snap.status === 'offline'
          ? 'warn'
          : 'good'
  return (
    <button
      type="button"
      className={`sync-badge sync-${tone}`}
      onClick={onClick}
      data-testid="sync-badge"
      data-status={snap.configured ? snap.status : 'unconfigured'}
      data-pending={snap.pending}
      title={snap.error ?? undefined}
    >
      {snap.configured && snap.status !== 'offline' ? <Cloud size={15} /> : <CloudOff size={15} />}
      <span>{statusText(snap)}</span>
    </button>
  )
}

export function LoadErrorBanner({
  error,
  backupKey,
  onStartFresh,
  onRestore,
}: {
  error: string
  backupKey?: string
  onStartFresh: () => void
  onRestore: (state: BudgetState) => void
}) {
  const meta = loadMeta()
  const canRestore = !!meta && Object.keys(meta.items).length > 0
  return (
    <section className="card banner-bad" role="alert" data-testid="load-error">
      <h2>
        <AlertTriangle size={18} /> Your saved data couldn’t be read
      </h2>
      <p className="hint bad">
        {error} Nothing has been overwritten — the app is not saving until you choose what to do.
        {backupKey ? ` A copy of the raw text is kept in browser storage as “${backupKey}”.` : ''}
      </p>
      <div className="button-row">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            const raw = (backupKey && readKey(backupKey)) ?? readKey('steady-budget-v5') ?? ''
            downloadText('steady-unreadable-data.txt', raw)
          }}
        >
          <Download size={16} /> Download raw data
        </button>
        {canRestore ? (
          <button type="button" className="btn btn-primary" onClick={() => onRestore(materialize(meta!.items))}>
            Restore from this device’s sync copy
          </button>
        ) : null}
        <button type="button" className="btn btn-danger" onClick={onStartFresh}>
          Start fresh
        </button>
      </div>
    </section>
  )
}

export function FirstSyncDialog({
  snap,
  sync,
  state,
}: {
  snap: SyncSnapshot
  sync: SyncController
  state: BudgetState
}) {
  const c = snap.confirm!
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="first-sync-title">
      <div className="modal card" data-testid="first-sync-dialog">
        <h2 id="first-sync-title">Combine this device with your synced data?</h2>
        <p>
          The synced sheet already has <strong>{c.remoteCount}</strong> items and this device has{' '}
          <strong>{c.localCount}</strong>.
        </p>
        <ul className="hint">
          <li>
            <strong>Merge</strong> keeps everything from both. If the same item exists in both, the synced
            version wins. (Similar categories created separately on each device may appear twice.)
          </li>
          <li>
            <strong>Use synced data only</strong> replaces this device’s data with the synced copy.
          </li>
          <li>A backup of this device was saved{snap.backupKey ? ` as “${snap.backupKey}”` : ''}.</li>
        </ul>
        <div className="button-row">
          <button type="button" className="btn btn-ghost" onClick={() => downloadBackup(state)}>
            <Download size={16} /> Download backup
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void sync.resolveFirstSync('merge')}>
            Merge
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              if (confirm('Replace this device’s data with the synced copy? (Your backup stays on this device.)')) {
                void sync.resolveFirstSync('remote')
              }
            }}
          >
            Use synced data only
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => void sync.resolveFirstSync('cancel')}>
            Not now
          </button>
        </div>
      </div>
    </div>
  )
}

export function SettingsView({
  state,
  sync,
  snap,
  onReplace,
  onMerge,
}: {
  state: BudgetState
  sync: SyncController
  snap: SyncSnapshot
  onReplace: (state: BudgetState) => void
  onMerge: (state: BudgetState) => void
}) {
  const [endpoint, setEndpoint] = useState('')
  const [token, setToken] = useState('')
  const [device, setDevice] = useState(snap.device)
  const [imported, setImported] = useState<BudgetState | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [backupsVersion, setBackupsVersion] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)
  const backups = listBackups()
  void backupsVersion

  const connect = () => {
    if (!/^https:\/\//i.test(endpoint.trim())) {
      alert('Paste the Web app URL (it starts with https:// and ends with /exec).')
      return
    }
    if (token.trim().length < 24) {
      alert('Paste the full sync token.')
      return
    }
    void sync.connect(endpoint, token, device)
    setToken('')
  }

  return (
    <>
      <section className="card" data-testid="sync-settings">
        <div className="card-head">
          <div>
            <h2>Sync</h2>
            <p>Share one copy of your budget between your phone, other browsers, and your finance agent.</p>
          </div>
        </div>

        {!snap.configured ? (
          <>
            <div className="field-row">
              <label className="field">
                <span>Sync URL (Apps Script web app, ends in /exec)</span>
                <input
                  className="input"
                  data-testid="sync-endpoint"
                  placeholder="https://script.google.com/macros/s/…/exec"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  autoComplete="off"
                />
              </label>
            </div>
            <div className="field-row">
              <label className="field">
                <span>Sync token</span>
                <input
                  className="input"
                  data-testid="sync-token"
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <label className="field">
                <span>This device’s name</span>
                <input
                  className="input"
                  data-testid="sync-device"
                  placeholder="phone"
                  value={device}
                  onChange={(e) => setDevice(e.target.value)}
                />
              </label>
            </div>
            <div className="button-row">
              <button type="button" className="btn btn-primary" data-testid="sync-connect" onClick={connect}>
                <Cloud size={16} /> Turn on sync
              </button>
            </div>
            <p className="hint">
              The URL and token are stored only in this browser. Before the first sync a backup of this
              device’s data is saved automatically.
            </p>
          </>
        ) : (
          <>
            <div className="list">
              <div className="list-row">
                <span>Status</span>
                <strong data-testid="sync-status-text">{statusText(snap)}</strong>
              </div>
              <div className="list-row">
                <span>Last synced</span>
                <strong>{timeLabel(snap.lastSyncAt)}</strong>
              </div>
              <div className="list-row">
                <span>Waiting to upload</span>
                <strong>{snap.pending}</strong>
              </div>
              <div className="list-row">
                <span>Endpoint</span>
                <strong className="mono">{snap.endpoint.replace(/^(.{40}).+(.{12})$/, '$1…$2')}</strong>
              </div>
            </div>
            {snap.error ? <p className="hint bad">{snap.error}</p> : null}
            <div className="field-row">
              <label className="field">
                <span>This device’s name</span>
                <input
                  className="input"
                  value={device}
                  onChange={(e) => setDevice(e.target.value)}
                  onBlur={() => sync.setDevice(device)}
                />
              </label>
            </div>
            <div className="button-row">
              {snap.enabled ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  data-testid="sync-now"
                  onClick={() => void sync.syncNow()}
                >
                  <RefreshCw size={16} /> Sync now
                </button>
              ) : (
                <button type="button" className="btn btn-primary" onClick={() => sync.enable()}>
                  <Cloud size={16} /> Resume sync
                </button>
              )}
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  if (
                    confirm(
                      'Turn off sync on this device? Your data stays here; the URL and token are forgotten.',
                    )
                  ) {
                    sync.disconnect()
                  }
                }}
              >
                <CloudOff size={16} /> Turn off sync
              </button>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Backup</h2>
            <p>Download everything as a JSON file, or restore from one.</p>
          </div>
        </div>
        <div className="button-row">
          <button type="button" className="btn btn-primary" data-testid="export-json" onClick={() => downloadBackup(state)}>
            <Download size={16} /> Export JSON
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => fileRef.current?.click()}>
            <Upload size={16} /> Import JSON
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            data-testid="import-json"
            style={{ display: 'none' }}
            onChange={async (e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (!file) return
              try {
                setImported(parseBackup(await file.text()))
                setImportError(null)
              } catch (err) {
                setImported(null)
                setImportError(err instanceof Error ? err.message : String(err))
              }
            }}
          />
        </div>
        {importError ? <p className="hint bad">{importError}</p> : null}
        {imported ? (
          <div className="import-choice" data-testid="import-choice">
            <p className="hint">
              Backup loaded: {imported.paychecks.p1.spending.length + imported.paychecks.p2.spending.length}{' '}
              current purchases, {imported.goals.length} goals, {imported.history.length} archived periods.
            </p>
            <div className="button-row">
              <button
                type="button"
                className="btn btn-primary"
                data-testid="import-merge"
                onClick={() => {
                  if (confirm('Merge the backup into your current data? Items you already have are kept as they are.')) {
                    onMerge(imported)
                    setImported(null)
                  }
                }}
              >
                Merge into current data
              </button>
              <button
                type="button"
                className="btn btn-danger"
                data-testid="import-replace"
                onClick={() => {
                  if (
                    confirm(
                      snap.configured
                        ? 'Replace ALL current data with the backup? With sync on, this also replaces the synced copy on every device.'
                        : 'Replace ALL current data with the backup?',
                    )
                  ) {
                    onReplace(imported)
                    setImported(null)
                  }
                }}
              >
                Replace everything
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setImported(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {backups.length ? (
          <>
            <h3 className="history-subhead">Automatic backups on this device</h3>
            <div className="list">
              {backups.map((b) => (
                <div className="list-row" key={b.key}>
                  <span className="mono">{b.key}</span>
                  <span className="button-row">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => downloadText(`${b.key}.json`, readKey(b.key) ?? '')}
                    >
                      <Download size={14} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      aria-label={`Delete ${b.key}`}
                      onClick={() => {
                        if (confirm('Delete this backup from this device?')) {
                          removeKey(b.key)
                          setBackupsVersion((v) => v + 1)
                        }
                      }}
                    >
                      ×
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </section>
    </>
  )
}
