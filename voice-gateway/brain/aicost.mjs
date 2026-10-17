// Фактична ціна розмови з ШІ за даними ElevenLabs: GET /v1/convai/conversations/{conversation_id} (ключ xi-api-key із
// Secret Manager). Ціну ElevenLabs рахує ПІСЛЯ кінця розмови, тож питаємо у фоні з повторами (типово 6 разів по 10 с ≈
// 60 с), поки status не 'done' / 'failed' і поки в metadata немає cost. Дзвінок цього не чекає, помилки — лише в лог.
// Що беремо: metadata.cost — усього кредитів; metadata.charging.call_charge — кредити за голос; llm_charge — кредити за
// LLM; llm_price — ціна LLM у доларах; metadata.call_duration_secs. Оцінка «≈$» шлюзу (VG_AI_PRICE_PER_MIN) — лише голос.
const num = (v) => ((typeof v === 'number' || typeof v === 'string') && String(v).trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null)

// Відповідь ElevenLabs → {status, costCredits, callCharge, llmCharge, llmPriceUsd, durationSec} або null — ціни ще немає
export function parseConversationCost(j) {
  if (!j || typeof j !== 'object') return null
  const m = j.metadata || {}
  const ch = m.charging || {}
  const out = {
    status: j.status ?? null,
    costCredits: num(m.cost) ?? num(ch.cost),
    callCharge: num(ch.call_charge),
    llmCharge: num(ch.llm_charge),
    llmPriceUsd: num(ch.llm_price),
    durationSec: num(m.call_duration_secs),
  }
  if (out.costCredits == null && out.callCharge == null && out.llmCharge == null && out.llmPriceUsd == null) return null
  return out
}

const FINAL = new Set(['done', 'failed'])

// → {conversationId, ...ціна, attempts} або null (не вдалося / ціни так і не з'явилось). sleep — для тестів.
export async function fetchConversationCost({ conversationId, apiBase = 'https://api.elevenlabs.io', getApiKey, fetchImpl = globalThis.fetch, attempts = 6, intervalMs = 10000, timeoutMs = 8000, maxElapsedMs = 60000, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  if (!conversationId || !getApiKey) return null
  const id = String(conversationId)
  if (!/^[0-9A-Za-z_-]+$/.test(id)) return null
  const deadline = now() + Math.max(1, maxElapsedMs)
  const count = Math.max(1, Math.floor(Number(attempts) || 1))
  let last = null
  let used = 0
  for (let i = 1; i <= count && now() < deadline; i++) {
    if (i > 1) await sleep(Math.min(Math.max(0, intervalMs), Math.max(0, deadline - now())))
    if (now() >= deadline) break
    used = i
    const controller = new AbortController()
    let timer
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')) }, Math.max(1, Math.min(timeoutMs, deadline - now())))
    })
    try {
      const j = await Promise.race([expired, (async () => {
        const key = await getApiKey()
        controller.signal.throwIfAborted()
        if (!key) throw new Error('no_key')
        const r = await fetchImpl(`${apiBase.replace(/\/$/, '')}/v1/convai/conversations/${encodeURIComponent(id)}`, { headers: { 'xi-api-key': key }, signal: controller.signal })
        if (!r.ok) { const error = new Error(`HTTP ${r.status}`); error.status = r.status; throw error }
        return r.json()
      })()])
      const c = parseConversationCost(j)
      last = c || last
      // Ціна є й розмову закрито (або статусу немає) — готово. 404 після кінця сесії може бути тимчасовим.
      if (c && (c.status == null || FINAL.has(c.status))) return { conversationId: id, ...c, attempts: i }
    } catch (e) {
      if (e?.status === 401 || e?.status === 403) {
        const r = e
        log(`ElevenLabs: цена разговора ${id} недоступна (HTTP ${r.status})`)
        return null
      }
      const why = controller.signal.aborted ? 'таймаут' : /^HTTP \d{3}$/.test(e?.message) ? e.message : 'ошибка чтения цены'
      log(`ElevenLabs: цена разговора ${id}, попытка ${i}: ${why}`)
    } finally {
      clearTimeout(timer)
    }
  }
  return last ? { conversationId: id, ...last, attempts: used, final: false } : null
}

// Рядок для консолі: «N кредитов (голос X, LLM Y кр. / $Z)»
export function costLine(c) {
  if (!c) return null
  const parts = []
  if (c.callCharge != null) parts.push(`голос ${c.callCharge}`)
  if (c.llmCharge != null) parts.push(`LLM ${c.llmCharge} кр.${c.llmPriceUsd != null ? ` / $${c.llmPriceUsd.toFixed(4)}` : ''}`)
  else if (c.llmPriceUsd != null) parts.push(`LLM $${c.llmPriceUsd.toFixed(4)}`)
  return `${c.costCredits != null ? `${c.costCredits} кредитов` : 'кредиты не указаны'}${parts.length ? ` (${parts.join(', ')})` : ''}${c.final === false ? ', ElevenLabs ещё считает' : ''}`
}

export default fetchConversationCost
