import { cfsmBackend } from '@/cfsm/backend'
import { RpcError } from '@/cfsm/errors'

/**
 * Komari API 客户端 SDK
 * 基于 REST API 的 Komari 客户端
 * @see https://www.komari.wiki/dev/api.html
 */

const HTTP_PROTOCOL_REGEX = /^http/
const HTTPS_PROTOCOL_REGEX = /^https/

// ==================== 类型定义 ====================

/** 用户信息 */
export interface MeInfo {
  'logged_in': boolean
  'username': string
  '2fa_enabled'?: boolean
  'sso_id'?: string
  'sso_type'?: string
  'uuid'?: string
}

/** 公开站点属性 */
export interface PublicSettings {
  allow_cors: boolean
  custom_body: string
  custom_head: string
  description: string
  disable_password_login: boolean
  oauth_enable: boolean
  oauth_provider: string | null
  ping_record_preserve_time?: number
  private_site: boolean
  record_enabled?: boolean
  record_preserve_time?: number
  sitename: string
  theme: string
  theme_settings?: Record<string, unknown> | null
  visitor_audit_enabled?: boolean
  /** 数据更新间隔（秒），主题配置项 */
  dataUpdateInterval?: number
}

/** 版本信息 */
export interface VersionInfo {
  hash: string
  version: string
}

/** 节点信息 */
export interface NodeInfo {
  uuid: string
  name: string
  cpu_name: string
  virtualization: string
  arch: string
  cpu_cores: number
  cpu_physical_cores?: number
  os: string
  kernel_version: string
  gpu_name: string
  region: string
  mem_total: number
  swap_total: number
  disk_total: number
  weight: number
  price: number
  billing_cycle: number
  auto_renewal: boolean
  currency: string
  expired_at: string | null
  group: string
  tags: string
  public_remark: string
  hidden: boolean
  traffic_limit: number
  traffic_limit_type: string
  created_at: string
  updated_at: string
}

/** 实时状态数据（嵌套结构） */
export interface RealtimeStatus {
  cpu: {
    usage: number
  }
  ram: {
    total: number
    used: number
  }
  swap: {
    total: number
    used: number
  }
  load: {
    load1: number
    load5: number
    load15: number
  }
  disk: {
    total: number
    used: number
  }
  network: {
    up: number
    down: number
    totalUp: number
    totalDown: number
  }
  connections: {
    tcp: number
    udp: number
  }
  uptime: number
  process: number
  message: string
  updated_at: string
}

/** WebSocket 实时状态响应 */
export interface WebSocketRealtimeResponse {
  status: 'success' | 'error'
  data: {
    online: string[]
    data: Record<string, RealtimeStatus>
  }
}

/** 负载历史记录（扁平结构） */
export interface LoadRecord {
  client: string
  time: string
  cpu: number
  gpu: number
  ram: number
  ram_total: number
  swap: number
  swap_total: number
  load: number
  temp: number
  disk: number
  disk_total: number
  net_in: number
  net_out: number
  net_total_up: number
  net_total_down: number
  traffic_up?: number
  traffic_down?: number
  process: number
  connections: number
  connections_udp: number
}

/** 负载历史记录响应 */
export interface LoadRecordsResponse {
  count: number
  records: LoadRecord[]
}

/** Ping 历史记录 */
export interface PingRecord {
  task_id: number
  time: string
  value: number
}

/** Ping 任务信息 */
export interface PingTask {
  id: number
  interval: number
  name: string
  loss: number
}

/** Ping 历史记录响应 */
export interface PingRecordsResponse {
  count: number
  records: PingRecord[]
  tasks: PingTask[]
}

/** API 客户端配置 */
export interface ApiClientOptions {
  /** 基础路径，默认 '/api' */
  baseUrl?: string
  /** 超时时间（毫秒），默认 30000 */
  timeout?: number
}

/** API 错误 */
export class ApiError extends Error {
  status: string
  code?: number

  constructor(message: string, status: string = 'error', code?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

// ==================== API 客户端 ====================

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError)
    return error
  if (error instanceof RpcError)
    return new ApiError(error.message, 'error', error.code)
  return new ApiError(error instanceof Error ? error.message : String(error), 'error')
}

/**
 * Komari REST surface — CF-Server-Monitor edition.
 * Same public methods and return shapes as the original KomariApi; data comes from the CFSM adapter.
 */
export class KomariApi {
  constructor(_options: ApiClientOptions = {}) {}

  private async run<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task()
    }
    catch (error) {
      throw toApiError(error)
    }
  }

  /** 获取当前用户信息（CFSM：/api/config 的 authorization 字段） */
  async getMe(): Promise<MeInfo> {
    return this.run(() => cfsmBackend.me())
  }

  /** 获取站点公开设置（含已解析的主题设置） */
  async getPublicSettings(signal?: AbortSignal): Promise<PublicSettings> {
    return this.run(() => cfsmBackend.publicSettings(signal) as Promise<PublicSettings>)
  }

  /** 保存主题设置（CFSM：POST /api/theme_options，需要管理员 JWT） */
  async saveThemeSettings(_theme: string, settings: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    return this.run(() => cfsmBackend.saveThemeOptions(settings, signal))
  }

  /** 获取服务端版本信息 */
  async getVersion(): Promise<VersionInfo> {
    return this.run(() => cfsmBackend.call<VersionInfo>('rpc.getVersion'))
  }

  /** 获取所有节点的基本信息列表 */
  async getNodes(): Promise<NodeInfo[]> {
    return this.run(() => cfsmBackend.call<NodeInfo[]>('public:getNodesInformation'))
  }

  /** 获取指定节点最近的实时数据 */
  async getNodeRecentStatus(uuid: string): Promise<RealtimeStatus[]> {
    return this.run(async () => {
      const records = await cfsmBackend.call<LoadRecord[]>('public:getClientRecentRecords', { uuid })
      return records.map(record => ({
        cpu: { usage: record.cpu },
        ram: { total: record.ram_total, used: record.ram },
        swap: { total: record.swap_total, used: record.swap },
        load: { load1: record.load, load5: record.load, load15: record.load },
        disk: { total: record.disk_total, used: record.disk },
        network: { up: record.net_out, down: record.net_in, totalUp: record.net_total_up, totalDown: record.net_total_down },
        connections: { tcp: record.connections, udp: record.connections_udp },
        uptime: 0,
        process: record.process,
        message: '',
        updated_at: record.time,
      }))
    })
  }

  /** 获取指定节点的负载历史记录 */
  async getLoadRecords(uuid: string, hours: number, maxCount?: number, signal?: AbortSignal): Promise<LoadRecordsResponse> {
    return this.run(async () => {
      const result = await cfsmBackend.call<{ records: LoadRecord[] }>('common:getRecords', { type: 'load', uuid, hours, max_count: maxCount }, signal)
      return { count: result.records.length, records: result.records }
    })
  }

  /** 获取指定节点的 Ping 历史记录 */
  async getPingRecords(uuid: string, hours: number, signal?: AbortSignal): Promise<PingRecordsResponse> {
    return this.run(async () => {
      const result = await cfsmBackend.call<{ records: Array<PingRecord & { client: string }>, tasks: PingTask[] }>('common:getRecords', { type: 'ping', uuid, hours }, signal)
      return { count: result.records.length, records: result.records, tasks: result.tasks }
    })
  }
}

// ==================== WebSocket 实时状态客户端 ====================

/** WebSocket 实时状态客户端 */
export class RealtimeWebSocket {
  private ws: WebSocket | null = null
  private url: string
  private reconnectInterval: number
  private maxReconnectAttempts: number
  private reconnectAttempts = 0
  private listeners: Set<(data: WebSocketRealtimeResponse) => void> = new Set()
  private errorListeners: Set<(error: Event) => void> = new Set()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private shouldReconnect = true
  private isOpen = false

  constructor(options: {
    baseUrl?: string
    reconnectInterval?: number
    maxReconnectAttempts?: number
  } = {}) {
    const baseUrl = options.baseUrl || '/api/clients'
    this.url = baseUrl.replace(HTTP_PROTOCOL_REGEX, 'ws').replace(HTTPS_PROTOCOL_REGEX, 'wss')
    this.reconnectInterval = options.reconnectInterval || 3000
    this.maxReconnectAttempts = options.maxReconnectAttempts || 5
  }

  /**
   * 连接 WebSocket
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url)

        this.ws.onopen = () => {
          this.isOpen = true
          this.reconnectAttempts = 0
          // 发送获取数据请求
          this.ws!.send('get')
          resolve()
        }

        this.ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data) as WebSocketRealtimeResponse
            if (data?.status === 'success' || data?.status === 'error')
              this.listeners.forEach(listener => listener(data))
          }
          catch {
            // Ignore parse errors
          }
        }

        this.ws.onerror = (error) => {
          this.errorListeners.forEach(listener => listener(error))
          if (!this.isOpen) {
            reject(new ApiError('WebSocket connection failed', 'error'))
          }
        }

        this.ws.onclose = () => {
          this.isOpen = false
          if (this.shouldReconnect)
            this.attemptReconnect()
        }
      }
      catch (error) {
        reject(new ApiError(`WebSocket error: ${error instanceof Error ? error.message : String(error)}`, 'error'))
      }
    })
  }

  /**
   * 尝试重连
   */
  private attemptReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer || this.reconnectAttempts >= this.maxReconnectAttempts)
      return

    this.reconnectAttempts++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch(() => {
        // Ignore reconnect errors
      })
    }, this.reconnectInterval)
  }

  /**
   * 请求数据
   */
  requestData(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send('get')
    }
  }

  /**
   * 订阅实时数据
   */
  subscribe(callback: (data: WebSocketRealtimeResponse) => void): () => void {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }

  /**
   * 订阅错误事件
   */
  onError(callback: (error: Event) => void): () => void {
    this.errorListeners.add(callback)
    return () => {
      this.errorListeners.delete(callback)
    }
  }

  /**
   * 关闭连接
   */
  close(): void {
    this.shouldReconnect = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.isOpen = false
    this.listeners.clear()
    this.errorListeners.clear()
  }

  /**
   * 获取连接状态
   */
  get connected(): boolean {
    return this.isOpen && this.ws?.readyState === WebSocket.OPEN
  }
}

// ==================== 单例实例 ====================

let sharedApiInstance: KomariApi | null = null

/**
 * 获取共享的 KomariApi 实例
 */
export function getSharedApi(options?: ApiClientOptions): KomariApi {
  if (!sharedApiInstance) {
    sharedApiInstance = new KomariApi(options)
  }
  return sharedApiInstance
}

/**
 * 重置共享实例
 */
export function resetSharedApi(): void {
  sharedApiInstance = null
}

// 默认导出
export default KomariApi
