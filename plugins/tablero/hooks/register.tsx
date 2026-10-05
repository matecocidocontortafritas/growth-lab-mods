import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallArgs, ToolCallResult } from 'claude-code'

import type { Fuente, Meta, Par, Rango, Tablero, Trafico, Ventas } from '../types'

const PANE = 'tablero'
// Cada pedido trae productos, cliente y envío: con más de ~30 por página la respuesta
// supera el tamaño que Claude Code acepta de un conector y llega un error en vez de datos.
const PAGE_SIZE = 30
const MAX_PAGES = 100
const EN_PARALELO = 4
const REFRESH_MS = 10 * 60 * 1000
const AR_OFFSET_MS = -3 * 60 * 60 * 1000
const DIA_MS = 24 * 60 * 60 * 1000

const RANGOS: { id: Rango; label: string; hotkey: string; dias: number }[] = [
  { id: 'hoy', label: 'Hoy', hotkey: 'h', dias: 1 },
  { id: '7d', label: '7 días', hotkey: '7', dias: 7 },
  { id: '30d', label: '30 días', hotkey: '3', dias: 30 },
]

const rango = atom({ plugin: 'tablero', key: 'rango' } as const, 'hoy' as Rango)
const datos = atom({ plugin: 'tablero', key: 'datos' } as const, {} as Partial<Record<Rango, Tablero>>)

let timer: { cancel: () => void } | undefined

/** Lo que la persona cargó en /config (register lo llena en cada carga). */
const config = {
  gaProperty: '',
  metaAccount: '',
  metaNombre: '',
  tools: { tiendanube: '', ga: '', meta: '' } as Record<Fuente3, string>,
}
/** Herramientas encontradas en la sesión, por fuente. */
const encontradas: Partial<Record<Fuente3, string>> = {}

type Fuente3 = 'tiendanube' | 'ga' | 'meta'

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
      'Instalá el MCP oficial de Google Analytics (github.com/googleanalytics/google-analytics-mcp, ver README → Conectores) y abrí una sesión nueva.',
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

type RawOrder = {
  status: string
  payment_status: string
  completed_at: string
  total?: { amount?: string }
}

type Periodo = { desde: string; hasta: string; prevDesde: string; prevHasta: string }

/** Fecha de Argentina (UTC-3), YYYY-MM-DD, de un instante. */
export function arFecha(ms: number) {
  return new Date(ms + AR_OFFSET_MS).toISOString().slice(0, 10)
}

export function periodo(ahora: number, dias: number): Periodo {
  const hasta = arFecha(ahora)
  const desdeMs = Date.parse(`${hasta}T12:00:00Z`) - (dias - 1) * DIA_MS
  const desde = new Date(desdeMs).toISOString().slice(0, 10)
  const prevHasta = new Date(desdeMs - DIA_MS).toISOString().slice(0, 10)
  const prevDesde = new Date(desdeMs - dias * DIA_MS).toISOString().slice(0, 10)
  return { desde, hasta, prevDesde, prevHasta }
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

/** Variación del período actual contra el anterior, como "▲12%" o "▼5%". */
export function delta(p: Par) {
  if (p.anterior === 0) return p.actual === 0 ? '' : 'nuevo'
  const v = ((p.actual - p.anterior) / p.anterior) * 100
  if (Math.abs(v) < 0.5) return '='
  return `${v > 0 ? '▲' : '▼'}${Math.round(Math.abs(v))}%`
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

export function resumirVentas(orders: RawOrder[], desde: string, hasta: string) {
  let cobrado = 0
  let pedidos = 0
  let pendiente = 0
  for (const o of orders) {
    const dia = arFecha(Date.parse(o.completed_at))
    if (dia < desde || dia > hasta || o.status === 'cancelled') continue
    pedidos += 1
    const total = Number(o.total?.amount ?? 0)
    if (o.payment_status === 'paid') cobrado += total
    else if (o.payment_status === 'pending' || o.payment_status === 'authorized') pendiente += total
  }
  return { cobrado, pedidos, pendiente }
}

/** JSON de un conector; si no lo es, el error muestra lo que respondió. */
export function leerJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(text.slice(0, 200) || 'el conector respondió vacío')
  }
}

async function pedidosEntre($: EngineInterface, desde: string, hasta: string, consent?: string) {
  const pagina = async (page: number) => {
    const text = await llamar($, 'tiendanube', {
      completed_at_from: `${desde}T00:00:00-03:00`,
      completed_at_to: `${hasta}T23:59:59-03:00`,
      status: ['open', 'closed', 'cancelled'],
      limit: PAGE_SIZE,
      page,
    }, consent)
    return leerJson<{ orders?: RawOrder[]; total?: number }>(text)
  }
  const primera = await pagina(1)
  const raw: RawOrder[] = [...(primera.orders ?? [])]
  const paginas = Math.min(MAX_PAGES, Math.ceil((primera.total ?? 0) / PAGE_SIZE))
  const resto = Array.from({ length: Math.max(0, paginas - 1) }, (_, i) => i + 2)
  for (let i = 0; i < resto.length; i += EN_PARALELO) {
    const tanda = await Promise.all(resto.slice(i, i + EN_PARALELO).map(pagina))
    for (const res of tanda) raw.push(...(res.orders ?? []))
  }
  return resumirVentas(raw, desde, hasta)
}

async function cargarVentas($: EngineInterface, p: Periodo, consent?: string): Promise<Ventas> {
  const [a, b] = await Promise.all([
    pedidosEntre($, p.desde, p.hasta, consent),
    pedidosEntre($, p.prevDesde, p.prevHasta, consent),
  ])
  return {
    cobrado: { actual: a.cobrado, anterior: b.cobrado },
    pedidos: { actual: a.pedidos, anterior: b.pedidos },
    pendiente: { actual: a.pendiente, anterior: b.pendiente },
  }
}

type GaReport = {
  rows?: { dimension_values: { value: string }[]; metric_values: { value: string }[] }[]
}

export function resumirTrafico(r: GaReport): Trafico {
  const sesiones = { actual: 0, anterior: 0 }
  const usuarios = { actual: 0, anterior: 0 }
  const canales: Record<string, number> = {}
  for (const row of r.rows ?? []) {
    const canal = row.dimension_values[0]?.value ?? '—'
    const cual = row.dimension_values[1]?.value === 'actual' ? 'actual' : 'anterior'
    const s = Number(row.metric_values[0]?.value ?? 0)
    const u = Number(row.metric_values[1]?.value ?? 0)
    sesiones[cual] += s
    usuarios[cual] += u
    if (cual === 'actual') canales[canal] = (canales[canal] ?? 0) + s
  }
  return {
    sesiones,
    usuarios,
    canales: Object.entries(canales)
      .map(([canal, s]) => ({ canal, sesiones: s }))
      .filter(c => c.sesiones > 0)
      .sort((a, b) => b.sesiones - a.sesiones)
      .slice(0, 4),
  }
}

async function cargarTrafico($: EngineInterface, p: Periodo, consent?: string): Promise<Trafico> {
  if (!config.gaProperty) {
    throw new Pasos(
      'Falta tu propiedad de Analytics: escribí /config, buscá "tablero" → "Propiedad de Google Analytics" y pegá el número. ' +
        '¿No lo sabés? Preguntale a Claude: "listame mis propiedades de Google Analytics con su ID".',
    )
  }
  const text = await llamar($, 'ga', {
    property_id: config.gaProperty.replace(/^properties\//, ''),
    date_ranges: [
      { start_date: p.desde, end_date: p.hasta, name: 'actual' },
      { start_date: p.prevDesde, end_date: p.prevHasta, name: 'anterior' },
    ],
    dimensions: ['sessionDefaultChannelGroup'],
    metrics: ['sessions', 'totalUsers'],
    limit: 50,
  }, consent)
  const r = leerJson<GaReport & { error?: string }>(text)
  if (r.error) throw new Error(r.error.slice(0, 200))
  return resumirTrafico(r)
}

type MetaSummary = Record<string, string | undefined>

/** Lee la respuesta de un MCP con get_account_summary (actual y anterior en una llamada). */
export function resumirMeta(text: string): Meta {
  let body = JSON.parse(text) as { result?: string; summary?: MetaSummary; prev_summary?: MetaSummary; error?: string }
  if (typeof body.result === 'string') body = JSON.parse(body.result)
  if (body.error) throw new Error(String(body.error).slice(0, 200))
  const a = body.summary ?? {}
  const b = body.prev_summary ?? {}
  const par = (k: string): Par => ({ actual: Number(a[k] ?? 0), anterior: Number(b[k] ?? 0) })
  return {
    gasto: par('spend'),
    compras: par('purchases'),
    ingresosMeta: par('revenue'),
    clicks: par('clicks'),
    impresiones: par('impressions'),
  }
}

type MetaEntidad = {
  amount_spent?: { value?: string } | string
  omni_purchase?: string
  purchase_roas?: string
  clicks?: string
  impressions?: string
}

/** Lee la respuesta de ads_get_ad_entities del MCP oficial de Meta, a nivel cuenta. */
export function leerEntidadMeta(text: string) {
  const body = JSON.parse(text) as { ad_entities?: string | MetaEntidad[]; error?: unknown }
  if (body.error) throw new Error(JSON.stringify(body.error).slice(0, 200))
  const lista = typeof body.ad_entities === 'string' ? (JSON.parse(body.ad_entities) as MetaEntidad[]) : body.ad_entities ?? []
  const e = lista[0] ?? {}
  const gasto = Number(typeof e.amount_spent === 'object' ? e.amount_spent.value ?? 0 : e.amount_spent ?? 0)
  return {
    gasto,
    compras: Number(e.omni_purchase ?? 0),
    ingresos: Number(e.purchase_roas ?? 0) * gasto,
    clicks: Number(e.clicks ?? 0),
    impresiones: Number(e.impressions ?? 0),
  }
}

/** Agrupa las llamadas de Meta de esta sesión, como pide el MCP oficial. */
const conversacionMeta = Array.from({ length: 20 }, () =>
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)],
).join('')

async function cargarMeta($: EngineInterface, p: Periodo, consent?: string): Promise<Meta> {
  if (!config.metaAccount) {
    throw new Pasos(
      'Falta tu cuenta de Meta: escribí /config, buscá "tablero" → "Cuenta publicitaria de Meta" y pegá el ID (act_...). ' +
        '¿No lo sabés? Preguntale a Claude: "listame mis cuentas publicitarias de Meta con su ID".',
    )
  }
  const numero = config.metaAccount.replace(/^act_/, '')
  const tool = await herramienta($, 'meta')

  if (tool.endsWith('__ads_get_ad_entities')) {
    const pedir = (desde: string, hasta: string) =>
      llamar($, 'meta', {
        ad_account_id: numero,
        level: 'ad_account',
        fields: ['amount_spent', 'omni_purchase', 'purchase_roas', 'clicks', 'impressions'],
        time_range: JSON.stringify({ since: desde, until: hasta }),
        include_additional_context: false,
        client_conversation_id: conversacionMeta,
      }, consent)
    const [ta, tb] = await Promise.all([pedir(p.desde, p.hasta), pedir(p.prevDesde, p.prevHasta)])
    const a = leerEntidadMeta(ta)
    const b = leerEntidadMeta(tb)
    return {
      gasto: { actual: a.gasto, anterior: b.gasto },
      compras: { actual: a.compras, anterior: b.compras },
      ingresosMeta: { actual: a.ingresos, anterior: b.ingresos },
      clicks: { actual: a.clicks, anterior: b.clicks },
      impresiones: { actual: a.impresiones, anterior: b.impresiones },
    }
  }

  const text = await llamar($, 'meta', {
    account_id: `act_${numero}`,
    date_from: p.desde,
    date_to: p.hasta,
    prev_date_from: p.prevDesde,
    prev_date_to: p.prevHasta,
  }, consent)
  return resumirMeta(text)
}

function mensaje(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Recarga un rango. `consent` describe lo que hizo la persona (comando o botón);
 * el refresco por timer no lleva y depende de las reglas de permiso.
 */
async function refresh($: EngineInterface, cual: Rango, consent?: string) {
  const dias = RANGOS.find(r => r.id === cual)!.dias
  const p = periodo(await $.clock.now(), dias)
  const previo = (await read($, datos))[cual]
  const cargando = <T,>(f?: Fuente<T>): Fuente<T> => ({ ...f, status: 'loading' })
  await update($, datos, d => ({
    ...d,
    [cual]: {
      ventas: cargando(previo?.ventas),
      trafico: cargando(previo?.trafico),
      meta: cargando(previo?.meta),
      desde: p.desde,
      hasta: p.hasta,
      actualizado: previo?.actualizado,
    },
  }))

  const poner = async <K extends 'ventas' | 'trafico' | 'meta'>(k: K, f: Tablero[K]) => {
    await update($, datos, d => {
      const t = d[cual]!
      return { ...d, [cual]: { ...t, [k]: f } }
    })
  }
  const cargar = async <K extends 'ventas' | 'trafico' | 'meta'>(
    k: K,
    fn: () => Promise<NonNullable<Tablero[K]['data']>>,
  ) => {
    try {
      await poner(k, { status: 'ok', data: await fn() } as Tablero[K])
    } catch (err) {
      await poner(k, { status: 'error', data: previo?.[k]?.data, error: mensaje(err) } as Tablero[K])
    }
  }

  await Promise.all([
    cargar('ventas', () => cargarVentas($, p, consent)),
    cargar('trafico', () => cargarTrafico($, p, consent)),
    cargar('meta', () => cargarMeta($, p, consent)),
  ])
  const iso = new Date((await $.clock.now()) + AR_OFFSET_MS).toISOString()
  await update($, datos, d => ({ ...d, [cual]: { ...d[cual]!, actualizado: iso.slice(11, 16) } }))
}

async function elegir($: EngineInterface, cual: Rango, label: string) {
  await update($, rango, () => cual)
  const ya = (await read($, datos))[cual]
  if (!ya || ya.ventas.status === 'error' || ya.trafico.status === 'error' || ya.meta.status === 'error') {
    await refresh($, cual, `The user pressed "${label}" on the Tablero pane to see that period's sales, traffic and Meta Ads.`)
  }
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
      description: 'Tablero: ventas Tiendanube + Analytics + Meta Ads (hoy / 7 / 30 días)',
    })
    return next(e)
  })

  on('command.run', { command: 'tablero' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Tablero' })
    const cual = await read($, rango)
    void refresh($, cual, 'The user ran /tablero to see sales, traffic and Meta Ads for the selected period.')
    timer?.cancel()
    timer = $.clock.every(REFRESH_MS, async () => refresh($, await read($, rango)))
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
    const cual = await read($, rango)
    const t = (await read($, datos))[cual]
    const comparado = cual === 'hoy' ? 'vs ayer completo' : 'vs período anterior'

    const estado = (f: Fuente<unknown> | undefined) =>
      !f || (f.status === 'loading' && !f.data)
        ? <Text dimColor>Cargando…</Text>
        : f.status === 'error'
          ? <Text color="red" wrap="wrap">{f.error}</Text>
          : null

    const fila = (label: string, valor: string, p?: Par) => (
      <Text>
        {label.padEnd(11)} <Text bold>{valor}</Text>
        {p ? <Text dimColor> {delta(p)}</Text> : ''}
      </Text>
    )

    const v = t?.ventas.data
    const tr = t?.trafico.data
    const m = t?.meta.data
    const ticket = v && v.pedidos.actual > 0 ? v.cobrado.actual / v.pedidos.actual : 0
    const conversion = v && tr && tr.sesiones.actual > 0 ? (v.pedidos.actual / tr.sesiones.actual) * 100 : undefined
    const mer = v && m && m.gasto.actual > 0 ? v.cobrado.actual / m.gasto.actual : undefined
    const roasMeta = m && m.gasto.actual > 0 ? m.ingresosMeta.actual / m.gasto.actual : undefined

    return (
      <Box flexDirection="column">
        <Box>
          {RANGOS.map(r => (
            <Button
              key={`r-${r.id}`}
              label={r.label}
              hotkey={r.hotkey}
              variant={r.id === cual ? 'primary' : 'secondary'}
              onPress={() => elegir($, r.id, r.label)}
            />
          ))}
        </Box>
        <Text dimColor>
          {t ? (t.desde === t.hasta ? t.desde : `${t.desde} → ${t.hasta}`) : ''} · {comparado}
          {t?.actualizado ? ` · actualizado ${t.actualizado}` : ''}
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
          {conversion !== undefined && fila('Conversión', `${decimal(conversion, 2)}%`)}
          {tr && tr.canales.length > 0 && (
            <Text dimColor wrap="wrap">
              {tr.canales.map(c => `${c.canal} ${numero(c.sesiones)}`).join(' · ')}
            </Text>
          )}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold color="magenta">META ADS{config.metaNombre || config.metaAccount ? ` · ${config.metaNombre || config.metaAccount}` : ''}</Text>
          {estado(t?.meta)}
          {m && fila('Gasto', plata(m.gasto.actual), m.gasto)}
          {m && fila('Compras', numero(m.compras.actual), m.compras)}
          {roasMeta !== undefined && fila('ROAS Meta', `${decimal(roasMeta)}x`)}
          {mer !== undefined && fila('MER', `${decimal(mer)}x`)}
          {mer !== undefined && <Text dimColor>MER = cobrado en Tiendanube ÷ gasto en Meta</Text>}
        </Box>

        <Box marginTop={1}>
          <Button
            key="refresh"
            label="Actualizar"
            hotkey="r"
            onPress={() =>
              refresh($, cual, 'The user pressed "Actualizar" on the Tablero pane to reload sales, traffic and Meta Ads.')
            }
          />
        </Box>
      </Box>
    )
  })
}
