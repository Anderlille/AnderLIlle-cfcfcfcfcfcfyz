/** Shared RPC error type (kept here so the CFSM backend and utils/rpc.ts can both use it without an import cycle). */
export class RpcError extends Error {
  code: number
  data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.data = data
  }
}

export const METHOD_NOT_FOUND = -32601
