export type Rango = 'hoy' | '7d' | '30d'

/** Un número del período actual y el mismo del período anterior. */
export type Par = { actual: number; anterior: number }

export type Ventas = { cobrado: Par; pedidos: Par; pendiente: Par }

export type Trafico = {
  sesiones: Par
  usuarios: Par
  canales: { canal: string; sesiones: number }[]
}

export type Meta = {
  gasto: Par
  compras: Par
  ingresosMeta: Par
  clicks: Par
  impresiones: Par
}

/** Cada fuente carga por su cuenta: si una falla, las otras se muestran igual. */
export type Fuente<T> = { status: 'loading' | 'ok' | 'error'; data?: T; error?: string }

export type Tablero = {
  ventas: Fuente<Ventas>
  trafico: Fuente<Trafico>
  meta: Fuente<Meta>
  desde: string
  hasta: string
  actualizado?: string
}

declare module 'claude-code' {
  interface PluginState {
    tablero: { rango: Rango; datos: Partial<Record<Rango, Tablero>> }
  }
}
