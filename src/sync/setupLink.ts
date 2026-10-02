export interface SetupLink {
  endpoint: string
  token: string
  device?: string
}

/**
 * One-time setup link: https://…/steady/#sync-url=<url-encoded /exec URL>&sync-token=<token>[&sync-device=phone]
 * The fragment is never sent to any server. After reading it we strip it from the address bar.
 */
export function readSetupFragment(hash: string): SetupLink | null {
  const text = hash.startsWith('#') ? hash.slice(1) : hash
  if (!text.includes('sync-url=')) return null
  const params = new URLSearchParams(text)
  const endpoint = params.get('sync-url')?.trim() ?? ''
  const token = params.get('sync-token')?.trim() ?? ''
  if (!/^https?:\/\//i.test(endpoint) || token.length < 24) return null
  const device = params.get('sync-device')?.trim() || undefined
  return { endpoint, token, device }
}

export function consumeSetupFragment(): SetupLink | null {
  if (typeof window === 'undefined') return null
  const hash = window.location.hash
  if (!hash.includes('sync-url=')) return null
  const link = readSetupFragment(hash)
  // Strip the fragment either way so the token does not linger in the address bar.
  window.history.replaceState(null, '', window.location.pathname + window.location.search)
  return link
}

export function buildSetupLink(appUrl: string, link: SetupLink) {
  const params = new URLSearchParams()
  params.set('sync-url', link.endpoint)
  params.set('sync-token', link.token)
  if (link.device) params.set('sync-device', link.device)
  return `${appUrl.split('#')[0]}#${params.toString()}`
}
