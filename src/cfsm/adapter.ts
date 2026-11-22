/**
 * CF-Server-Monitor → Komari data-shape adapter.
 *
 * The Glassmorphism UI was written against Komari's RPC2 types. Instead of touching
 * every component, CFSM payloads are translated into those exact types here, once.
 * Billing / ping-task conventions follow Tokinx/cf-server-monitor-theme-emerald (MIT).
 */
import type { Client, GpuDetailedInfo, NodeStatus, NodeStatusPing, PingTaskInfo, StatusRecord } from '@/utils/rpc'

const MB = 1024 * 1024
const GB = 1024 ** 3
const WHITESPACE = /\s+/
const PRICE_NUMBER = /-?[\d.,]+/
const DEFAULT_ONLINE_THRESHOLD_MS = 5 * 60 * 1000

export interface CfsmLatencyPoint {
  ts?: number | string
  ct?: number | string | boolean | null
  cu?: number | string | boolean | null
  cm?: number | string | boolean | null
  bd?: number | string | boolean | null
}

export type CfsmServer = Record<string, unknown> & {
  id: string
  ping?: CfsmLatencyPoint[]
  loss?: CfsmLatencyPoint[]
}

export interface CfsmSiteConfig {
  version?: string
  last_workers_version?: string | null
  is_public?: boolean | string
  authorization?: boolean
  turnstile_enabled?: boolean | string
  turnstile_site_key?: string
  verified?: boolean
  turnstile_verified?: string | null
  site_title?: string
  theme_options?: unknown
  frontend_ws_timeout_minutes?: number
  long_history_points?: number
  latency_window?: { points?: number, hours?: number }
  custom_ct_name?: string
  custom_cu_name?: string
  custom_cm_name?: string
  custom_bd_name?: string
  node_1_name?: string
  node_2_name?: string
  node_3_name?: string
  node_4_name?: string
}

export interface CfsmSysConfig {
  show_price?: boolean
  show_expire?: boolean
  show_tf?: boolean
  show_three_net_details?: boolean
}

export interface CfsmServersResponse {
  servers?: CfsmServer[]
  sysConfig?: CfsmSysConfig
  latestReportUpdates?: CfsmReportUpdate[]
}

export interface CfsmReportUpdate {
  serverId: string
  samples?: Array<{ ts?: number | string, data?: Record<string, unknown>, payload?: Record<string, unknown>, metrics?: Record<string, unknown> }>
}

export function isEnabled(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}

export function num(value: unknown): number {
  const parsed = Number.parseFloat(String(value ?? 0))
  return Number.isFinite(parsed) ? parsed : 0
}

export function toMs(value: unknown, fallback = 0): number {
  const n = num(value)
  if (!n)
    return fallback
  return n < 1e12 ? n * 1000 : n
}

function has(source: Record<string, unknown>, key: string): boolean {
  const value = source[key]
  return value !== undefined && value !== null && value !== ''
}

// ==================== Ping tasks ====================

export type PingTaskKey = 'ct' | 'cu' | 'cm' | 'bd' | 'node_1' | 'node_2' | 'node_3' | 'node_4'

export interface PingTaskDefinition {
  id: number
  key: PingTaskKey
  latencyField: string
  lossField: string
}

/** Stable numeric task IDs so Komari-style `threeNetPingTaskIds` settings keep working. */
export const PING_TASKS: readonly PingTaskDefinition[] = [
  { id: 1, key: 'ct', latencyField: 'ping_ct', lossField: 'loss_ct' },
  { id: 2, key: 'cu', latencyField: 'ping_cu', lossField: 'loss_cu' },
  { id: 3, key: 'cm', latencyField: 'ping_cm', lossField: 'loss_cm' },
  { id: 4, key: 'bd', latencyField: 'ping_bd', lossField: 'loss_bd' },
  { id: 5, key: 'node_1', latencyField: 'ping_node_1', lossField: 'loss_node_1' },
  { id: 6, key: 'node_2', latencyField: 'ping_node_2', lossField: 'loss_node_2' },
  { id: 7, key: 'node_3', latencyField: 'ping_node_3', lossField: 'loss_node_3' },
  { id: 8, key: 'node_4', latencyField: 'ping_node_4', lossField: 'loss_node_4' },
]

const DEFAULT_TASK_NAMES: Record<PingTaskKey, string> = {
  ct: '电信',
  cu: '联通',
  cm: '移动',
  bd: 'BGP',
  node_1: 'Node 1',
  node_2: 'Node 2',
  node_3: 'Node 3',
  node_4: 'Node 4',
}

let taskNames: Record<PingTaskKey, string> = { ...DEFAULT_TASK_NAMES }

export function applyPingTaskNames(config?: CfsmSiteConfig): void {
  if (!config)
    return
  taskNames = {
    ct: config.custom_ct_name?.trim() || DEFAULT_TASK_NAMES.ct,
    cu: config.custom_cu_name?.trim() || DEFAULT_TASK_NAMES.cu,
    cm: config.custom_cm_name?.trim() || DEFAULT_TASK_NAMES.cm,
    bd: config.custom_bd_name?.trim() || DEFAULT_TASK_NAMES.bd,
    node_1: config.node_1_name?.trim() || DEFAULT_TASK_NAMES.node_1,
    node_2: config.node_2_name?.trim() || DEFAULT_TASK_NAMES.node_2,
    node_3: config.node_3_name?.trim() || DEFAULT_TASK_NAMES.node_3,
    node_4: config.node_4_name?.trim() || DEFAULT_TASK_NAMES.node_4,
  }
}

export function pingTaskName(task: PingTaskDefinition): string {
  return taskNames[task.key]
}

/**
 * CFSM probe value semantics (theme-develop.md §5):
 * `false` / missing = not configured, `null` = timeout this round, number = RTT / loss %.
 */
export type ProbeValue = number | null | undefined

export function probeValue(value: unknown): ProbeValue {
  if (value === undefined || value === false || value === '')
    return undefined
  if (value === null)
    return null
  const n = Number.parseFloat(String(value))
  return Number.isFinite(n) ? n : undefined
}

export function buildPingTaskInfos(servers: CfsmServer[]): PingTaskInfo[] {
  const present = new Set<number>()
  for (const server of servers) {
    for (const task of PING_TASKS) {
      if (probeValue(server[task.latencyField]) !== undefined || probeValue(server[task.lossField]) !== undefined)
        present.add(task.id)
    }
  }
  // The four carrier lines are always listed so the settings editor can preselect them.
  return PING_TASKS
    .filter(task => task.id <= 4 || present.has(task.id))
    .map((task, index) => ({
      id: task.id,
      weight: index,
      name: pingTaskName(task),
      interval: 60,
      loss: 0,
      default_on: task.id <= 3,
      clients: servers.filter(server => probeValue(server[task.latencyField]) !== undefined).map(server => server.id),
    }))
}

// ==================== Billing ====================

const CYCLE_DAYS: Record<string, number> = {
  month: 30,
  monthly: 30,
  quarter: 90,
  quarterly: 90,
  half_year: 180,
  semi_annual: 180,
  year: 365,
  yearly: 365,
  annual: 365,
  two_years: 730,
  three_years: 1095,
  four_years: 1460,
  five_years: 1825,
  once: -1,
  onetime: -1,
  one_time: -1,
}

function parseCycle(value: unknown, legacyPrice: string): number {
  const text = String(value ?? '').trim().toLowerCase()
  if (text) {
    const n = Number(text)
    if (Number.isFinite(n) && n !== 0)
      return n
    const mapped = CYCLE_DAYS[text.replaceAll(' ', '_').replaceAll('-', '_')]
    if (mapped)
      return mapped
  }
  // Legacy free-form price such as "¥30/月" or "$60/3Y".
  const suffix = legacyPrice.split('/')[1]?.trim().toLowerCase()
  if (suffix) {
    const count = Number(suffix.match(/^\d+(?:\.\d+)?/)?.[0] ?? 1)
    if (/半年|half/.test(suffix))
      return 180
    if (/年|y/.test(suffix))
      return 365 * count
    if (/季|q/.test(suffix))
      return 90 * count
    if (/月|m/.test(suffix))
      return 30 * count
    if (/天|d/.test(suffix))
      return count
  }
  return 30
}

function parsePrice(raw: unknown): number {
  const text = String(raw ?? '').trim()
  if (!text)
    return 0 // Komari: 0 = not configured
  if (/^(?:free|免费)$/i.test(text))
    return -1
  const amount = Number.parseFloat((text.split('/')[0]?.match(PRICE_NUMBER)?.[0] ?? '').replaceAll(',', ''))
  if (!Number.isFinite(amount))
    return 0
  // CFSM: "0" or "-1" means free; Komari's free marker is -1.
  if (amount === 0 || amount === -1)
    return -1
  return amount
}

const SYMBOLS = ['HK$', 'NZ$', 'A$', 'C$', 'CA$', 'S$', 'R$', 'Mex$', '¥', '￥', '$', '€', '£', '₽', '₹', '₫', '฿', '₣', '₩', '₺', '₴']

function parseCurrency(raw: unknown, legacyPrice: string): string {
  let text = String(raw ?? '').trim()
  if (!text) {
    text = SYMBOLS.find(symbol => legacyPrice.includes(symbol)) ?? '¥'
  }
  if (text === '￥')
    return '¥'
  // CFSM writes JPY as "¥JPY"; the Glass finance helper understands the ISO code.
  if (/^¥?JPY$/i.test(text))
    return 'JPY'
  return text
}

function parseTrafficLimit(value: unknown): number {
  const text = String(value ?? '').trim().toUpperCase()
  const amount = num(text)
  if (!amount)
    return 0
  if (text.includes('PB'))
    return amount * 1024 ** 5
  if (text.includes('TB'))
    return amount * 1024 ** 4
  if (text.includes('MB'))
    return amount * MB
  if (text.includes('KB'))
    return amount * 1024
  return amount * GB
}

function trafficLimitType(value: unknown): string {
  const type = String(value ?? '').toLowerCase()
  if (type === 'dl' || type === 'down' || type === 'download' || type === 'rx')
    return 'down'
  if (type === 'ul' || type === 'up' || type === 'upload' || type === 'tx')
    return 'up'
  if (type === 'min' || type === 'max')
    return type
  return 'sum'
}

// ==================== GPU ====================

interface CfsmGpu { id?: string | number, name?: string, info?: number | string | null }

function parseGpuList(raw: unknown): CfsmGpu[] {
  if (Array.isArray(raw))
    return raw as CfsmGpu[]
  if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    }
    catch {
      return []
    }
  }
  return []
}

function gpuDetails(raw: unknown): GpuDetailedInfo[] {
  return parseGpuList(raw).map((gpu, index) => ({
    name: gpu.name || `GPU ${gpu.id ?? index}`,
    device_name: gpu.name,
    device_index: Number.isFinite(Number(gpu.id)) ? Number(gpu.id) : index,
    utilization: num(gpu.info),
    usage: num(gpu.info),
  }))
}

// ==================== Servers ====================

export function isServerOnline(server: Record<string, unknown>, now = Date.now()): boolean {
  if (typeof server.is_online === 'boolean')
    return server.is_online
  const updated = toMs(server.report_timestamp ?? server.last_updated ?? server.timestamp)
  const interval = num(server.report_interval) * 1000
  const threshold = Math.max(DEFAULT_ONLINE_THRESHOLD_MS, interval * 3)
  return updated > 0 && now - updated < threshold
}

export function adaptClient(server: CfsmServer): Client {
  const legacyPrice = String(server.price ?? '')
  const gpus = parseGpuList(server.gpu_info)
  const updatedAt = toMs(server.last_updated ?? server.timestamp)
  return {
    uuid: server.id,
    name: String(server.name || server.id),
    cpu_name: String(server.cpu_info || ''),
    virtualization: String(server.virtualization || ''),
    arch: String(server.arch || ''),
    cpu_cores: num(server.cpu_cores),
    os: String(server.os || ''),
    kernel_version: String(server.kernel_version || ''),
    gpu_name: gpus.map(gpu => gpu.name).filter(Boolean).join(' / ') || undefined,
    // CFSM public APIs only expose IPv4 / IPv6 reachability ("0"/"1"), never addresses.
    ipv4: undefined,
    ipv6: undefined,
    region: String(server.region || '').trim().toUpperCase(),
    remark: '',
    public_remark: '',
    mem_total: num(server.ram_total) * MB,
    swap_total: num(server.swap_total) * MB,
    disk_total: num(server.disk_total) * MB,
    version: server.agent_version ? String(server.agent_version) : undefined,
    weight: num(server.sort_order),
    price: parsePrice(server.price),
    billing_cycle: parseCycle(server.billing_cycle, legacyPrice),
    auto_renewal: isEnabled(server.auto_renewal),
    currency: parseCurrency(server.currency, legacyPrice),
    expired_at: String(server.expire_date || server.expired_at || ''),
    group: String(server.server_group || ''),
    // Komari separates tags with ";", CFSM with ",".
    tags: String(server.tags || '').split(/[,;]/).map(tag => tag.trim()).filter(Boolean).join(';'),
    hidden: isEnabled(server.is_hidden),
    traffic_limit: parseTrafficLimit(server.traffic_limit),
    traffic_limit_type: trafficLimitType(server.traffic_calc_type),
    created_at: '',
    updated_at: updatedAt ? new Date(updatedAt).toISOString() : '',
  }
}

function pingSummary(server: Record<string, unknown>): Record<string, NodeStatusPing> | undefined {
  const result: Record<string, NodeStatusPing> = {}
  for (const task of PING_TASKS) {
    const latency = probeValue(server[task.latencyField])
    const loss = probeValue(server[task.lossField])
    if (latency === undefined && loss === undefined)
      continue
    const value = latency === null || latency === undefined || latency <= 0 ? -1 : latency
    result[String(task.id)] = {
      name: pingTaskName(task),
      latest: value,
      avg: value,
      tail: value,
      loss: loss ?? (value < 0 ? 100 : 0),
      min: value,
      max: value,
    }
  }
  return Object.keys(result).length ? result : undefined
}

export function adaptStatus(server: Record<string, unknown> & { id: string }, previous?: NodeStatus | null): NodeStatus {
  const now = Date.now()
  const updatedAt = toMs(server.report_timestamp ?? server.last_updated ?? server.timestamp, previous?.time ? Date.parse(previous.time) : 0)
  const pick = <T>(key: string | string[], map: (value: unknown) => T, fallback: T): T => {
    const keys = Array.isArray(key) ? key : [key]
    const found = keys.find(k => has(server, k))
    return found ? map(server[found]) : fallback
  }
  const load = has(server, 'load_avg')
    ? String(server.load_avg).trim().split(WHITESPACE).map(num)
    : [previous?.load ?? 0, previous?.load5 ?? 0, previous?.load15 ?? 0]
  const gpuInfo = has(server, 'gpu_info') ? gpuDetails(server.gpu_info) : (previous?.gpu_detailed_info ?? [])
  const gpuAverage = gpuInfo.length ? gpuInfo.reduce((sum, gpu) => sum + (gpu.utilization ?? 0), 0) / gpuInfo.length : 0
  const bootTime = toMs(server.boot_time)
  const netUp = pick(['net_tx_monthly', 'net_tx'], num, previous?.net_total_up ?? 0)
  const netDown = pick(['net_rx_monthly', 'net_rx'], num, previous?.net_total_down ?? 0)
  const hasProbe = PING_TASKS.some(task => has(server, task.latencyField) || has(server, task.lossField) || server[task.latencyField] === null)

  return {
    client: server.id,
    time: updatedAt ? new Date(updatedAt).toISOString() : '',
    cpu: pick('cpu', num, previous?.cpu ?? 0),
    gpu: gpuAverage,
    gpu_count: gpuInfo.length,
    gpu_average_usage: gpuInfo.length ? gpuAverage : undefined,
    gpu_detailed_info: gpuInfo.length ? gpuInfo : undefined,
    ram: pick('ram_used', value => num(value) * MB, previous?.ram ?? 0),
    ram_total: pick('ram_total', value => num(value) * MB, previous?.ram_total ?? 0),
    swap: pick('swap_used', value => num(value) * MB, previous?.swap ?? 0),
    swap_total: pick('swap_total', value => num(value) * MB, previous?.swap_total ?? 0),
    load: load[0] ?? 0,
    load5: load[1] ?? load[0] ?? 0,
    load15: load[2] ?? load[1] ?? load[0] ?? 0,
    temp: 0,
    disk: pick('disk_used', value => num(value) * MB, previous?.disk ?? 0),
    disk_total: pick('disk_total', value => num(value) * MB, previous?.disk_total ?? 0),
    net_in: pick('net_in_speed', num, previous?.net_in ?? 0),
    net_out: pick('net_out_speed', num, previous?.net_out ?? 0),
    net_total_up: netUp,
    net_total_down: netDown,
    traffic_up: netUp,
    traffic_down: netDown,
    process: pick('processes', num, previous?.process ?? 0),
    connections: pick('tcp_conn', num, previous?.connections ?? 0),
    connections_udp: pick('udp_conn', num, previous?.connections_udp ?? 0),
    online: isServerOnline({ ...server, last_updated: updatedAt }, now),
    uptime: bootTime ? Math.max(0, Math.floor((now - bootTime) / 1000)) : (previous?.uptime ?? 0),
    updated_at: updatedAt ? new Date(updatedAt).toISOString() : undefined,
    ping: hasProbe ? pingSummary(server) : previous?.ping,
  }
}

// ==================== History ====================

export function historyRowToStatusRecord(uuid: string, row: Record<string, unknown>): StatusRecord {
  const load = String(row.load_avg ?? '').trim().split(WHITESPACE).map(num)
  const gpus = gpuDetails(row.gpu_info)
  const gpuAverage = gpus.length ? gpus.reduce((sum, gpu) => sum + (gpu.utilization ?? 0), 0) / gpus.length : 0
  return {
    client: uuid,
    time: new Date(toMs(row.timestamp, Date.now())).toISOString(),
    cpu: num(row.cpu),
    gpu: gpuAverage,
    gpu_count: gpus.length,
    gpu_average_usage: gpus.length ? gpuAverage : undefined,
    gpu_detailed_info: gpus.length ? gpus : undefined,
    ram: num(row.ram_used) * MB,
    ram_total: num(row.ram_total) * MB,
    swap: num(row.swap_used) * MB,
    swap_total: num(row.swap_total) * MB,
    load: load[0] ?? 0,
    load5: load[1] ?? load[0] ?? 0,
    load15: load[2] ?? load[1] ?? load[0] ?? 0,
    temp: 0,
    disk: num(row.disk_used) * MB,
    disk_total: num(row.disk_total) * MB,
    net_in: num(row.net_in_speed),
    net_out: num(row.net_out_speed),
    // History rows carry no cumulative counters; Komari traffic charts read these fields.
    net_total_up: num(row.net_tx_monthly ?? row.net_tx),
    net_total_down: num(row.net_rx_monthly ?? row.net_rx),
    process: num(row.processes),
    connections: num(row.tcp_conn),
    connections_udp: num(row.udp_conn),
  }
}

export function statusToRecord(status: NodeStatus): StatusRecord {
  return {
    client: status.client,
    time: status.time,
    cpu: status.cpu,
    gpu: status.gpu,
    gpu_count: status.gpu_count,
    gpu_average_usage: status.gpu_average_usage,
    gpu_detailed_info: status.gpu_detailed_info,
    ram: status.ram,
    ram_total: status.ram_total,
    swap: status.swap,
    swap_total: status.swap_total,
    load: status.load,
    load5: status.load5,
    load15: status.load15,
    temp: status.temp,
    disk: status.disk,
    disk_total: status.disk_total,
    net_in: status.net_in,
    net_out: status.net_out,
    net_total_up: status.net_total_up,
    net_total_down: status.net_total_down,
    traffic_up: status.traffic_up,
    traffic_down: status.traffic_down,
    process: status.process,
    connections: status.connections,
    connections_udp: status.connections_udp,
  }
}
