// Повторне посилання на сторінку заявки: попередній контракт порталу, ізольований від сценарію дзвінка.
// Лише VG_AI_RESEND_URL + токен VG_AI_RESEND_SECRET. Телефон моделі й серверу не передаємо; результат доставки
// не вигадуємо: HTTP успіх означає лише прийнятий запит. У тестах — підроблений HTTP на loopback.
export const resendPayload = ({ serviceRequestId, gcid }) => ({ serviceRequestId, gcid: gcid || null })

export function makeResendLink({ url = null, getToken = null, timeoutMs = 3000, fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  return async ({ serviceRequestId, gcid }) => {
    if (!url || !getToken) return { ok: false, error: 'disabled' }
    if (!serviceRequestId) return { ok: false, error: 'no_request' }
    const controller = new AbortController()
    let timer
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('таймаут')) }, timeoutMs)
      })
      return await Promise.race([(async () => {
        const token = String(await getToken() || '').trim()
        if (controller.signal.aborted) throw new Error('таймаут')
        if (!token) throw new Error('нет токена')
        const r = await fetchImpl(url, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(resendPayload({ serviceRequestId, gcid })), signal: controller.signal,
          redirect: 'error',
        })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        await r.body?.cancel()
        return { ok: true, accepted: true }
      })(), timeout])
    } catch (e) {
      const reason = /^HTTP \d{3}$/.test(e?.message || '') ? e.message : controller.signal.aborted ? 'таймаут' : 'ошибка'
      log(`повторная ссылка: запрос не выполнен (${reason})`)
      return { ok: false, error: 'unavailable' }
    } finally { clearTimeout(timer) }
  }
}
