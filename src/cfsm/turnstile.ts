/**
 * Cloudflare Turnstile helper for CF-Server-Monitor.
 * Adapted from Tokinx/cf-server-monitor-theme-emerald (MIT), restyled with the Glassmorphism card surface.
 */

interface TurnstileApi {
  render: (container: HTMLElement, options: {
    'sitekey': string
    'theme'?: 'auto' | 'light' | 'dark'
    'callback': (token: string) => void
    'error-callback'?: () => void
    'expired-callback'?: () => void
  }) => string
  remove: (widgetId: string) => void
  reset: (widgetId: string) => void
}

const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

let scriptPromise: Promise<TurnstileApi> | null = null
let tokenPromise: Promise<string> | null = null

function getTurnstile(): TurnstileApi | undefined {
  return (window as unknown as { turnstile?: TurnstileApi }).turnstile
}

function loadTurnstile(): Promise<TurnstileApi> {
  const existing = getTurnstile()
  if (existing)
    return Promise.resolve(existing)
  if (scriptPromise)
    return scriptPromise

  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = TURNSTILE_SCRIPT
    script.async = true
    script.defer = true
    script.onload = () => {
      const api = getTurnstile()
      if (api)
        resolve(api)
      else
        reject(new Error('Turnstile SDK 加载失败'))
    }
    script.onerror = () => {
      scriptPromise = null
      reject(new Error('Turnstile SDK 加载失败'))
    }
    document.head.appendChild(script)
  })
  return scriptPromise
}

/** Show the Turnstile challenge and resolve a one-time token. Concurrent callers share one challenge. */
export function requestTurnstileToken(siteKey: string): Promise<string> {
  if (tokenPromise)
    return tokenPromise
  tokenPromise = requestOnce(siteKey).finally(() => {
    tokenPromise = null
  })
  return tokenPromise
}

async function requestOnce(siteKey: string): Promise<string> {
  const api = await loadTurnstile()
  return new Promise((resolve, reject) => {
    const overlay = document.createElement('div')
    overlay.className = 'fixed inset-0 z-[100] grid place-items-center bg-background/60 px-4 backdrop-blur-md'
    overlay.innerHTML = `
      <div class="node-card w-full max-w-sm rounded-xl p-5">
        <div class="mb-1 text-base font-semibold">访问验证</div>
        <div class="mb-5 text-sm text-muted-foreground">完成 Cloudflare 验证后继续加载监控数据。</div>
        <div data-turnstile class="min-h-16"></div>
      </div>`
    document.body.appendChild(overlay)
    const container = overlay.querySelector<HTMLElement>('[data-turnstile]')
    if (!container) {
      overlay.remove()
      reject(new Error('Turnstile 容器创建失败'))
      return
    }

    let widgetId = ''
    let settled = false
    const cleanup = () => {
      if (widgetId) {
        try {
          api.remove(widgetId)
        }
        catch {}
      }
      overlay.remove()
    }
    const settle = (fn: () => void) => {
      if (settled)
        return
      settled = true
      cleanup()
      fn()
    }

    widgetId = api.render(container, {
      'sitekey': siteKey,
      'theme': document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      'callback': token => settle(() => resolve(token)),
      'error-callback': () => settle(() => reject(new Error('Turnstile 验证失败'))),
      'expired-callback': () => {
        try {
          api.reset(widgetId)
        }
        catch {
          settle(() => reject(new Error('Turnstile 验证已过期')))
        }
      },
    })
  })
}
