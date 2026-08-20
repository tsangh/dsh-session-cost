// dsh-session-cost — per-session API cost for DSH.
//
// Reads the real billed token usage of each session (per assistant/message
// `usage` records in the durable session log, via the local DSH API) and
// prices it with DeepSeek's official peak/off-peak schema.
//
// Pricing source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
//   Fetched 2026-08-20. Peak hours (Beijing time): 09:00-12:00, 14:00-18:00;
//   off-peak is half the peak price. Prices are CNY per 1M tokens.
//
//     model                input miss (peak/off)   cache hit (peak/off)   output (peak/off)
//     deepseek-v4-flash    ¥3.00 / ¥1.50           ¥0.10 / ¥0.05         ¥9.00 / ¥4.50
//     deepseek-v4-pro      ¥9.00 / ¥4.50           ¥0.30 / ¥0.15         ¥27.00 / ¥13.50
//
// The USD figure is derived with a configurable FX rate (CNY per USD,
// default 7.1). DeepSeek bills CNY; check the platform console for the
// authoritative amount.
//
// Config (row config in cordis.patch.yml):
//   { dshApi?: string            — DSH backend base URL (default http://127.0.0.1:3080)
//     usdRate?: number           — CNY per 1 USD (default 7.1)
//     hkdRate?: number           — CNY per 1 HKD (default 0.91)
//     peakHours?: [[h1, h2], …]  — Beijing peak hour ranges, [start, end) (default [[9,12],[14,18]])
//     pricing?: object           — extra/override model prices, same shape as DEFAULT_PRICING
//     overviewLimit?: number     — max sessions in the no-sessionId overview (default 8)
//     stdoutMaxBytes?: number    — shell stdout capture budget for big histories (default 512 MB) }

export const name = 'session-cost'
export const inject = ['tools']

const DEFAULT_DSH_API = 'http://127.0.0.1:3080'
const DEFAULT_USD_RATE = 7.1 // CNY per 1 USD
// CNY per 1 HKD. HKD is USD-pegged (~7.75-7.85); 7.1 / 7.80 ≈ 0.91.
const DEFAULT_HKD_RATE = 0.91
const DEFAULT_PEAK_HOURS = [[9, 12], [14, 18]] // Beijing time, [startHour, endHour)
// Foreground stdout capture budget passed to ctx.shell (sh.resolve). Long
// session.history responses easily exceed dsh-shell's default budget, which
// truncates output and breaks JSON.parse — raise it far above any real log.
const DEFAULT_STDOUT_MAX_BYTES = 512 * 1024 * 1024
const PRICING_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ (fetched 2026-08-20)'

const DEFAULT_PRICING = {
  'deepseek-v4-flash': {
    uncachedInput: { peak: 3.0, off: 1.5 },
    cacheRead: { peak: 0.10, off: 0.05 },
    output: { peak: 9.0, off: 4.5 },
  },
  'deepseek-v4-pro': {
    uncachedInput: { peak: 9.0, off: 4.5 },
    cacheRead: { peak: 0.30, off: 0.15 },
    output: { peak: 27.0, off: 13.5 },
  },
}

// ---- helpers ----------------------------------------------------------------

// true when `epochMs` falls in a Beijing-time peak window.
function isPeak(epochMs, peakHours) {
  // Beijing is UTC+8 with no DST.
  const bj = new Date(epochMs + 8 * 3600 * 1000)
  const h = bj.getUTCHours()
  return peakHours.some(([s, e]) => h >= s && h < e)
}

function priceOf(pricing, model, bucket, peak) {
  const p = pricing[model]
  if (!p || !p[bucket]) return null
  return p[bucket][peak ? 'peak' : 'off']
}

function fmtInt(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function fmtYuan(v) {
  return v.toFixed(4).replace(/\.?0+$/, '')
}

// Beijing time string for an epoch ms.
function bjTime(epochMs) {
  const d = new Date(epochMs + 8 * 3600 * 1000)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

// ---- pricing core -----------------------------------------------------------

// Fold one session's events into billed buckets split by peak/off-peak.
// Returns { model, billed (count), spanStart, spanEnd,
//           buckets: { uncachedInput: {tokens, cny, peakCny, offCny}, … } }
function foldSession(events, pricing, peakHours) {
  const buckets = {
    uncachedInput: { tokens: 0, cny: 0, peakCny: 0, offCny: 0 },
    cacheRead: { tokens: 0, cny: 0, peakCny: 0, offCny: 0 },
    output: { tokens: 0, cny: 0, peakCny: 0, offCny: 0 },
  }
  let model = null
  let billed = 0
  let spanStart = null
  let spanEnd = null
  for (const entry of events) {
    const ev = entry.event || {}
    if (ev.type !== 'assistant/message') continue
    const data = ev.data || {}
    const usage = data.usage
    if (!usage) continue
    const ts = typeof ev.time === 'number' ? ev.time : null
    const src = (data.message && data.message.source) || {}
    model = model || src.model || null
    const peak = ts == null ? false : isPeak(ts, peakHours)
    if (ts != null) {
      spanStart = spanStart == null ? ts : Math.min(spanStart, ts)
      spanEnd = spanEnd == null ? ts : Math.max(spanEnd, ts)
    }
    const rows = [
      ['uncachedInput', usage.inputTokens || 0],
      ['cacheRead', usage.cacheReadTokens || 0],
      ['output', usage.outputTokens || 0],
    ]
    for (const [bucket, tokens] of rows) {
      if (!tokens) continue
      const price = priceOf(pricing, model || '', bucket, peak)
      if (price == null) continue
      const cost = (tokens / 1e6) * price
      const b = buckets[bucket]
      b.tokens += tokens
      b.cny += cost
      if (peak) b.peakCny += cost
      else b.offCny += cost
    }
    billed += 1
  }
  return { model, billed, spanStart, spanEnd, buckets }
}

// ---- output formatting ------------------------------------------------------

function formatSession(session, fold, usdRate, hkdRate) {
  const totalCny = Object.values(fold.buckets).reduce((s, b) => s + b.cny, 0)
  const peakCny = Object.values(fold.buckets).reduce((s, b) => s + b.peakCny, 0)
  const offCny = Object.values(fold.buckets).reduce((s, b) => s + b.offCny, 0)
  const tokens = Object.values(fold.buckets).reduce((s, b) => s + b.tokens, 0)
  const out = []
  const title = (session.projections && session.projections.values && session.projections.values.title) || ''
  out.push(`Session ${session.sessionId}${title ? ' 「' + title + '」' : ''}`)
  out.push(`  模型: ${fold.model || '(未知)'} · 计费请求: ${fold.billed} · 时间跨度(北京): ${fold.spanStart ? bjTime(fold.spanStart) : '—'} ~ ${fold.spanEnd ? bjTime(fold.spanEnd) : '—'}`)
  out.push(`  价格表: DeepSeek 官方 ${PRICING_SOURCE} · 高峰 09:00-12:00/14:00-18:00(北京), 空闲半价`)
  out.push('')
  out.push('  桶                  tokens      费用(¥)   其中高峰(¥)  其中空闲(¥)')
  const names = [
    ['uncachedInput', '输入(缓存未命中)'],
    ['cacheRead', '输入(缓存命中)'],
    ['output', '输出'],
  ]
  for (const [key, label] of names) {
    const b = fold.buckets[key]
    out.push(`  ${label.padEnd(14)} ${fmtInt(b.tokens).padStart(12)}  ${fmtYuan(b.cny).padStart(9)}  ${fmtYuan(b.peakCny).padStart(10)}  ${fmtYuan(b.offCny).padStart(10)}`)
  }
  const cacheReadTokens = fold.buckets.cacheRead.tokens
  const inputTokens = fold.buckets.uncachedInput.tokens + cacheReadTokens
  const hit = inputTokens ? Math.round((cacheReadTokens / inputTokens) * 100) : null
  out.push('')
  out.push(`  合计: ${tokens.toLocaleString('en-US')} tokens · ¥${fmtYuan(totalCny)} ≈ $${fmtYuan(totalCny / usdRate)} ≈ HK$${fmtYuan(totalCny / hkdRate)}` +
    `  (高峰 ¥${fmtYuan(peakCny)} · 空闲 ¥${fmtYuan(offCny)})`)
  if (hit != null) out.push(`  缓存命中率: ${hit}%`)
  if (!fold.model) out.push('  ⚠ 会话无计费请求(无 assistant/message usage 记录)')
  else if (!Object.prototype.hasOwnProperty.call(DEFAULT_PRICING, fold.model) && !sessionCostPricingHas(fold.model)) {
    out.push(`  ⚠ 模型 ${fold.model} 不在价格表中，费用可能为 0；请在插件 config 的 pricing 里补充`)
  }
  return out.join('\n')
}

// module-level flag so the unknown-model warning works outside the apply closure.
let _pricingKeys = Object.keys(DEFAULT_PRICING)
function sessionCostPricingHas(model) {
  return _pricingKeys.includes(model)
}

// Pure helpers exported for standalone verification (ignored by the loader).
export { foldSession, isPeak, priceOf, DEFAULT_PRICING, DEFAULT_PEAK_HOURS }

function formatOverview(rows, usdRate, hkdRate) {
  const out = []
  out.push(`会话费用总览（最近 ${rows.length} 个会话，按更新时间排序）`)
  out.push('  ' + '模型'.padEnd(18) + 'tokens'.padStart(10) + '  费用(¥)'.padStart(9) + '  ≈$'.padStart(8) + '  ≈HK$'.padStart(9) + '  标题')
  for (const r of rows) {
    const title = (r.title || '').slice(0, 24)
    out.push(`  ${String(r.model || '—').padEnd(18)} ${fmtInt(r.tokens).padStart(10)} ${fmtYuan(r.cny).padStart(8)} ${fmtYuan(r.cny / usdRate).padStart(7)} ${fmtYuan(r.cny / hkdRate).padStart(8)}  ${title}`)
  }
  out.push('')
  out.push('价格表: DeepSeek 官方 ' + PRICING_SOURCE + '；带 sessionId 调用可看单个会话的峰/谷明细。')
  return out.join('\n')
}

// ---- API access via ctx.shell + curl (same path as the golden dsh-tools) ----

async function apiCall(sh, dshApi, method, payload, stdoutMaxBytes = DEFAULT_STDOUT_MAX_BYTES) {
  const env = JSON.stringify({ type: 'client-request', rpcId: 'sc' + Date.now(), method, payload })
  const cmd = 'curl -s -m 60 -X POST ' + JSON.stringify(dshApi + '/api/' + method) +
    " -H 'Content-Type: application/json' -d " + JSON.stringify(env)
  // stdoutMaxBytes: dsh-shell truncates foreground stdout past the executor
  // budget; a long session.history is well over the default and would corrupt
  // the JSON. Raise the capture budget so the full response is returned.
  const res = await sh.run(sh.resolve({ command: cmd, timeoutMs: 70000, stdoutMaxBytes }))
  const text = collectedText(res.stdout)
  const data = JSON.parse(text || '{}')
  const r = data.result
  if (!r || r.ok !== true) throw new Error(`${method} failed: ${r && r.error ? r.error : text.slice(0, 200)}`)
  return r.value
}

function collectedText(o) {
  if (o == null) return ''
  if (typeof o === 'string') return o
  if (typeof o === 'object' && typeof o.text === 'string') return o.text
  return String(o)
}

// ---- plugin -----------------------------------------------------------------

export function apply(ctx, config = {}) {
  const dshApi = config.dshApi || DEFAULT_DSH_API
  const usdRate = config.usdRate || DEFAULT_USD_RATE
  const hkdRate = config.hkdRate || DEFAULT_HKD_RATE
  const peakHours = config.peakHours || DEFAULT_PEAK_HOURS
  const pricing = { ...DEFAULT_PRICING, ...(config.pricing || {}) }
  _pricingKeys = Object.keys(pricing)
  const overviewLimit = Math.max(1, Math.min(50, config.overviewLimit || 8))
  const stdoutMaxBytes = Math.max(1, Number(config.stdoutMaxBytes) || DEFAULT_STDOUT_MAX_BYTES)

  ctx.tools.register({
    name: 'session_cost',
    description: 'Per-session DeepSeek API cost. Without sessionId: overview table of the most recent sessions (tokens + cost). With sessionId: exact breakdown by billing bucket (uncached input / cache read / output) split by peak vs off-peak hours, priced with DeepSeek official peak/off-peak schema (CNY, USD and HKD).',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session id; omit for an overview of recent sessions' },
        limit: { type: 'number', description: 'Overview row count (default config.overviewLimit)' },
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const sh = ctx.get('shell')
      if (!sh) return 'session_cost: shell service unavailable'
      try {
        const sessionId = String(args.sessionId || '').trim()
        if (sessionId) {
          const value = await apiCall(sh, dshApi, 'session.history', { sessionId, maxMessages: 100000 }, stdoutMaxBytes)
          const events = (value && value.events) || []
          const fold = foldSession(events, pricing, peakHours)
          const session = { sessionId, projections: { values: {} } }
          return formatSession(session, fold, usdRate, hkdRate)
        }
        // Overview: most recent sessions, exact per-session fold from each log.
        const list = await apiCall(sh, dshApi, 'session.list', {})
        const items = (list && list.items) || []
        const limit = Math.max(1, Math.min(50, Number(args.limit) || overviewLimit))
        const recent = items
          .slice()
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
          .slice(0, limit)
        const rows = []
        for (const s of recent) {
          try {
            const value = await apiCall(sh, dshApi, 'session.history', { sessionId: s.sessionId, maxMessages: 100000 }, stdoutMaxBytes)
            const events = (value && value.events) || []
            const fold = foldSession(events, pricing, peakHours)
            const cny = Object.values(fold.buckets).reduce((sum, b) => sum + b.cny, 0)
            const tokens = Object.values(fold.buckets).reduce((sum, b) => sum + b.tokens, 0)
            const title = (s.projections && s.projections.values && s.projections.values.title) || ''
            rows.push({ model: fold.model || '—', tokens, cny, title })
          } catch (e) {
            rows.push({ model: '(error)', tokens: 0, cny: 0, title: String(e.message).slice(0, 24) })
          }
        }
        return formatOverview(rows, usdRate, hkdRate)
      } catch (e) {
        return 'session_cost error: ' + e.message
      }
    },
  })
}
