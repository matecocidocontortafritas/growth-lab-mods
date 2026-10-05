import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallArgs, ToolCallResult } from 'claude-code'

import type { Pedido, Snapshot } from '../types'

const PANE = 'pedidos'
const PAGE_SIZE = 30 // más grande, la respuesta del conector supera el límite de Claude Code
const MAX_PAGES = 20
const REFRESH_MS = 5 * 60 * 1000
const AR_OFFSET_MS = -3 * 60 * 60 * 1000

const snapshot = atom({ plugin: 'pedidos', key: 'snapshot' } as const, {
  status: 'idle',
  fecha: '',
  pedidos: [],
} as Snapshot)

/** Lo que la persona cargó en /config, y la herramienta que encontramos. */
let toolConfigurada = ''
let toolEncontrada: string | undefined
let timer: { cancel: () => void } | undefined

type RawOrder = {
  id: string
  number: string
  status: string
  payment_status: string
  completed_at: string
  total?: { amount?: string; currency?: string }
  customer?: { name?: string }
}

/** Error con los pasos para resolverlo, que el panel muestra tal cual. */
export class Pasos extends Error {}

/** Fecha y hora de Argentina (UTC-3) para un instante. */
function arParts(ms: number) {
  const iso = new Date(ms + AR_OFFSET_MS).toISOString()
  return { fecha: iso.slice(0, 10), hora: iso.slice(11, 16) }
}

export function toPedido(o: RawOrder): Pedido {
  return {
    id: Number(o.id),
    number: Number(o.number),
    hora: arParts(Date.parse(o.completed_at)).hora,
    cliente: o.customer?.name ?? '—',
    total: Number(o.total?.amount ?? 0),
    moneda: o.total?.currency ?? 'ARS',
    pago: o.payment_status,
    estado: o.status,
  }
}

export function resumen(pedidos: Pedido[]) {
  const vivos = pedidos.filter(p => p.estado !== 'cancelled')
  const cobrado = vivos.filter(p => p.pago === 'paid').reduce((s, p) => s + p.total, 0)
  const pendiente = vivos
    .filter(p => p.pago === 'pending' || p.pago === 'authorized')
    .reduce((s, p) => s + p.total, 0)
  return { cantidad: vivos.length, cancelados: pedidos.length - vivos.length, cobrado, pendiente }
}

export function plata(n: number) {
  return '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

const PAGO: Record<string, string> = {
  paid: 'pagado',
  pending: 'pendiente',
  authorized: 'autorizado',
  partially_paid: 'pago parcial',
  refunded: 'reembolsado',
  partially_refunded: 'reemb. parcial',
  voided: 'anulado',
  expired: 'vencido',
  abandoned: 'abandonado',
  chargeback: 'contracargo',
}

/**
 * Busca la herramienta list_orders del conector de Tiendanube entre las que
 * tiene la sesión, salvo que la persona haya cargado una en /config.
 */
async function herramienta($: EngineInterface) {
  if (toolConfigurada) return toolConfigurada
  if (toolEncontrada) return toolEncontrada
  const tools = await $.tool.list()
  const candidatas = tools.filter(t => t.mcp && t.name.endsWith('__list_orders'))
  const tn = candidatas.find(t => /tiendanube|nuvemshop|tienda nube/i.test(t.name + t.description)) ?? candidatas[0]
  if (!tn) {
    throw new Pasos(
      'No encontré el conector de Tiendanube. Conectalo en claude.ai → Configuración → Conectores → Tiendanube ' +
        '(o agregá https://admin-mcp.tiendanube.com como conector), abrí una sesión nueva y volvé a escribir /pedidos.',
    )
  }
  toolEncontrada = tn.name
  return tn.name
}

async function callOrders($: EngineInterface, args: Record<string, unknown>, consent?: string) {
  const tool = await herramienta($)
  const input = { tool, ...(consent ? { consent } : {}), ...args } as unknown as ToolCallArgs
  const res: ToolCallResult = await $.tool.call(input)
  if (res.deny !== undefined) {
    throw new Pasos(
      `Claude Code no dejó consultar Tiendanube (${res.deny.slice(0, 120)}). ` +
        `Si usás modo automático, agregá este permiso en ~/.claude/settings.json → permissions.allow: "${tool}". ` +
        'Los pasos están en el README, sección Permisos.',
    )
  }
  const text = res.text ?? ''
  if (res.isError) throw new Error(text.slice(0, 200) || 'error del conector')
  return JSON.parse(text) as { orders?: RawOrder[]; total?: number }
}

/** `consent` dice qué hizo la persona (el comando o el botón); el timer no lleva. */
async function refresh($: EngineInterface, consent?: string) {
  const { fecha } = arParts(await $.clock.now())
  await update($, snapshot, (s): Snapshot => ({ ...s, status: 'loading', error: undefined }))
  try {
    const raw: RawOrder[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await callOrders($, {
        completed_at_from: `${fecha}T00:00:00-03:00`,
        status: ['open', 'closed', 'cancelled'],
        limit: PAGE_SIZE,
        page,
      }, consent)
      const orders = res.orders ?? []
      raw.push(...orders)
      if (orders.length < PAGE_SIZE || raw.length >= (res.total ?? 0)) break
    }
    const pedidos = raw
      .filter(o => arParts(Date.parse(o.completed_at)).fecha === fecha)
      .map(toPedido)
    const ahora = arParts(await $.clock.now()).hora
    await update($, snapshot, (): Snapshot => ({ status: 'ok', fecha, pedidos, actualizado: ahora }))
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await update($, snapshot, (s): Snapshot => ({ ...s, status: 'error', error }))
  }
}

export const register: Register = (on, options) => {
  toolConfigurada = String(options.tiendanube_tool ?? '').trim()
  toolEncontrada = undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pedidos',
      description: 'Panel con los pedidos de hoy de Tiendanube y cuánto vendiste',
    })
    return next(e)
  })

  on('command.run', { command: 'pedidos' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Pedidos de hoy' })
    void refresh($, 'The user ran /pedidos to see today\'s Tiendanube orders.')
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
    const s = await read($, snapshot)
    const r = resumen(s.pedidos)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 9)
    const width = e.props.bodyColumns ?? 60

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>
            Vendido hoy: <Text color="green">{plata(r.cobrado)}</Text>
          </Text>
          <Text>
            {r.cantidad} pedidos · pendiente {plata(r.pendiente)}
            {r.cancelados > 0 ? ` · ${r.cancelados} cancelados` : ''}
          </Text>
          <Text dimColor>
            {s.status === 'loading'
              ? 'Actualizando…'
              : s.actualizado
                ? `Actualizado ${s.actualizado} · se refresca cada 5 min`
                : 'Cargando…'}
          </Text>
          {s.status === 'error' && <Text color="red" wrap="wrap">{s.error}</Text>}
        </Box>
        {s.status === 'ok' && s.pedidos.length === 0 && <Text dimColor>Todavía no hay pedidos hoy.</Text>}
        {s.pedidos.slice(0, room).map(p => (
          <Text key={String(p.id)} dimColor={p.estado === 'cancelled'} wrap="truncate">
            {p.hora} #{p.number} {plata(p.total).padStart(10)} {(PAGO[p.pago] ?? p.pago).padEnd(10)}{' '}
            {p.cliente.slice(0, Math.max(8, width - 42))}
          </Text>
        ))}
        {s.pedidos.length > room && <Text dimColor>… y {s.pedidos.length - room} más</Text>}
        <Box marginTop={1}>
          <Button
            key="refresh"
            label="Actualizar"
            hotkey="r"
            onPress={() => refresh($, 'The user pressed "Actualizar" on the Pedidos de hoy pane to reload today\'s Tiendanube orders.')}
          />
        </Box>
      </Box>
    )
  })
}
