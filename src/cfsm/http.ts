/**
 * Low-level HTTP client for the CF-Server-Monitor public API.
 * Auth/Turnstile handling follows theme-develop.md and Tokinx/cf-server-monitor-theme-emerald (MIT).
 */
import { requestTurnstileToken } from '@/cfsm/turnstile'

const TRAILING_SLASHES = /\/+$/

export class CfsmHttpError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'CfsmHttpError'
    this.status = status
  }
}

/** Same-origin by default; a static deployment may set `<meta name="apiBase" content="https://worker.example.com">`. Only the first base is used. */
export function getApiBase(): string {
  if (typeof document !== 'undefined') {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="apiBase"]')?.content
    const first = meta?.split(',').map(item => item.trim()).find(Boolean)
    if (first)
      return first.replace(TRAILING_SLASHES, '')
  }
  const env = import.meta.env.VITE_API_BASE as string | undefined
  if (env)
    return env.replace(TRAILING_SLASHES, '').replace(/\/api$/, '')
  return typeof window === 'undefined' ? '' : window.location.origin
}

export function isCrossOrigin(): boolean {
  try {
    return new URL(getApiBase(), window.location.origin).origin !== window.location.origin
  }
  catch {
    return false
  }
}

function storageGet(key: string): string {
  try {
    return localStorage.getItem(key)?.trim() ?? ''
  }
  catch {
    return ''
  }
}

function storageSet(key: string, value: string | null): void {
  try {
    if (value === null)
      localStorage.removeItem(key)
    else
      localStorage.setItem(key, value)
  }
  catch {}
}

function baseHost(): string {
  try {
    return new URL(getApiBase(), window.location.origin).hostname
  }
  catch {
    return ''
  }
}

/** JWT written by the CF-Server-Monitor admin panel after login. */
export function getJwtToken(): string {
  return storageGet('jwt_token')
}

function authHeaders(initial?: HeadersInit): Headers {
  const headers = new Headers(initial)
  const token = getJwtToken()
  if (token)
    headers.set('Authorization', `Bearer ${token}`)
  const turnstileToken = storageGet('turnstile_token')
  const host = baseHost()
  const verified = (host ? storageGet(`turnstile_verified_${host}`) : '') || storageGet('turnstile_verified')
  if (turnstileToken)
    headers.set('X-Turnstile-Token', turnstileToken)
  else if (verified)
    headers.set('X-Turnstile-Verified', verified)
  return headers
}

export function getTurnstileVerified(): string {
  const host = baseHost()
  return (host ? storageGet(`turnstile_verified_${host}`) : '') || storageGet('turnstile_verified')
}

function storeVerified(verified: string): void {
  const host = baseHost()
  if (host)
    storageSet(`turnstile_verified_${host}`, verified)
  storageSet('turnstile_verified', verified)
  storageSet('turnstile_token', null)
}

function clearTurnstile(): void {
  const host = baseHost()
  if (host)
    storageSet(`turnstile_verified_${host}`, null)
  storageSet('turnstile_verified', null)
  storageSet('turnstile_token', null)
}

let turnstileSiteKey = ''
let refreshPromise: Promise<boolean> | null = null

export function setTurnstileSiteKey(siteKey: string | undefined): void {
  turnstileSiteKey = siteKey?.trim() ?? ''
}

/** Ask the visitor to pass Turnstile, then exchange the one-time token for a reusable verified credential. */
export async function runTurnstileChallenge(): Promise<boolean> {
  if (refreshPromise)
    return refreshPromise
  refreshPromise = (async () => {
    if (!turnstileSiteKey)
      return false
    try {
      const token = await requestTurnstileToken(turnstileSiteKey)
      storageSet('turnstile_token', token)
      await cfsmRequest('/api/config', {}, { allowTurnstileRetry: false })
      return true
    }
    catch {
      return false
    }
  })().finally(() => {
    refreshPromise = null
  })
  return refreshPromise
}

function linkSignal(controller: AbortController, signal?: AbortSignal): () => void {
  if (!signal)
    return () => {}
  const abort = () => controller.abort()
  if (signal.aborted) {
    abort()
    return () => {}
  }
  signal.addEventListener('abort', abort, { once: true })
  return () => signal.removeEventListener('abort', abort)
}

export interface CfsmRequestOptions {
  signal?: AbortSignal
  timeout?: number
  allowTurnstileRetry?: boolean
}

export async function cfsmRequest<T>(path: string, init: RequestInit = {}, options: CfsmRequestOptions = {}): Promise<T> {
  const { signal, timeout = 30_000, allowTurnstileRetry = true } = options
  const controller = new AbortController()
  const unlink = linkSignal(controller, signal)
  const timer = setTimeout(() => controller.abort(), timeout)
  let response: Response
  try {
    response = await fetch(`${getApiBase()}${path}`, {
      ...init,
      headers: authHeaders(init.headers),
      credentials: isCrossOrigin() ? 'omit' : 'include',
      signal: controller.signal,
    })
  }
  catch (error) {
    clearTimeout(timer)
    unlink()
    if (signal?.aborted)
      throw new CfsmHttpError('Request aborted', 0)
    throw new CfsmHttpError(isCrossOrigin()
      ? '跨域请求被浏览器拦截，请在 Worker 环境变量 CORS_ALLOWED_ORIGINS 中加入当前站点'
      : `Network error: ${error instanceof Error ? error.message : String(error)}`, 0)
  }
  clearTimeout(timer)
  unlink()

  let data: unknown = null
  try {
    data = await response.json()
  }
  catch {}

  if (!response.ok) {
    if (response.status === 403) {
      clearTurnstile()
      if (allowTurnstileRetry && await runTurnstileChallenge())
        return cfsmRequest<T>(path, init, { ...options, allowTurnstileRetry: false })
    }
    const message = data && typeof data === 'object' && 'error' in data
      ? String((data as { error: unknown }).error)
      : data && typeof data === 'object' && 'message' in data
        ? String((data as { message: unknown }).message)
        : `HTTP ${response.status}`
    throw new CfsmHttpError(message, response.status)
  }

  if (data && typeof data === 'object' && 'turnstile_verified' in data) {
    const verified = String((data as { turnstile_verified?: unknown }).turnstile_verified || '')
    if (verified)
      storeVerified(verified)
  }
  return data as T
}

export function buildWebSocketUrl(subscribe: string): string {
  const url = new URL(`${getApiBase()}/api/ws`, window.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('subscribe', subscribe)
  // Same-origin uses the cfsm_auth cookie; cross-origin needs the JWT in the query (see theme-develop.md §3).
  const token = getJwtToken()
  if (token && isCrossOrigin())
    url.searchParams.set('token', token)
  return url.toString()
}

export const ADMIN_URL = '/admin#/admin'
