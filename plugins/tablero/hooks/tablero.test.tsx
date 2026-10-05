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

const GA = {
  rows: [
    { dimension_values: [{ value: 'Unassigned' }, { value: 'actual' }], metric_values: [{ value: '900' }, { value: '800' }] },
    { dimension_values: [{ value: 'Direct' }, { value: 'actual' }], metric_values: [{ value: '100' }, { value: '90' }] },
    { dimension_values: [{ value: 'Unassigned' }, { value: 'anterior' }], metric_values: [{ value: '2000' }, { value: '1900' }] },
  ],
}

const META = {
  result: JSON.stringify({
    summary: { spend: '100000', purchases: '5', revenue: '500000', clicks: '10', impressions: '1000' },
    prev_summary: { spend: '200000', purchases: '4', revenue: '400000', clicks: '20', impressions: '2000' },
  }),
}

const TOOLS = [
  { name: 'mcp__tiendanube__list_orders', description: 'Tool to retrieve a list of orders for the store (Tiendanube)', mcp: true },
  { name: 'mcp__google-analytics__run_report', description: 'Runs a Google Analytics Data API report.', mcp: true },
  { name: 'mcp__meta__get_account_summary', description: 'Resumen de una cuenta de Meta Ads', mcp: true },
]
const OPCIONES = { options: { ga_property: '123456789', meta_account: '987654321', meta_nombre: 'Mi tienda' } }

const PANE = {
  plugin: 'tablero',
  component: 'Pane',
  requestId: 'tablero',
  props: { title: 'Tablero', isFocused: false, bodyColumns: 70, placement: 'dock' } as never,
} as const

test('el tablero cruza Tiendanube, Analytics y Meta para hoy', OPCIONES, async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.list', async () => ({ value: TOOLS }))
  const calls: Record<string, unknown>[] = []
  on('tool.call', async ($, e) => {
    const args = { ...e } as Record<string, unknown>
    calls.push(args)
    const tool = String(args.tool)
    if (tool.endsWith('list_orders')) {
      const orders = String(args.completed_at_from).startsWith('2026-10-05') ? HOY : AYER
      return { result: {}, text: JSON.stringify({ orders, total: orders.length }) }
    }
    if (tool.endsWith('run_report')) return { result: {}, text: JSON.stringify(GA) }
    return { result: {}, text: JSON.stringify(META) }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    const all = (await ui.find({ type: 'Box' }))?.text ?? ''
    expect(all).toContain('$300.000') // cobrado: 200k + 100k, sin el cancelado
    expect(all).toContain('▲100%') // 300k vs 150k ayer
    expect(all).toContain('1.000') // sesiones de hoy
    expect(all).toContain('0,30%') // 3 pedidos / 1000 sesiones
    expect(all).toContain('ROAS Meta') // 500k / 100k
    expect(all).toContain('5,0x')
    expect(all).toContain('3,0x') // MER: 300k / 100k
    expect(all).toContain('Unassigned 900 · Direct 100')
    expect(all).toContain('META ADS · Mi tienda')
    await ui.unmount()
  }

  const ga = calls.find(c => String(c.tool).endsWith('run_report'))!
  expect(ga.property_id).toBe('123456789')
  expect(calls.find(c => String(c.tool).endsWith('get_account_summary'))?.account_id).toBe('act_987654321')
  expect(ga.date_ranges).toEqual([
    { start_date: '2026-10-05', end_date: '2026-10-05', name: 'actual' },
    { start_date: '2026-10-04', end_date: '2026-10-04', name: 'anterior' },
  ])
})

test('si una fuente falla, las otras se muestran igual', OPCIONES, async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.list', async () => ({ value: TOOLS }))
  on('tool.call', async ($, e) => {
    const tool = String((e as { tool: string }).tool)
    if (tool.endsWith('get_account_summary')) return { deny: 'sin permiso' }
    if (tool.endsWith('run_report')) return { result: {}, text: JSON.stringify(GA) }
    return { result: {}, text: JSON.stringify({ orders: HOY, total: HOY.length }) }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  const all = (await ui.find({ type: 'Box' }))?.text ?? ''
  expect(all).toContain('"mcp__meta__get_account_summary"')
  expect(all).toContain('$300.000')
  expect(all).toContain('1.000')
})

test('el selector de 7 días pide el rango correcto', OPCIONES, async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.list', async () => ({ value: TOOLS }))
  const ga: Record<string, unknown>[] = []
  on('tool.call', async ($, e) => {
    const args = { ...e } as Record<string, unknown>
    const tool = String(args.tool)
    if (tool.endsWith('run_report')) {
      ga.push(args)
      return { result: {}, text: JSON.stringify(GA) }
    }
    if (tool.endsWith('list_orders')) return { result: {}, text: JSON.stringify({ orders: [], total: 0 }) }
    return { result: {}, text: JSON.stringify(META) }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'r-7d' })
  expect(ga.at(-1)?.date_ranges).toEqual([
    { start_date: '2026-09-29', end_date: '2026-10-05', name: 'actual' },
    { start_date: '2026-09-22', end_date: '2026-09-28', name: 'anterior' },
  ])
})

test('sin /config ni conectores, cada bloque explica qué hacer', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.list', async () => ({ value: TOOLS.slice(0, 1) }))
  on('tool.call', async () => ({ result: {}, text: JSON.stringify({ orders: HOY, total: HOY.length }) }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  const all = (await ui.find({ type: 'Box' }))?.text ?? ''
  expect(all).toContain('$300.000')
  expect(all).toContain('Falta tu propiedad de Analytics')
  expect(all).toContain('Falta tu cuenta de Meta')
})

test('con el MCP oficial de Meta pide actual y anterior, y calcula los ingresos con el ROAS', OPCIONES, async ($, on) => {
  mock.clock(on, { now: NOW })
  const OFICIAL = 'mcp__meta-oficial__ads_get_ad_entities'
  // Si están los dos servidores de Meta, gana el oficial.
  on('tool.list', async () => ({ value: [...TOOLS, { name: OFICIAL, description: 'Retrieves live or draft campaigns, ad sets, ads, and their metrics.', mcp: true }] }))
  const meta: Record<string, unknown>[] = []
  on('tool.call', async ($, e) => {
    const args = { ...e } as Record<string, unknown>
    const tool = String(args.tool)
    if (tool === OFICIAL) {
      meta.push(args)
      const hoy = String(args.time_range).includes('2026-10-05')
      const entidad = hoy
        ? { id: '1', name: 'X', amount_spent: { value: '100000', unit: 'ARS' }, omni_purchase: '5', purchase_roas: '5', clicks: '10', impressions: '1000' }
        : { id: '1', name: 'X', amount_spent: { value: '200000', unit: 'ARS' }, omni_purchase: '4', purchase_roas: '2', clicks: '20', impressions: '2000' }
      return { result: {}, text: JSON.stringify({ ad_entities: JSON.stringify([entidad]) }) }
    }
    if (tool.endsWith('run_report')) return { result: {}, text: JSON.stringify(GA) }
    if (tool.endsWith('list_orders')) {
      const orders = String(args.completed_at_from).startsWith('2026-10-05') ? HOY : AYER
      return { result: {}, text: JSON.stringify({ orders, total: orders.length }) }
    }
    throw new Error(`no debería llamar a ${tool}`)
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  const all = (await ui.find({ type: 'Box' }))?.text ?? ''
  expect(all).toContain('$100.000') // gasto de hoy
  expect(all).toContain('▼50%') // 100k vs 200k
  expect(all).toContain('5,0x') // ROAS Meta: 500k / 100k
  expect(all).toContain('3,0x') // MER: 300k / 100k
  expect(meta).toHaveLength(2)
  expect(meta[0]).toEqual(expect.objectContaining({ ad_account_id: '987654321', level: 'ad_account' }))
  expect(String(meta[0]?.client_conversation_id)).toMatch(/^[A-Za-z0-9]{20}$/)
})
