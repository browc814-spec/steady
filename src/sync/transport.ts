import type { WireItem } from './items.ts'

export interface SyncResponse {
  ok: boolean
  rev: number
  schemaVersion?: number
  stale?: boolean
  unchanged?: boolean
  items?: WireItem[]
  applied?: number
  rejected?: string[]
  inboxProcessed?: number
  itemCount?: number
  error?: string
  message?: string
}

export class OfflineError extends Error {}
export class ServerError extends Error {
  code: string
  constructor(code: string, message?: string) {
    super(message ? `${code}: ${message}` : code)
    this.code = code
  }
}

export type Transport = (endpoint: string, payload: Record<string, unknown>) => Promise<SyncResponse>

/**
 * POST JSON as text/plain (a "simple" CORS request: Apps Script cannot answer preflights).
 * Apps Script replies with a 302 to script.googleusercontent.com, which fetch follows.
 */
export const fetchTransport: Transport = async (endpoint, payload) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    })
  } catch (e) {
    throw new OfflineError(e instanceof Error ? e.message : 'network error')
  } finally {
    clearTimeout(timer)
  }
  const text = await res.text()
  let body: SyncResponse
  try {
    body = JSON.parse(text) as SyncResponse
  } catch {
    throw new ServerError(
      'bad_response',
      `HTTP ${res.status}; not JSON. Check the URL ends in /exec and access is "Anyone".`,
    )
  }
  if (!body.ok) throw new ServerError(body.error || 'error', body.message)
  return body
}
