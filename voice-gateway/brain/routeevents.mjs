// Події шлюзу для сервера режиму обговорення: POST /api/discussions/route-event (записка runferry-briefs/telephony/
// discussion-mode-2026-10-16.md, розд. 4.3) — {serviceRequestId, generalCallID, event, ownerUid, at}. Сервер веде
// пропуски ведучого, автопаузу й строк обговорення. ТИПОВО ВИМКНЕНО: адреса — VG_DS_EVENTS_URL, токен — секрет у Secret
// Manager з ім'ям VG_DS_EVENTS_SECRET (заголовок Authorization: Bearer); запис у прод — лише за згодою власника.
// Номерів телефонів у подіях немає. Надсилаємо у фоні з тайм-аутом: дзвінок ніколи не чекає сервера; помилки — лише в лог.
//   route — шлюз дзвонить ведучому; answered — ведучий узяв, клієнта з'єднано; joined — ведучий приєднався до розмови
//   клієнта з ШІ; callback_connected — перезвін через 901 з'єднано; fallback — не взяв / «2» / без «1» / клієнт чекав
//   після фрази довше VG_DS_MAX_WAIT_SEC (486 «зайнятий» — не fallback); ai_ended — клієнт поговорив із ШІ при відкритому
//   обговоренні (сервер лише продовжує строк); client_hangup — клієнт поклав під час фрази чи гудків (без пропуску).
export const ROUTE_EVENTS = ['route', 'answered', 'joined', 'callback_connected', 'fallback', 'ai_ended', 'client_hangup']

export function makeRouteEvents({ url = null, getToken = null, fetchImpl = globalThis.fetch, timeoutMs = 3000, log = () => {} } = {}) {
  let tokenP = null
  const token = () => {
    if (!getToken) return Promise.resolve(null)
    tokenP = tokenP || Promise.resolve().then(() => getToken()).then((t) => String(t ?? '').trim() || null)
    tokenP.catch(() => { tokenP = null }) // наступна подія спробує ще раз
    return tokenP
  }
  // → Promise (тести чекають; шлюз — ні) або null, якщо подію не надсилаємо
  function send(e) {
    if (!url || !getToken || !e || !ROUTE_EVENTS.includes(e.event) || !e.serviceRequestId) return null
    const body = {
      serviceRequestId: String(e.serviceRequestId),
      generalCallID: e.generalCallID != null ? String(e.generalCallID) : null,
      event: e.event,
      ownerUid: e.ownerUid != null ? String(e.ownerUid) : null,
      at: e.at || new Date().toISOString(),
    }
    // Бюджет включає отримання секрету; пізній секрет після тайм-ауту вже не запускає POST.
    const controller = new AbortController()
    let timer
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        tokenP = null
        reject(new Error('timeout'))
      }, Math.max(1, timeoutMs))
    })
    const p = Promise.race([expired, (async () => {
      const t = await token()
      controller.signal.throwIfAborted()
      if (!t) throw new Error('no_token')
      const r = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return true
    })()])
    return p.catch((err) => {
      const why = controller.signal.aborted ? `таймаут ${timeoutMs} мс` : /^HTTP \d{3}$/.test(err?.message) ? err.message : err?.message === 'no_token' ? 'пустой токен' : 'ошибка отправки или получения токена'
      log(`событие обсуждения ${body.event}: не отправлено (${why})`)
      return false
    }).finally(() => clearTimeout(timer))
  }
  return { send, enabled: !!url && !!getToken }
}

export default makeRouteEvents
