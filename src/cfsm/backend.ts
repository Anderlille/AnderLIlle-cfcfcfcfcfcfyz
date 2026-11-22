/**
 * In-browser "Komari backend" backed by CF-Server-Monitor.
 *
 * utils/rpc.ts and utils/api.ts forward every Komari RPC2 / REST call here, so the
 * Glassmorphism components, composables and services run unchanged on CFSM.
 *
 * CFSM endpoints used (theme-develop.md): GET /api/config, GET /api/servers,
 * GET /api/server?id=, GET /api/history/all?id=&hours=, POST /api/theme_options, /api/ws.
 */
import type { CfsmReportUpdate, CfsmServer, CfsmServersResponse, CfsmSiteConfig, CfsmSysConfig } from '@/cfsm/adapter'
import type {
  Client,
  MetricDefinition,
  MetricQueryParams,
  MetricQueryResponse,
  MetricSeries,
  NodeStatus,
  PingMetricStatsParams,
  PingMetricStatsResponse,
  PingMetricTaskStats,
  PingRecord,
  PingTaskInfo,
  PublicInfo,
  StatusRecord,
} from '@/utils/rpc'
import { toast } from 'vue-sonner'
import {
  adaptClient,
  adaptStatus,
  applyPingTaskNames,
  buildPingTaskInfos,
  historyRowToStatusRecord,
  isEnabled,
  isServerOnline,
  PING_TASKS,
  pingTaskName,
  probeValue,
  statusToRecord,
  toMs,
} from '@/cfsm/adapter'
import { METHOD_NOT_FOUND, RpcError } from '@/cfsm/errors'
import { buildWebSocketUrl, cfsmRequest, CfsmHttpError, runTurnstileChallenge, setTurnstileSiteKey } from '@/cfsm/http'
import { normalizeSavedThemeOptions, resolveThemeSettings } from '@/cfsm/themeOptions'

const PING_LATENCY_METRIC = 'ping.latency_ms'
const PING_LOSS_METRIC = 'ping.loss'
const HISTORY_HOURS = [0.167, 0.5, 1, 6, 12, 24, 48, 96, 168] as const
const HISTORY_TTL_MS = 60_000
const CONFIG_TTL_MS = 2_000
/** Minimum spacing between /api/servers requests in HTTP polling mode (Komari default is 3 s). */
const HTTP_POLL_MIN_MS = 10_000
/** While the push channel is healthy, refresh the list (ping/loss windows, metadata) at this pace. */
const WS_SNAPSHOT_REFRESH_MS = 5 * 60_000
const LIVE_BUFFER_SIZE = 300
const WINDOW_MAX_POINTS = 150
const LEGACY_LOSS_RESOLUTION = 10
const HISTORY_FANOUT_CONCURRENCY = 3
const VISITOR_HISTORY_HOURS = 24

type Params = Record<string, unknown> | unknown[] | undefined

function p(params: Params): Record<string, unknown> {
  return params && !Array.isArray(params) ? params : {}
}

function toRpcError(error: unknown): RpcError {
  if (error instanceof RpcError)
    return error
  if (error instanceof CfsmHttpError)
    return new RpcError(error.status || -32000, error.message)
  return new RpcError(-32000, error instanceof Error ? error.message : String(error))
}

function percentile(sorted: number[], q: number): number | undefined {
  if (!sorted.length)
    return undefined
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

function bucketize<T extends { ts: number }>(points: T[], maxPoints: number | undefined, merge: (bucket: T[]) => T): T[] {
  if (!maxPoints || points.length <= maxPoints)
    return points
  const size = Math.ceil(points.length / maxPoints)
  const out: T[] = []
  for (let i = 0; i < points.length; i += size)
    out.push(merge(points.slice(i, i + size)))
  return out
}

interface ProbeRow {
  ts: number
  latency: number | null
  loss: number | null
}

interface RealtimeState {
  wanted: boolean
  socket: WebSocket | null
  connected: boolean
  /** Closed on purpose (tab hidden or connection time limit); must not trigger reconnect logic. */
  suspended: 'hidden' | 'timeout' | null
  timeoutTimer: ReturnType<typeof setTimeout> | null
  closeListeners: Set<() => void>
}

export class CfsmBackend {
  private config: CfsmSiteConfig | null = null
  private configAt = 0
  private configPromise: Promise<CfsmSiteConfig> | null = null

  private servers = new Map<string, CfsmServer>()
  private statuses = new Map<string, NodeStatus>()
  private sysConfig: CfsmSysConfig = {}
  private serversAt = 0
  private serversPromise: Promise<void> | null = null

  private live = new Map<string, StatusRecord[]>()
  private liveSeededAt = new Map<string, number>()
  private history = new Map<string, { at: number, rows: Array<Record<string, unknown>> }>()
  private historyPromises = new Map<string, Promise<Array<Record<string, unknown>>>>()

  private rt: RealtimeState = { wanted: false, socket: null, connected: false, suspended: null, timeoutTimer: null, closeListeners: new Set() }
  private visibilityBound = false

  // ==================== Config / auth ====================

  async loadConfig(force = false, signal?: AbortSignal): Promise<CfsmSiteConfig> {
    if (!force && this.config && Date.now() - this.configAt < CONFIG_TTL_MS)
      return this.config
    if (this.configPromise)
      return this.configPromise
    this.configPromise = (async () => {
      let config = await cfsmRequest<CfsmSiteConfig>('/api/config', {}, { signal })
      setTurnstileSiteKey(config.turnstile_site_key)
      if (isEnabled(config.turnstile_enabled) && !config.verified && config.turnstile_site_key) {
        if (await runTurnstileChallenge())
          config = await cfsmRequest<CfsmSiteConfig>('/api/config', {}, { signal })
      }
      applyPingTaskNames(config)
      if (config.site_title && typeof document !== 'undefined')
        document.title = config.site_title
      this.config = config
      this.configAt = Date.now()
      return config
    })().finally(() => {
      this.configPromise = null
    })
    return this.configPromise
  }

  get isAdmin(): boolean {
    return Boolean(this.config?.authorization)
  }

  private historyLimitHours(): number {
    return this.isAdmin ? 168 : VISITOR_HISTORY_HOURS
  }

  async publicSettings(signal?: AbortSignal): Promise<PublicInfo> {
    const [config] = await Promise.all([this.loadConfig(false, signal), this.ensureServers(Infinity, signal).catch(() => {})])
    const settings = resolveThemeSettings(config.theme_options)
    // CFSM's site-wide price switch maps onto the theme's "hide price when logged out".
    if (this.sysConfig.show_price === false)
      settings.hidePriceWhenLoggedOut = true
    const limit = this.historyLimitHours()
    return {
      allow_cors: true,
      custom_body: '',
      custom_head: '',
      description: '',
      disable_password_login: false,
      oauth_enable: false,
      oauth_provider: '',
      ping_record_preserve_time: limit,
      private_site: !isEnabled(config.is_public),
      record_enabled: true,
      record_preserve_time: limit,
      sitename: config.site_title || (typeof document !== 'undefined' ? document.title : '') || 'CF Server Monitor',
      theme: 'Glassmorphism',
      theme_settings: settings,
    }
  }

  async saveThemeOptions(settings: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    const next: Record<string, unknown> = { ...settings }
    const saved = normalizeSavedThemeOptions(this.config?.theme_options)
    // Do not persist the read-time override coming from sysConfig.show_price.
    if (this.sysConfig.show_price === false && saved.hidePriceWhenLoggedOut !== true && next.hidePriceWhenLoggedOut === true)
      delete next.hidePriceWhenLoggedOut
    const result = await cfsmRequest<{ theme_options?: unknown }>('/api/theme_options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme_options: next }),
    }, { signal })
    if (this.config)
      this.config = { ...this.config, theme_options: result?.theme_options ?? next }
  }

  // ==================== Server list ====================

  async ensureServers(maxAgeMs: number, signal?: AbortSignal): Promise<void> {
    if (this.serversAt && Date.now() - this.serversAt < maxAgeMs)
      return
    if (this.serversPromise)
      return this.serversPromise
    this.serversPromise = (async () => {
      const response = await cfsmRequest<CfsmServersResponse>('/api/servers', {}, { signal })
      this.sysConfig = response.sysConfig ?? {}
      const seen = new Set<string>()
      for (const server of response.servers ?? []) {
        if (!server?.id)
          continue
        seen.add(server.id)
        const merged = { ...(this.servers.get(server.id) ?? {}), ...server } as CfsmServer
        this.servers.set(server.id, merged)
        this.statuses.set(server.id, adaptStatus(merged, this.statuses.get(server.id)))
      }
      for (const id of [...this.servers.keys()]) {
        if (!seen.has(id)) {
          this.servers.delete(id)
          this.statuses.delete(id)
        }
      }
      this.applyReportUpdates(response.latestReportUpdates)
      this.serversAt = Date.now()
      this.syncSubscription()
    })().finally(() => {
      this.serversPromise = null
    })
    return this.serversPromise
  }

  private applyReportUpdates(updates: CfsmReportUpdate[] | undefined): void {
    for (const update of updates ?? []) {
      const samples = (update.samples ?? [])
        .map(sample => ({ ts: toMs(sample.ts, Date.now()), data: sample.data ?? sample.payload ?? sample.metrics ?? {} }))
        .sort((a, b) => a.ts - b.ts)
      for (const sample of samples)
        this.applySample(update.serverId, sample.ts, sample.data)
    }
  }

  private applySample(serverId: string, ts: number, data: Record<string, unknown>): void {
    const current = this.servers.get(serverId)
    if (!current)
      return
    const currentTs = toMs(current.report_timestamp ?? current.last_updated ?? current.timestamp)
    const merged = { ...current, ...data, id: serverId, last_updated: ts, report_timestamp: ts } as CfsmServer
    const status = adaptStatus(merged, this.statuses.get(serverId))
    // Replayed samples (latestReportUpdates) can be older than the snapshot: they feed the
    // realtime chart buffer but must not overwrite the newer current values.
    if (ts >= currentTs) {
      this.servers.set(serverId, merged)
      this.statuses.set(serverId, status)
    }
    const buffer = this.live.get(serverId) ?? []
    const record = statusToRecord(status)
    if (!buffer.length || Date.parse(buffer.at(-1)!.time) < ts) {
      buffer.push(record)
      if (buffer.length > LIVE_BUFFER_SIZE)
        buffer.splice(0, buffer.length - LIVE_BUFFER_SIZE)
      this.live.set(serverId, buffer)
    }
  }

  private async latestStatuses(signal?: AbortSignal): Promise<Record<string, NodeStatus>> {
    const maxAge = this.rt.connected
      ? WS_SNAPSHOT_REFRESH_MS
      : this.rt.suspended === 'timeout' ? Infinity : HTTP_POLL_MIN_MS
    if (typeof document === 'undefined' || !document.hidden)
      await this.ensureServers(maxAge, signal)
    const now = Date.now()
    const out: Record<string, NodeStatus> = {}
    for (const [id, status] of this.statuses) {
      const server = this.servers.get(id)
      const online = server ? isServerOnline({ ...server, is_online: undefined, last_updated: Date.parse(status.time) || 0 }, now) : status.online
      out[id] = online === status.online ? status : { ...status, online }
    }
    return out
  }

  private async clients(signal?: AbortSignal): Promise<Record<string, Client>> {
    await this.ensureServers(this.rt.connected ? WS_SNAPSHOT_REFRESH_MS : HTTP_POLL_MIN_MS, signal)
    return Object.fromEntries([...this.servers.values()].map(server => [server.id, adaptClient(server)]))
  }

  private async recentStatus(uuid: string, signal?: AbortSignal): Promise<{ count: number, records: StatusRecord[] }> {
    const buffer = this.live.get(uuid) ?? []
    const seededAt = this.liveSeededAt.get(uuid) ?? 0
    if (buffer.length < 2 && Date.now() - seededAt > 60_000) {
      this.liveSeededAt.set(uuid, Date.now())
      try {
        const detail = await cfsmRequest<Record<string, unknown> & { latestReportUpdates?: CfsmReportUpdate[] }>(`/api/server?id=${encodeURIComponent(uuid)}`, {}, { signal })
        if (detail && !this.servers.has(uuid))
          this.servers.set(uuid, { ...detail, id: uuid } as CfsmServer)
        this.applyReportUpdates(detail?.latestReportUpdates)
      }
      catch {}
    }
    const records = [...(this.live.get(uuid) ?? [])]
    if (!records.length) {
      const status = this.statuses.get(uuid)
      if (status)
        records.push(statusToRecord(status))
    }
    return { count: records.length, records }
  }

  // ==================== History ====================

  private resolveHours(params: Record<string, unknown>): { hours: number, start?: number, end?: number } {
    const startRaw = params.start ?? params.start_time
    const endRaw = params.end ?? params.end_time
    const start = startRaw !== undefined ? Date.parse(String(startRaw)) || toMs(startRaw) : undefined
    const end = endRaw !== undefined ? Date.parse(String(endRaw)) || toMs(endRaw) : undefined
    let hours = Number(params.hours)
    if (start && Number.isFinite(start))
      hours = Math.ceil((Date.now() - start) / 3_600_000)
    if (!Number.isFinite(hours) || hours <= 0)
      hours = 1
    return { hours, start: start && Number.isFinite(start) ? start : undefined, end: end && Number.isFinite(end) ? end : undefined }
  }

  private async historyRows(id: string, requestedHours: number, signal?: AbortSignal): Promise<Array<Record<string, unknown>>> {
    await this.loadConfig(false, signal).catch(() => null)
    // CFSM returns 401 for visitors asking for more than 24 h; clamp instead of failing the whole chart.
    const target = Math.min(requestedHours, this.historyLimitHours())
    const hours = HISTORY_HOURS.find(value => value >= target) ?? 168
    const key = `${id}:${hours}`
    const cached = this.history.get(key)
    if (cached && Date.now() - cached.at < HISTORY_TTL_MS)
      return cached.rows
    const pending = this.historyPromises.get(key)
    if (pending)
      return pending
    const promise = cfsmRequest<Array<Record<string, unknown>>>(`/api/history/all?id=${encodeURIComponent(id)}&hours=${hours}`, {}, { signal })
      .then((rows) => {
        const sorted = (Array.isArray(rows) ? rows : []).sort((a, b) => toMs(a.timestamp) - toMs(b.timestamp))
        this.history.set(key, { at: Date.now(), rows: sorted })
        return sorted
      })
      .finally(() => this.historyPromises.delete(key))
    this.historyPromises.set(key, promise)
    return promise
  }

  private async loadRecords(uuid: string, hours: number, maxCount?: number, signal?: AbortSignal): Promise<StatusRecord[]> {
    const rows = await this.historyRows(uuid, hours, signal)
    const since = Date.now() - hours * 3_600_000
    const records = rows.filter(row => toMs(row.timestamp) >= since - 60_000).map(row => historyRowToStatusRecord(uuid, row))
    if (maxCount && records.length > maxCount) {
      const step = records.length / maxCount
      return Array.from({ length: maxCount }, (_, i) => records[Math.floor(i * step)]!)
    }
    return records
  }

  private async visibleServerIds(signal?: AbortSignal): Promise<string[]> {
    await this.ensureServers(Infinity, signal)
    return [...this.servers.keys()]
  }

  private async allLoadRecords(hours: number, maxCount?: number, signal?: AbortSignal): Promise<Record<string, StatusRecord[]>> {
    const ids = await this.visibleServerIds(signal)
    const result: Record<string, StatusRecord[]> = {}
    let index = 0
    const worker = async () => {
      while (index < ids.length) {
        const id = ids[index++]!
        try {
          result[id] = await this.loadRecords(id, hours, maxCount ? Math.ceil(maxCount / Math.max(1, ids.length)) : undefined, signal)
        }
        catch {
          result[id] = []
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(HISTORY_FANOUT_CONCURRENCY, ids.length) }, worker))
    return result
  }

  /** Per-task probe rows. Short ranges come from /api/servers windows (no extra D1 reads); longer ones from /api/history/all. */
  private async probeRows(uuid: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Map<number, ProbeRow[]>> {
    const { hours, start, end } = this.resolveHours(params)
    const maxPoints = Number(params.max_points ?? params.downsample_points) || undefined
    const windowHours = Number(this.config?.latency_window?.hours) || 2
    const useWindow = !start && hours <= windowHours && (maxPoints ?? Infinity) <= WINDOW_MAX_POINTS
    const byTask = new Map<number, ProbeRow[]>()

    if (useWindow) {
      await this.ensureServers(this.rt.connected ? WS_SNAPSHOT_REFRESH_MS : HTTP_POLL_MIN_MS, signal)
      const server = this.servers.get(uuid)
      const lossByTs = new Map((server?.loss ?? []).map(point => [toMs(point.ts), point]))
      for (const task of PING_TASKS.slice(0, 4)) {
        const rows: ProbeRow[] = []
        for (const point of server?.ping ?? []) {
          const ts = toMs(point.ts)
          const latency = probeValue(point[task.key as 'ct'])
          const loss = probeValue(lossByTs.get(ts)?.[task.key as 'ct'])
          if (latency === undefined && loss === undefined)
            continue
          rows.push({ ts, latency: latency !== null && latency !== undefined && latency > 0 ? latency : null, loss: loss ?? (latency === null ? 100 : 0) })
        }
        if (rows.length)
          byTask.set(task.id, rows)
      }
      return byTask
    }

    const rows = await this.historyRows(uuid, hours, signal)
    const since = start ?? Date.now() - hours * 3_600_000
    const until = end ?? Infinity
    for (const task of PING_TASKS) {
      const taskRows: ProbeRow[] = []
      for (const row of rows) {
        const ts = toMs(row.timestamp)
        if (ts < since || ts > until)
          continue
        const latency = probeValue(row[task.latencyField])
        const loss = probeValue(row[task.lossField])
        // History columns default to 0 when a probe is not configured.
        const hasLatency = typeof latency === 'number' && latency > 0
        const hasLoss = typeof loss === 'number' && loss > 0
        if (!hasLatency && !hasLoss && latency !== null)
          continue
        taskRows.push({ ts, latency: hasLatency ? latency : null, loss: typeof loss === 'number' ? loss : (hasLatency ? 0 : 100) })
      }
      if (taskRows.length)
        byTask.set(task.id, bucketize(taskRows, maxPoints, (bucket) => {
          const lat = bucket.map(row => row.latency).filter((v): v is number => v !== null)
          const loss = bucket.map(row => row.loss).filter((v): v is number => v !== null)
          return {
            ts: bucket[Math.floor(bucket.length / 2)]!.ts,
            latency: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null,
            loss: loss.length ? loss.reduce((a, b) => a + b, 0) / loss.length : null,
          }
        }))
    }
    return byTask
  }

  private taskTags(taskId: number): Record<string, unknown> {
    const task = PING_TASKS.find(item => item.id === taskId)!
    return { task_id: String(taskId), task_name: pingTaskName(task) }
  }

  private async queryMetrics(params: Record<string, unknown>, signal?: AbortSignal): Promise<MetricQueryResponse> {
    const keys = new Set<string>([
      ...((params.metric_keys as string[] | undefined) ?? []),
      ...((params.metrics as string[] | undefined) ?? []),
      ...(params.metric_key ? [String(params.metric_key)] : []),
    ])
    const entityIds = [
      ...(params.entity_id ? [String(params.entity_id)] : []),
      ...((params.entity_ids as string[] | undefined) ?? []),
    ]
    const { hours } = this.resolveHours(params)
    const series: MetricSeries[] = []
    for (const entityId of entityIds) {
      if (!keys.has(PING_LATENCY_METRIC) && !keys.has(PING_LOSS_METRIC))
        continue
      const byTask = await this.probeRows(entityId, params, signal)
      for (const [taskId, rows] of byTask) {
        const tags = this.taskTags(taskId)
        if (keys.has(PING_LATENCY_METRIC)) {
          series.push({
            metric_key: PING_LATENCY_METRIC,
            entity_id: entityId,
            type: 'gauge',
            unit: 'ms',
            tags,
            downsampled: true,
            count: rows.length,
            interval_seconds: 60,
            points: rows.map(row => ({ time: new Date(row.ts).toISOString(), value: row.latency, count: 1 })),
          })
        }
        if (keys.has(PING_LOSS_METRIC)) {
          series.push({
            metric_key: PING_LOSS_METRIC,
            entity_id: entityId,
            type: 'gauge',
            unit: 'ratio',
            tags,
            downsampled: true,
            count: rows.length,
            interval_seconds: 60,
            points: rows.map(row => ({ time: new Date(row.ts).toISOString(), value: row.loss === null ? null : row.loss / 100, count: 1 })),
          })
        }
      }
    }
    const end = new Date()
    return {
      start: new Date(end.getTime() - hours * 3_600_000).toISOString(),
      end: end.toISOString(),
      series,
      count: series.length,
    }
  }

  private async pingMetricStats(params: Record<string, unknown>, signal?: AbortSignal): Promise<PingMetricStatsResponse> {
    const entityIds = [
      ...(params.uuid ? [String(params.uuid)] : []),
      ...(params.entity_id ? [String(params.entity_id)] : []),
      ...((params.entity_ids as string[] | undefined) ?? []),
    ]
    const { hours } = this.resolveHours(params)
    const stats: PingMetricTaskStats[] = []
    for (const entityId of [...new Set(entityIds)]) {
      const byTask = await this.probeRows(entityId, params, signal)
      for (const [taskId, rows] of byTask) {
        const valid = rows.map(row => row.latency).filter((v): v is number => v !== null).sort((a, b) => a - b)
        const losses = rows.map(row => row.loss).filter((v): v is number => v !== null)
        const avg = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : undefined
        const variance = avg !== undefined && valid.length > 1 ? valid.reduce((sum, v) => sum + (v - avg) ** 2, 0) / valid.length : undefined
        const p50 = percentile(valid, 0.5)
        const p99 = percentile(valid, 0.99)
        const latestRow = [...rows].reverse().find(row => row.latency !== null)
        const task = PING_TASKS.find(item => item.id === taskId)!
        stats.push({
          entity_id: entityId,
          task_id: String(taskId),
          name: pingTaskName(task),
          type: 'icmp',
          interval: 60,
          tags: this.taskTags(taskId),
          total: rows.length,
          valid: valid.length,
          loss: losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0,
          loss_approximate: false,
          min: valid[0],
          max: valid.at(-1),
          avg,
          latest: latestRow?.latency ?? undefined,
          p50,
          p99,
          stddev: variance !== undefined ? Math.sqrt(variance) : undefined,
          p99_p50_ratio: p50 && p99 ? p99 / p50 : undefined,
        })
      }
    }
    const end = new Date()
    return { start: new Date(end.getTime() - hours * 3_600_000).toISOString(), end: end.toISOString(), interval_seconds: 60, stats, count: stats.length }
  }

  /** Komari legacy ping records: one row per probe; loss is expressed as a share of `value: -1` rows. */
  private probeRowsToLegacy(uuid: string, byTask: Map<number, ProbeRow[]>): PingRecord[] {
    const records: PingRecord[] = []
    for (const [taskId, rows] of byTask) {
      for (const row of rows) {
        const time = new Date(row.ts).toISOString()
        const lost = Math.round(Math.min(100, Math.max(0, row.loss ?? 0)) / 100 * LEGACY_LOSS_RESOLUTION)
        for (let i = 0; i < LEGACY_LOSS_RESOLUTION; i++) {
          const isLost = i < lost || row.latency === null
          records.push({ client: uuid, task_id: taskId, time, value: isLost ? -1 : row.latency! })
        }
      }
    }
    return records
  }

  private async legacyPingRecords(params: Record<string, unknown>, signal?: AbortSignal): Promise<{ count: number, records: PingRecord[], tasks: PingTaskInfo[] }> {
    const uuid = params.uuid ? String(params.uuid) : ''
    const taskFilter = params.task_id !== undefined && Number(params.task_id) > 0 ? Number(params.task_id) : null
    const ids = uuid ? [uuid] : await this.visibleServerIds(signal)
    const records: PingRecord[] = []
    for (const id of ids) {
      // All-node requests (health summary) always use the list windows to avoid one D1 query per server.
      const probeParams = uuid
        ? { ...params, max_points: params.max_points ?? params.max_count ?? params.maxCount }
        : { ...params, hours: Math.min(Number(params.hours) || 1, 2), max_points: WINDOW_MAX_POINTS }
      const byTask = await this.probeRows(id, probeParams, signal)
      if (taskFilter !== null) {
        for (const key of [...byTask.keys()]) {
          if (key !== taskFilter)
            byTask.delete(key)
        }
      }
      records.push(...this.probeRowsToLegacy(id, byTask))
    }
    const tasks = buildPingTaskInfos([...this.servers.values()]).filter(task => records.some(record => record.task_id === task.id))
    return { count: records.length, records, tasks }
  }

  private metricDefinitions(): MetricDefinition[] {
    const retention = Math.ceil(this.historyLimitHours() / 24)
    return [
      { name: PING_LATENCY_METRIC, description: 'Ping latency', type: 'gauge', unit: 'ms', retention_days: retention },
      { name: PING_LOSS_METRIC, description: 'Ping loss ratio', type: 'gauge', unit: 'ratio', retention_days: retention },
    ]
  }

  // ==================== RPC dispatch ====================

  async call<T>(method: string, params?: Params, signal?: AbortSignal): Promise<T> {
    try {
      return await this.dispatch(method, p(params), signal) as T
    }
    catch (error) {
      throw toRpcError(error)
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    switch (method) {
      case 'rpc.ping': {
        const config = await this.loadConfig(true, signal)
        if (!isEnabled(config.is_public) && !config.authorization)
          throw new RpcError(401, 'Private site')
        return 'pong'
      }
      case 'rpc.getVersion':
      case 'common:getBackendVersion':
      case 'public:getVersion': {
        const config = await this.loadConfig(false, signal)
        return { version: config.version ?? '', hash: '' }
      }
      case 'rpc.getMethods':
        return ['common:getNodes', 'common:getNodesLatestStatus', 'common:getRecords', 'public:queryMetrics', 'public:getPingMetricStats']
      case 'common:getNodes':
        return this.clients(signal)
      case 'public:getNodesInformation':
        return Object.values(await this.clients(signal))
      case 'common:getNodesLatestStatus':
        return this.latestStatuses(signal)
      case 'common:getNodeRecentStatus':
        return this.recentStatus(String(params.uuid ?? ''), signal)
      case 'public:getClientRecentRecords':
        return (await this.recentStatus(String(params.uuid ?? ''), signal)).records
      case 'common:getPublicInfo':
      case 'public:getPublicSettings':
        return this.publicSettings(signal)
      case 'public:getMe':
        return this.me(signal)
      case 'common:getRecords': {
        if (params.type === 'ping')
          return this.legacyPingRecords(params, signal)
        const hours = Number(params.hours) || 1
        const maxCount = Number(params.max_count ?? params.maxCount) || undefined
        if (params.uuid)
          return { records: await this.loadRecords(String(params.uuid), hours, maxCount, signal) }
        return { records: await this.allLoadRecords(hours, maxCount, signal) }
      }
      case 'public:getRecordsByUUID': {
        const records = await this.loadRecords(String(params.uuid ?? ''), Number(params.hours) || 1, undefined, signal)
        return { count: records.length, records }
      }
      case 'public:getPingRecords':
        return this.legacyPingRecords(params, signal)
      case 'public:getPublicPingTasks':
        await this.ensureServers(Infinity, signal)
        return buildPingTaskInfos([...this.servers.values()])
      case 'public:listMetricDefinitions':
        await this.loadConfig(false, signal)
        return this.metricDefinitions()
      case 'public:queryMetrics':
        return this.queryMetrics(params as MetricQueryParams, signal)
      case 'public:getPingMetricStats':
        return this.pingMetricStats(params as PingMetricStatsParams, signal)
      case 'public:recordVisitorEvent':
        return { status: 'disabled' }
      case 'admin:getLogs':
      case 'admin:editSettings':
        throw new RpcError(METHOD_NOT_FOUND, 'CF-Server-Monitor 未提供审计日志接口')
      default:
        throw new RpcError(METHOD_NOT_FOUND, `Method not supported on CF-Server-Monitor: ${method}`)
    }
  }

  async me(signal?: AbortSignal): Promise<{ logged_in: boolean, username: string }> {
    const config = await this.loadConfig(true, signal)
    return { logged_in: Boolean(config.authorization), username: config.authorization ? 'admin' : '' }
  }

  // ==================== Realtime (/api/ws push) ====================

  setRealtimeWanted(wanted: boolean): void {
    this.rt.wanted = wanted
    if (!wanted)
      this.closeSocket()
  }

  isRealtimeConnected(): boolean {
    return this.rt.connected
  }

  onRealtimeClose(listener: () => void): () => void {
    this.rt.closeListeners.add(listener)
    return () => this.rt.closeListeners.delete(listener)
  }

  private bindVisibility(): void {
    if (this.visibilityBound || typeof document === 'undefined')
      return
    this.visibilityBound = true
    document.addEventListener('visibilitychange', () => {
      if (!this.rt.wanted)
        return
      if (document.hidden) {
        // theme-develop.md: close the socket while hidden to save quota; keep last data on screen.
        if (this.rt.socket) {
          this.rt.suspended = 'hidden'
          this.closeSocket()
        }
      }
      else if (this.rt.suspended === 'hidden') {
        this.rt.suspended = null
        void this.ensureServers(0).catch(() => {}).then(() => this.connectRealtime().catch(() => this.emitClose()))
      }
    })
  }

  private subscribedIds = ''

  private syncSubscription(): void {
    const socket = this.rt.socket
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return
    const ids = [...this.servers.keys()].slice(0, 500)
    const key = ids.join(',')
    if (key === this.subscribedIds)
      return
    this.subscribedIds = key
    socket.send(JSON.stringify({ type: 'subscribe', scope: 'all', ids }))
  }

  private emitClose(): void {
    this.rt.closeListeners.forEach(listener => listener())
  }

  private closeSocket(): void {
    if (this.rt.timeoutTimer) {
      clearTimeout(this.rt.timeoutTimer)
      this.rt.timeoutTimer = null
    }
    const socket = this.rt.socket
    this.rt.socket = null
    this.rt.connected = false
    if (socket) {
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      try {
        socket.close()
      }
      catch {}
    }
  }

  private armConnectionTimeout(): void {
    const minutes = Number(this.config?.frontend_ws_timeout_minutes) || 0
    if (minutes <= 0)
      return
    this.rt.timeoutTimer = setTimeout(() => {
      this.rt.suspended = 'timeout'
      this.closeSocket()
      toast.info(`实时连接已持续 ${minutes} 分钟，已暂停实时更新`, {
        duration: Number.POSITIVE_INFINITY,
        action: {
          label: '继续实时更新',
          onClick: () => {
            this.rt.suspended = null
            void this.ensureServers(0).catch(() => {}).then(() => this.connectRealtime().catch(() => this.emitClose()))
          },
        },
      })
    }, minutes * 60_000)
  }

  async connectRealtime(timeoutMs = 10_000): Promise<void> {
    this.rt.wanted = true
    this.bindVisibility()
    if (this.rt.connected && this.rt.socket?.readyState === WebSocket.OPEN)
      return
    if (this.rt.suspended === 'timeout')
      return
    if (typeof document !== 'undefined' && document.hidden) {
      // Connect when the tab becomes visible again (see bindVisibility).
      this.rt.suspended = 'hidden'
      return
    }
    await this.loadConfig(false).catch(() => null)
    await this.ensureServers(Infinity).catch(() => {})
    this.closeSocket()

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const socket = new WebSocket(buildWebSocketUrl('all'))
      this.rt.socket = socket
      const timer = setTimeout(() => {
        if (settled)
          return
        settled = true
        this.closeSocket()
        reject(new RpcError(-32001, 'WebSocket connection timeout'))
      }, timeoutMs)

      socket.onopen = () => {
        this.subscribedIds = ''
        this.syncSubscription()
        this.rt.connected = true
        this.armConnectionTimeout()
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve()
        }
      }
      socket.onerror = () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          this.closeSocket()
          reject(new RpcError(-32000, 'WebSocket connection error'))
        }
      }
      socket.onclose = () => {
        const wasConnected = this.rt.connected
        this.rt.socket = null
        this.rt.connected = false
        if (this.rt.timeoutTimer) {
          clearTimeout(this.rt.timeoutTimer)
          this.rt.timeoutTimer = null
        }
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new RpcError(-32000, 'WebSocket closed'))
          return
        }
        if (wasConnected && !this.rt.suspended)
          this.emitClose()
      }
      socket.onmessage = (event) => {
        let message: { type?: string, ts?: number, updates?: Array<{ serverId: string, samples?: Array<Record<string, unknown>> }> }
        try {
          message = JSON.parse(String(event.data))
        }
        catch {
          return
        }
        if (message.type !== 'batchUpdate')
          return
        for (const update of message.updates ?? []) {
          const samples = (update.samples ?? [])
            .map((sample) => {
              const data = (sample.data ?? sample.payload ?? sample.metrics) as Record<string, unknown> | undefined
              return data ? { ts: toMs(sample.ts ?? sample.timestamp ?? data.sample_timestamp ?? data.last_updated ?? message.ts, Date.now()), data } : null
            })
            .filter((sample): sample is { ts: number, data: Record<string, unknown> } => Boolean(sample))
            .sort((a, b) => a.ts - b.ts)
          for (const sample of samples)
            this.applySample(update.serverId, sample.ts, sample.data)
        }
      }
    })
  }

  closeRealtime(): void {
    this.rt.suspended = null
    this.closeSocket()
  }

  realtimeReadyState(): number {
    return this.rt.socket?.readyState ?? WebSocket.CLOSED
  }

  realtimeSocket(): WebSocket | null {
    return this.rt.socket
  }
}

export const cfsmBackend = new CfsmBackend()
