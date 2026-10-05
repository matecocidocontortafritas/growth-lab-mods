import { expect, mock, test } from 'claude-code/testing'

// 2026-10-05 17:00 en Argentina
const NOW = Date.parse('2026-10-05T20:00:00Z')

const order = (at: string, total: string, pago: string, status = 'open') => ({
  status,
  payment_status: pago,
  completed_at: at,
  total: { amount: total },
})

const HOY = [
  order('2026-10-05T19:00:00Z', '200000', 'paid'),
  order('2026-10-05T15:00:00Z', '100000', 'paid'),
  order('2026-10-05T14:00:00Z', '50000', 'pending'),
  order('2026-10-05T13:00:00Z', '90000', 'paid', 'cancelled'),
]
const AYER = [order('2026-10-04T15:00:00Z', '150000', 'paid')]

const fila = (dims: string[], valores: number[]) => ({
  dimension_values: dims.map(value => ({ value })),
  metric_values: valores.map(v => ({ value: String(v) })),
})

// sesiones, usuarios, nuevos, sesiones/usuario, duración media (s), vistas de producto
const GA_TOTALES = {
  rows: [
    fila(['20261005', 'actual'], [1000, 800, 300, 1.25, 252, 2400]),
    fila(['20261004', 'anterior'], [2000, 1600, 600, 1.25, 126, 4800]),
    fila(['20261004', 'actual'], [0, 0, 0, 0, 0, 0]),
  ],
}
const GA_CANALES = {
  rows: [
    fila(['Unassigned', 'actual'], [900]),
    fila(['Direct', 'actual'], [100]),
    fila(['Unassigned', 'anterior'], [2000]),
  ],
}

const META = {
  result: JSON.stringify({
    summary: { spend: '100000', impressions: '1000', clicks: '50', view_content: '300', purchases: '5', revenue: '500000' },
    prev_summary: { spend: '200000', impressions: '2000', clicks: '50', view_content: '600', purchases: '4', revenue: '400000' },
  }),
}

const TOOLS = [
  { name: 'mcp__tiendanube__list_orders', description: 'Tool to retrieve a list of orders for the store (Tiendanube)', mcp: true },
  { name: 'mcp__google-analytics__run_report', description: 'Runs a Google Analytics Data API report.', mcp: true },
  { name: 'mcp__meta__get_account_summary', description: 'Resumen de una cuenta de Meta Ads', mcp: true },
]
// Herramientas vacías: el mod las tiene que encontrar solo.
const SIN_TOOLS = { tiendanube_tool: '', ga_tool: '', meta_tool: '' }
const OPCIONES = { options: { ...SIN_TOOLS, ga_property: '123456789', meta_account: '987654321', meta_nombre: 'Mi tienda' } }

const PANE = {
  plugin: 'tablero',
  component: 'Pane',
  requestId: 'tablero',
  props: { title: 'Tablero', isFocused: false, bodyColumns: 70, placement: 'dock' } as never,
} as const

/** Responde como los tres conectores, y anota cada llamada. */
function conectores(calls: Record<string, unknown>[] = []) {
  return async ($: unknown, e: unknown) => {
    const args = { ...(e as object) } as Record<string, unknown>
    calls.push(args)
    const tool = String(args.tool)
    if (tool.endsWith('list_orders')) {
      const orders = String(args.completed_at_from).startsWith('2026-10-05') ? HOY : AYER
      return { result: {}, text: JSON.stringify({ orders, total: orders.length }) }
    }
    if (tool.endsWith('run_report')) {
      const porCanal = (args.dimensions as string[])[0] === 'sessionDefaultChannelGroup'
      return { result: {}, text: JSON.stringify(porCanal ? GA_CANALES : GA_TOTALES) }
    }
    return { result: {}, text: JSON.stringify(META) }
  }
}

test('el tablero de hoy cruza Tiendanube, Analytics y Meta', OPCIONES, async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.list', async () => ({ value: TOOLS }))
  const calls: Record<string, unknown>[] = []
  on('tool.call', conectores(calls))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    const all = (await ui.find({ type: 'Box' }))?.text ?? ''
    // Ventas
    expect(all).toContain('$300.000') // cobrado: 200k + 100k, sin el cancelado
    expect(all).toContain('▲100%') // 300k vs 150k ayer
    // Tráfico
    expect(all).toContain('Usuarios nuevos')
    expect(all).toContain('300 ▼50%')
    expect(all).toContain('1,25 =') // sesiones por usuario, igual que ayer
    expect(all).toContain('4m 12s ▲100%') // 252 s vs 126 s
    expect(all).toContain('2.400') // vistas de producto
    expect(all).toContain('0,30%') // conversión: 3 pedidos / 1000 sesiones
    expect(all).toContain('Unassigned 900 · Direct 100')
    // Meta
    expect(all).toContain('META ADS · Mi tienda')
    expect(all).toContain('Inversión')
    expect(all).not.toContain('Gasto')
    expect(all).toContain('Impresiones')
    expect(all).toContain('5,00% ▲100%') // CTR: 50/1000 vs 50/2000
    expect(all).toContain('5,0x') // ROAS Meta: 500k / 100k
    expect(all).toContain('3,0x') // MER: 300k / 100k
    // Ya no hay selector de período
    expect(await ui.find({ key: 'r-7d' })).toBeUndefined()
    await ui.unmount()
  }

  const ga = calls.find(c => String(c.tool).endsWith('run_report'))!
  expect(ga.property_id).toBe('123456789')
  expect(ga.date_ranges).toEqual([
    { start_date: '2026-10-05', end_date: '2026-10-05', name: 'actual' },
    { start_date: '2026-10-04', end_date: '2026-10-04', name: 'anterior' },
  ])
  const tn = calls.filter(c => String(c.tool).endsWith('list_orders'))
  expect(tn.every(c => c.limit === 30)).toBe(true)
  expect(calls.find(c => String(c.tool).endsWith('get_account_summary'))?.account_id).toBe('act_987654321')
})

test('si una fuente falla, las otras se muestran igual', OPCIONES, async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.list', async () => ({ value: TOOLS }))
  const ok = conectores()
  on('tool.call', async ($, e) => {
    if (String((e as { tool: string }).tool).endsWith('get_account_summary')) return { deny: 'sin permiso' }
    return ok($, e)
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  const all = (await ui.find({ type: 'Box' }))?.text ?? ''
  expect(all).toContain('"mcp__meta__get_account_summary"')
  expect(all).toContain('$300.000')
  expect(all).toContain('1.000')
})

test('sin /config ni conectores, cada bloque explica qué hacer', { options: { ...SIN_TOOLS, ga_property: '', meta_account: '' } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.list', async () => ({ value: TOOLS.slice(0, 1) }))
  on('tool.call', conectores())

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  const all = (await ui.find({ type: 'Box' }))?.text ?? ''
  expect(all).toContain('$300.000')
  expect(all).toContain('Falta tu propiedad de Analytics')
  expect(all).toContain('Falta tu cuenta de Meta')
})

test('con el MCP oficial de Meta pide hoy y ayer, y calcula los ingresos con el ROAS', OPCIONES, async ($, on) => {
  mock.clock(on, { now: NOW })
  const OFICIAL = 'mcp__meta-oficial__ads_get_ad_entities'
  // Si están los dos servidores de Meta, gana el oficial.
  on('tool.list', async () => ({ value: [...TOOLS, { name: OFICIAL, description: 'Retrieves live or draft campaigns, ad sets, ads, and their metrics.', mcp: true }] }))
  const meta: Record<string, unknown>[] = []
  const resto = conectores()
  on('tool.call', async ($, e) => {
    const args = { ...e } as Record<string, unknown>
    if (args.tool !== OFICIAL) {
      if (String(args.tool).endsWith('get_account_summary')) throw new Error('no debería usar el otro MCP de Meta')
      return resto($, e)
    }
    meta.push(args)
    const hoy = String(args.time_range).includes('2026-10-05')
    const entidad = hoy
      ? { id: '1', name: 'X', amount_spent: { value: '100000', unit: 'ARS' }, impressions: '1000', clicks: '20', omni_view_content: '300', omni_purchase: '5', purchase_roas: '5' }
      : { id: '1', name: 'X', amount_spent: { value: '200000', unit: 'ARS' }, impressions: '2000', clicks: '20', omni_view_content: '600', omni_purchase: '4', purchase_roas: '2' }
    return { result: {}, text: JSON.stringify({ ad_entities: JSON.stringify([entidad]) }) }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  const all = (await ui.find({ type: 'Box' }))?.text ?? ''
  expect(all).toContain('$100.000 ▼50%') // inversión
  expect(all).toContain('2,00% ▲100%') // CTR: 20/1000 vs 20/2000
  expect(all).toContain('5,0x') // ROAS Meta: 500k / 100k
  expect(all).toContain('3,0x') // MER: 300k / 100k
  expect(meta).toHaveLength(2)
  expect(meta[0]).toEqual(expect.objectContaining({ ad_account_id: '987654321', level: 'ad_account' }))
  expect(meta[0]?.fields).toContain('omni_view_content')
  expect(String(meta[0]?.client_conversation_id)).toMatch(/^[A-Za-z0-9]{20}$/)
})

test('si el conector responde un error en texto, el panel lo muestra', OPCIONES, async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.list', async () => ({ value: TOOLS }))
  const ok = conectores()
  on('tool.call', async ($, e) => {
    if (String((e as { tool: string }).tool).endsWith('list_orders')) {
      return { result: {}, text: 'Error: MCP tool response exceeds maximum allowed tokens' }
    }
    return ok($, e)
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Box' }))?.text ?? '').toContain('exceeds maximum allowed tokens')
})
