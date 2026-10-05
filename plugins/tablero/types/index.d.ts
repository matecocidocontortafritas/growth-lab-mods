/** Un número de hoy y el mismo de ayer. */
export type Par = { actual: number; anterior: number }

export type Ventas = { cobrado: Par; pedidos: Par; pendiente: Par }

export type Trafico = {
  sesiones: Par
  usuarios: Par
  nuevos: Par
  sesionesPorUsuario: Par
  /** Tiempo medio de la sesión, en segundos. */
  duracionMedia: Par
  vistasProducto: Par
  canales: { canal: string; sesiones: number }[]
}

export type Meta = {
  inversion: Par
  impresiones: Par
  clicks: Par
  vistasProducto: Par
  compras: Par
  ingresosMeta: Par
}

/** Cada fuente carga por su cuenta: si una falla, las otras se muestran igual. */
export type Fuente<T> = { status: 'loading' | 'ok' | 'error'; data?: T; error?: string }

export type Tablero = {
  ventas: Fuente<Ventas>
  trafico: Fuente<Trafico>
  meta: Fuente<Meta>
  fecha: string
  actualizado?: string
}

declare module 'claude-code' {
  interface PluginState {
    tablero: { hoy: Tablero | null }
  }
}
