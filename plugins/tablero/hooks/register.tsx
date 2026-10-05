import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallArgs, ToolCallResult } from 'claude-code'

import type { Fuente, Meta, Par, Tablero, Trafico, Ventas } from '../types'

const PANE = 'tablero'
// Cada pedido trae productos, cliente y envío: páginas chicas para no pasar el
// tamaño de respuesta que Claude Code acepta de un conector.
const PAGE_SIZE = 30
const MAX_PAGES = 40
const REFRESH_MS = 10 * 60 * 1000
const AR_OFFSET_MS = -3 * 60 * 60 * 1000
const DIA_MS = 24 * 60 * 60 * 1000

const datos = atom({ plugin: 'tablero', key: 'hoy' } as const, null as Tablero | null)

let timer: { cancel: () => void } | undefined

type Fuente3 = 'tiendanube' | 'ga' | 'meta'

/** Lo que la persona cargó en /config (register lo llena en cada carga). */
const config = {
  gaProperty: '',
  metaAccount: '',
  metaNombre: '',
  tools: { tiendanube: '', ga: '', meta: '' } as Record<Fuente3, string>,
}
/** Herramientas encontradas en la sesión, por fuente. */
const encontradas: Partial<Record<Fuente3, string>> = {}

/** Error con los pasos para resolverlo, que el panel muestra tal cual. */
export class Pasos extends Error {}

const BUSCAR: Record<Fuente3, { sufijos: string[]; pista: RegExp; nombre: string; conectar: string }> = {
  tiendanube: {
    sufijos: ['__list_orders'],
    pista: /tiendanube|nuvemshop|tienda nube/i,
    nombre: 'Tiendanube',
    conectar:
      'Conectá Tiendanube en claude.ai → Configuración → Conectores (o agregá https://admin-mcp.tiendanube.com como conector) y abrí una sesión nueva.',
  },
  ga: {
    sufijos: ['__run_report'],
    pista: /analytics/i,
    nombre: 'Google Analytics',
    conectar:
      'Instalá el MCP oficial de Google Analytics (github.com/googleanalytics/google-analytics-mcp, ver README) y abrí una sesión nueva.',
  },
  meta: {
    // Primero el MCP oficial de Meta (mcp.facebook.com/ads); si no está, uno con get_account_summary.
    sufijos: ['__ads_get_ad_entities', '__get_account_summary'],
    pista: /meta|facebook|ads/i,
    nombre: 'Meta Ads',
    conectar:
      'Conectá el MCP oficial de Meta en claude.ai → Configuración → Conectores → Agregar conector personalizado → https://mcp.facebook.com/ads, y abrí una sesión nueva.',
  },
}

type RawOrder = {
  status: string
  payment_status: string
  completed_at: string
  total?: { amount?: string }
}

/** Fecha de Argentina (UTC-3), YYYY-MM-DD, de un instante. */
export function arFecha(ms: number) {
  return new Date(ms + AR_OFFSET_MS).toISOString().slice(0, 10)
}

export function plata(n: number) {
  const abs = Math.round(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return (n < 0 ? '-$' : '$') + abs
}

export function numero(n: number) {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

export function decimal(n: number, digitos = 1) {
  return n.toFixed(digitos).replace('.', ',')
}

/** Segundos como "4m 12s". */
export function duracion(segundos: number) {
  const s = Math.round(segundos)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/** Variación de hoy contra ayer, como "▲12%" o "▼5%". */
export function delta(p: Par) {
  if (p.anterior === 0) return p.actual === 0 ? '' : 'nuevo'
  const v = ((p.actual - p.anterior) / p.anterior) * 100
  if (Math.abs(v) < 0.5) return '='
  return `${v > 0 ? '▲' : '▼'}${Math.round(Math.abs(v))}%`
}

/** JSON de un conector; si no lo es, el error muestra lo que respondió. */
export function leerJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(text.slice(0, 200) || 'el conector respondió vacío')
  }
}

async function herramienta($: EngineInterface, fuente: Fuente3) {
  if (config.tools[fuente]) return config.tools[fuente]
  const ya = encontradas[fuente]
  if (ya) return ya
  const b = BUSCAR[fuente]
  const tools = (await $.tool.list()).filter(t => t.mcp)
  let t: { name: string } | undefined
  for (const sufijo of b.sufijos) {
    const candidatas = tools.filter(c => c.name.endsWith(sufijo))
    t = candidatas.find(c => b.pista.test(c.name + ' ' + c.description)) ?? candidatas[0]
    if (t) break
  }
  if (!t) throw new Pasos(`No encontré el conector de ${b.nombre}. ${b.conectar}`)
  encontradas[fuente] = t.name
  return t.name
}

async function llamar($: EngineInterface, fuente: Fuente3, args: Record<string, unknown>, consent?: string) {
  const tool = await herramienta($, fuente)
  const input = { tool, ...(consent ? { consent } : {}), ...args } as unknown as ToolCallArgs
  const res: ToolCallResult = await $.tool.call(input)
  if (res.deny !== undefined) {
    throw new Pasos(
      `Claude Code no dejó consultar ${BUSCAR[fuente].nombre}. Si usás modo automático, agregá este permiso ` +
        `en ~/.claude/settings.json → permissions.allow: "${tool}" (README → Permisos).`,
    )
  }
  const text = res.text ?? ''
  if (res.isError) throw new Error(text.slice(0, 200) || 'error del conector')
  return text
}

// ── Ventas · Tiendanube ─────────────────────────────────────────────────────

export function resumirVentas(orders: RawOrder[], fecha: string) {
  let cobrado = 0
  let pedidos = 0
  let pendiente = 0
  for (const o of orders) {
    if (arFecha(Date.parse(o.completed_at)) !== fecha || o.status === 'cancelled') continue
    pedidos += 1
    const total = Number(o.total?.amount ?? 0)
    if (o.payment_status === 'paid') cobrado += total
    else if (o.payment_status === 'pending' || o.payment_status === 'authorized') pendiente += total
  }
  return { cobrado, pedidos, pendiente }
}

async function pedidosDe($: EngineInterface, fecha: string, consent?: string) {
  const raw: RawOrder[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const text = await llamar($, 'tiendanube', {
      completed_at_from: `${fecha}T00:00:00-03:00`,
      completed_at_to: `${fecha}T23:59:59-03:00`,
      status: ['open', 'closed', 'cancelled'],
      limit: PAGE_SIZE,
      page,
    }, consent)
    const res = leerJson<{ orders?: RawOrder[]; total?: number }>(text)
    const orders = res.orders ?? []
    raw.push(...orders)
    if (orders.length < PAGE_SIZE || raw.length >= (res.total ?? 0)) break
  }
  return resumirVentas(raw, fecha)
}

async function cargarVentas($: EngineInterface, hoy: string, ayer: string, consent?: string): Promise<Ventas> {
  const [a, b] = await Promise.all([pedidosDe($, hoy, consent), pedidosDe($, ayer, consent)])
  return {
    cobrado: { actual: a.cobrado, anterior: b.cobrado },
    pedidos: { actual: a.pedidos, anterior: b.pedidos },
    pendiente: { actual: a.pendiente, anterior: b.pendiente },
  }
}

// ── Tráfico · Google Analytics ──────────────────────────────────────────────

type GaReport = {
  rows?: { dimension_values: { value: string }[]; metric_values: { value: string }[] }[]
  error?: string
}

const GA_METRICAS = ['sessions', 'totalUsers', 'newUsers', 'sessionsPerUser', 'averageSessionDuration', 'itemViewEvents']

/**
 * Totales de hoy (actual) y ayer (anterior). Las métricas que son promedio se
 * ponderan por sesiones, así que da el valor exacto aunque GA devuelva varias filas.
 */
export function resumirTotales(r: GaReport): Omit<Trafico, 'canales'> {
  const acc = {
    actual: { s: 0, u: 0, n: 0, spu: 0, dur: 0, v: 0 },
    anterior: { s: 0, u: 0, n: 0, spu: 0, dur: 0, v: 0 },
  }
  for (const row of r.rows ?? []) {
    const cual = row.dimension_values.at(-1)?.value === 'actual' ? 'actual' : 'anterior'
    const [s = 0, u = 0, n = 0, spu = 0, dur = 0, v = 0] = row.metric_values.map(m => Number(m.value ?? 0))
    const a = acc[cual]
    a.s += s
    a.u += u
    a.n += n
    a.spu += spu * s
    a.dur += dur * s
    a.v += v
  }
  const par = (f: (x: typeof acc.actual) => number): Par => ({ actual: f(acc.actual), anterior: f(acc.anterior) })
  return {
    sesiones: par(x => x.s),
    usuarios: par(x => x.u),
    nuevos: par(x => x.n),
    sesionesPorUsuario: par(x => (x.s > 0 ? x.spu / x.s : 0)),
    duracionMedia: par(x => (x.s > 0 ? x.dur / x.s : 0)),
    vistasProducto: par(x => x.v),
  }
}

export function resumirCanales(r: GaReport): Trafico['canales'] {
  const canales: Record<string, number> = {}
  for (const row of r.rows ?? []) {
    if (row.dimension_values[1]?.value !== 'actual') continue
    const canal = row.dimension_values[0]?.value ?? '—'
    canales[canal] = (canales[canal] ?? 0) + Number(row.metric_values[0]?.value ?? 0)
  }
  return Object.entries(canales)
    .map(([canal, sesiones]) => ({ canal, sesiones }))
    .filter(c => c.sesiones > 0)
    .sort((a, b) => b.sesiones - a.sesiones)
    .slice(0, 4)
}

async function cargarTrafico($: EngineInterface, hoy: string, ayer: string, consent?: string): Promise<Trafico> {
  if (!config.gaProperty) {
    throw new Pasos(
      'Falta tu propiedad de Analytics: escribí /config, buscá "tablero" → "Propiedad de Google Analytics" y pegá el número. ' +
        '¿No lo sabés? Preguntale a Claude: "listame mis propiedades de Google Analytics con su ID".',
    )
  }
  const base = {
    property_id: config.gaProperty.replace(/^properties\//, ''),
    date_ranges: [
      { start_date: hoy, end_date: hoy, name: 'actual' },
      { start_date: ayer, end_date: ayer, name: 'anterior' },
    ],
  }
  const [tTotales, tCanales] = await Promise.all([
    llamar($, 'ga', { ...base, dimensions: ['date'], metrics: GA_METRICAS }, consent),
    llamar($, 'ga', { ...base, dimensions: ['sessionDefaultChannelGroup'], metrics: ['sessions'], limit: 50 }, consent),
  ])
  const totales = leerJson<GaReport>(tTotales)
  const canales = leerJson<GaReport>(tCanales)
  const error = totales.error ?? canales.error
  if (error) throw new Error(error.slice(0, 200))
  return { ...resumirTotales(totales), canales: resumirCanales(canales) }
}

// ── Meta Ads ────────────────────────────────────────────────────────────────

type MetaSummary = Record<string, string | undefined>

/** Lee la respuesta de un MCP con get_account_summary (hoy y ayer en una llamada). */
export function resumirMeta(text: string): Meta {
  let body = leerJson<{ result?: string; summary?: MetaSummary; prev_summary?: MetaSummary; error?: string }>(text)
  if (typeof body.result === 'string') body = leerJson(body.result)
  if (body.error) throw new Error(String(body.error).slice(0, 200))
  const a = body.summary ?? {}
  const b = body.prev_summary ?? {}
  const par = (k: string): Par => ({ actual: Number(a[k] ?? 0), anterior: Number(b[k] ?? 0) })
  return {
    inversion: par('spend'),
    impresiones: par('impressions'),
    clicks: par('clicks'),
    vistasProducto: par('view_content'),
    compras: par('purchases'),
    ingresosMeta: par('revenue'),
  }
}

type MetaEntidad = {
  amount_spent?: { value?: string } | string
  impressions?: string
  clicks?: string
  omni_view_content?: string
  omni_purchase?: string
  purchase_roas?: string
}

/** Lee la respuesta de ads_get_ad_entities del MCP oficial de Meta, a nivel cuenta. */
export function leerEntidadMeta(text: string) {
  const body = leerJson<{ ad_entities?: string | MetaEntidad[]; error?: unknown }>(text)
  if (body.error) throw new Error(JSON.stringify(body.error).slice(0, 200))
  const lista = typeof body.ad_entities === 'string' ? leerJson<MetaEntidad[]>(body.ad_entities) : body.ad_entities ?? []
  const e = lista[0] ?? {}
  const inversion = Number(typeof e.amount_spent === 'object' ? e.amount_spent.value ?? 0 : e.amount_spent ?? 0)
  return {
    inversion,
    impresiones: Number(e.impressions ?? 0),
    clicks: Number(e.clicks ?? 0),
    vistasProducto: Number(e.omni_view_content ?? 0),
    compras: Number(e.omni_purchase ?? 0),
    ingresos: Number(e.purchase_roas ?? 0) * inversion,
  }
}

/** Agrupa las llamadas de Meta de esta sesión, como pide el MCP oficial. */
const conversacionMeta = Array.from({ length: 20 }, () =>
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)],
).join('')

async function cargarMeta($: EngineInterface, hoy: string, ayer: string, consent?: string): Promise<Meta> {
  if (!config.metaAccount) {
    throw new Pasos(
      'Falta tu cuenta de Meta: escribí /config, buscá "tablero" → "Cuenta publicitaria de Meta" y pegá el ID (act_...). ' +
        '¿No lo sabés? Preguntale a Claude: "listame mis cuentas publicitarias de Meta con su ID".',
    )
  }
  const cuenta = config.metaAccount.replace(/^act_/, '')
  const tool = await herramienta($, 'meta')

  if (tool.endsWith('__ads_get_ad_entities')) {
    const pedir = (fecha: string) =>
      llamar($, 'meta', {
        ad_account_id: cuenta,
        level: 'ad_account',
        fields: ['amount_spent', 'impressions', 'clicks', 'omni_view_content', 'omni_purchase', 'purchase_roas'],
        time_range: JSON.stringify({ since: fecha, until: fecha }),
        include_additional_context: false,
        client_conversation_id: conversacionMeta,
      }, consent)
    const [ta, tb] = await Promise.all([pedir(hoy), pedir(ayer)])
    const a = leerEntidadMeta(ta)
    const b = leerEntidadMeta(tb)
    return {
      inversion: { actual: a.inversion, anterior: b.inversion },
      impresiones: { actual: a.impresiones, anterior: b.impresiones },
      clicks: { actual: a.clicks, anterior: b.clicks },
      vistasProducto: { actual: a.vistasProducto, anterior: b.vistasProducto },
      compras: { actual: a.compras, anterior: b.compras },
      ingresosMeta: { actual: a.ingresos, anterior: b.ingresos },
    }
  }

  const text = await llamar($, 'meta', {
    account_id: `act_${cuenta}`,
    date_from: hoy,
    date_to: hoy,
    prev_date_from: ayer,
    prev_date_to: ayer,
  }, consent)
  return resumirMeta(text)
}

// ── Carga y panel ───────────────────────────────────────────────────────────

function mensaje(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Recarga hoy y ayer. `consent` describe lo que hizo la persona (comando o botón);
 * el refresco por timer no lleva y depende de las reglas de permiso.
 */
async function refresh($: EngineInterface, consent?: string) {
  const ahora = await $.clock.now()
  const hoy = arFecha(ahora)
  const ayer = arFecha(ahora - DIA_MS)
  const previo = await read($, datos)
  const cargando = <T,>(f?: Fuente<T>): Fuente<T> => ({ ...f, status: 'loading' })
  await update($, datos, () => ({
    ventas: cargando(previo?.ventas),
    trafico: cargando(previo?.trafico),
    meta: cargando(previo?.meta),
    fecha: hoy,
    actualizado: previo?.actualizado,
  }))

  const cargar = async <K extends 'ventas' | 'trafico' | 'meta'>(
    k: K,
    fn: () => Promise<NonNullable<Tablero[K]['data']>>,
  ) => {
    let f: Tablero[K]
    try {
      f = { status: 'ok', data: await fn() } as Tablero[K]
    } catch (err) {
      f = { status: 'error', data: previo?.[k]?.data, error: mensaje(err) } as Tablero[K]
    }
    await update($, datos, d => ({ ...d!, [k]: f }))
  }

  await Promise.all([
    cargar('ventas', () => cargarVentas($, hoy, ayer, consent)),
    cargar('trafico', () => cargarTrafico($, hoy, ayer, consent)),
    cargar('meta', () => cargarMeta($, hoy, ayer, consent)),
  ])
  const hora = new Date((await $.clock.now()) + AR_OFFSET_MS).toISOString().slice(11, 16)
  await update($, datos, d => ({ ...d!, actualizado: hora }))
}

export const register: Register = (on, options) => {
  const opt = (k: string) => String(options[k] ?? '').trim()
  config.gaProperty = opt('ga_property')
  config.metaAccount = opt('meta_account')
  config.metaNombre = opt('meta_nombre')
  config.tools = { tiendanube: opt('tiendanube_tool'), ga: opt('ga_tool'), meta: opt('meta_tool') }
  for (const k of Object.keys(encontradas) as Fuente3[]) delete encontradas[k]

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tablero',
      description: 'Tablero de hoy: ventas Tiendanube + Analytics + Meta Ads',
    })
    return next(e)
  })

  on('command.run', { command: 'tablero' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Tablero' })
    void refresh($, 'The user ran /tablero to see today\'s sales, traffic and Meta Ads.')
    timer?.cancel()
    timer = $.clock.every(REFRESH_MS, () => refresh($))
    return {}
  })

  on('ui.close', async ($, e, next) => {
    if ((e as { requestId?: string }).requestId === PANE) {
      timer?.cancel()
      timer = undefined
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const t = await read($, datos)

    const estado = (f: Fuente<unknown> | undefined) =>
      !f || (f.status === 'loading' && !f.data)
        ? <Text dimColor>Cargando…</Text>
        : f.status === 'error'
          ? <Text color="red" wrap="wrap">{f.error}</Text>
          : null

    const fila = (label: string, valor: string, p?: Par) => (
      <Text>
        {label.padEnd(16)} <Text bold>{valor}</Text>
        {p ? <Text dimColor> {delta(p)}</Text> : ''}
      </Text>
    )

    const v = t?.ventas.data
    const tr = t?.trafico.data
    const m = t?.meta.data
    const ticket = v && v.pedidos.actual > 0 ? v.cobrado.actual / v.pedidos.actual : 0
    const conversion = v && tr && tr.sesiones.actual > 0 ? (v.pedidos.actual / tr.sesiones.actual) * 100 : undefined
    const ctr = (clicks: number, impresiones: number) => (impresiones > 0 ? (clicks / impresiones) * 100 : 0)
    const ctrPar = m && { actual: ctr(m.clicks.actual, m.impresiones.actual), anterior: ctr(m.clicks.anterior, m.impresiones.anterior) }
    const mer = v && m && m.inversion.actual > 0 ? v.cobrado.actual / m.inversion.actual : undefined
    const roasMeta = m && m.inversion.actual > 0 ? m.ingresosMeta.actual / m.inversion.actual : undefined
    const cuenta = config.metaNombre || config.metaAccount

    return (
      <Box flexDirection="column">
        <Text dimColor>
          Hoy{t ? ` ${t.fecha}` : ''} · vs ayer completo{t?.actualizado ? ` · actualizado ${t.actualizado}` : ''}
        </Text>

        <Box flexDirection="column" marginTop={1}>
          <Text bold color="green">VENTAS · Tiendanube</Text>
          {estado(t?.ventas)}
          {v && fila('Cobrado', plata(v.cobrado.actual), v.cobrado)}
          {v && fila('Pedidos', numero(v.pedidos.actual), v.pedidos)}
          {v && fila('Ticket', plata(ticket))}
          {v && v.pendiente.actual > 0 && fila('Pendiente', plata(v.pendiente.actual))}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold color="cyan">TRÁFICO · Analytics</Text>
          {estado(t?.trafico)}
          {tr && fila('Sesiones', numero(tr.sesiones.actual), tr.sesiones)}
          {tr && fila('Usuarios', numero(tr.usuarios.actual), tr.usuarios)}
          {tr && fila('Usuarios nuevos', numero(tr.nuevos.actual), tr.nuevos)}
          {tr && fila('Sesiones/usuario', decimal(tr.sesionesPorUsuario.actual, 2), tr.sesionesPorUsuario)}
          {tr && fila('Tiempo medio', duracion(tr.duracionMedia.actual), tr.duracionMedia)}
          {tr && fila('Vistas producto', numero(tr.vistasProducto.actual), tr.vistasProducto)}
          {conversion !== undefined && fila('Conversión', `${decimal(conversion, 2)}%`)}
          {tr && tr.canales.length > 0 && (
            <Text dimColor wrap="wrap">
              {tr.canales.map(c => `${c.canal} ${numero(c.sesiones)}`).join(' · ')}
            </Text>
          )}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold color="magenta">META ADS{cuenta ? ` · ${cuenta}` : ''}</Text>
          {estado(t?.meta)}
          {m && fila('Inversión', plata(m.inversion.actual), m.inversion)}
          {m && fila('Impresiones', numero(m.impresiones.actual), m.impresiones)}
          {ctrPar && fila('CTR', `${decimal(ctrPar.actual, 2)}%`, ctrPar)}
          {m && fila('Vistas producto', numero(m.vistasProducto.actual), m.vistasProducto)}
          {m && fila('Compras', numero(m.compras.actual), m.compras)}
          {roasMeta !== undefined && fila('ROAS Meta', `${decimal(roasMeta)}x`)}
          {mer !== undefined && fila('MER', `${decimal(mer)}x`)}
          {mer !== undefined && <Text dimColor>MER = cobrado en Tiendanube ÷ inversión en Meta</Text>}
        </Box>

        <Box marginTop={1}>
          <Button
            key="refresh"
            label="Actualizar"
            hotkey="r"
            onPress={() => refresh($, 'The user pressed "Actualizar" on the Tablero pane to reload today\'s sales, traffic and Meta Ads.')}
          />
        </Box>
      </Box>
    )
  })
}
