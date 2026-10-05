export type Pedido = {
  id: number
  number: number
  hora: string
  cliente: string
  total: number
  moneda: string
  pago: string
  estado: string
}

export type Snapshot = {
  status: 'idle' | 'loading' | 'ok' | 'error'
  error?: string
  fecha: string
  pedidos: Pedido[]
  actualizado?: string
}

declare module 'claude-code' {
  interface PluginState {
    pedidos: { snapshot: Snapshot }
  }
}
