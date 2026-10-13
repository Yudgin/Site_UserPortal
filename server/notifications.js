// Журнал информирования клиента: оповещения (готова калькуляция, отправлен кораблик и т.д.)
// с АВТО-выбором канала. Правила окна доставки (проверено по докам провайдеров):
//   • Telegram — окна нет: после первого контакта бот может писать в любой момент
//     (бесплатно). Значит если есть Telegram-сессия — шлём в мессенджер.
//   • Viber — сессия = 24 часа от последнего сообщения КЛИЕНТА; внутри бесплатно/без лимита,
//     вне — «bot-initiated» (платно/ненадёжно) → уходим в SMS.
//   • Нет мессенджер-сессии (заявка с веб-формы) или окно закрыто → SMS (TurboSMS).
// Пороги настраиваются через env (в часах): NOTIFY_VIBER_WINDOW_H (24), NOTIFY_TELEGRAM_WINDOW_H (0=без лимита).
import { verifyFirebaseStaff } from './adminAuth.js'
import { rateLimit, combine } from './rateLimit.js'

const nowIso = () => new Date().toISOString()

// Довільне повідомлення (custom) — платний SMS-шлюз: обмеження довжини (один SMS-сегмент кирилицею
// ≈ 70 символів, тому 300 = до 5 сегментів), ліміт на співробітника (ключ — uid, майстри можуть
// сидіти за одним NAT) і ідемпотентність за clientKey (подвійний тап/ретрай ≠ другий SMS).
const CUSTOM_MAX_LEN = Number(process.env.NOTIFY_CUSTOM_MAX_LEN || 300)
const CLIENT_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/
const customLimiter = combine(
  rateLimit({ name: 'notify-custom-min', windowMs: 60 * 1000, max: Number(process.env.NOTIFY_CUSTOM_PER_MIN || 10),
    keyFn: (req) => req.staff.uid, message: 'Забагато повідомлень — зачекайте хвилину' }),
  rateLimit({ name: 'notify-custom-day', windowMs: 24 * 3600 * 1000, max: Number(process.env.NOTIFY_CUSTOM_PER_DAY || 60),
    keyFn: (req) => req.staff.uid, message: 'Денний ліміт повідомлень клієнтам вичерпано' }),
)
const NP_TRACK_URL = 'https://novaposhta.ua/tracking/?cargo_number='
// Події, які приймає /api/notify. Невідоме імʼя раніше проходило як «вільний текст» повз cap/ліміт.
const ALLOWED_EVENTS = ['offer', 'actual', 'ttn', 'custom']
// ТТН Нової Пошти — 14 цифр; приймаємо 8–20 цифр після очищення (інші формати перевізників).
const normTtn = (v) => { const d = String(v ?? '').replace(/\D/g, ''); return d && d !== '0' ? d : '' }
const TTN_RE = /^\d{8,20}$/

const CHANNEL_WINDOW_MS = {
  viber: Number(process.env.NOTIFY_VIBER_WINDOW_H || 24) * 3600 * 1000,
  telegram: Number(process.env.NOTIFY_TELEGRAM_WINDOW_H || 0) * 3600 * 1000, // 0 = без лимита
}

// Клиентские шаблоны авто-оповещений (укр.). Для custom берётся текст мастера.
const template = (event, ctx) => {
  switch (event) {
    case 'offer':
      return `Доброго дня! Ми підготували попередню калькуляцію по вашому корабликові RunFerry.${ctx.link ? ` Ознайомитись і обрати варіант: ${ctx.link}` : ''}`
    case 'actual':
      return `Роботи по вашому корабликові виконано — готова фактична калькуляція.${ctx.link ? ` Деталі та оплата: ${ctx.link}` : ''}`
    case 'ttn':
      return `Ваш кораблик RunFerry відправлено 📦${ctx.ttn ? ` ТТН: ${ctx.ttn}.` : ''}${ctx.link ? ` Відстежити: ${ctx.link}` : ''}`
    default:
      return ctx.text || ''
  }
}

export function registerNotifications(app, deps) {
  const { adminDb, senders = {}, sendSms, siteUrl = 'https://my.runferry.com' } = deps

  // Время последнего входящего (от КЛИЕНТА) сообщения — определяет окно Viber.
  const lastClientAt = (session) => {
    const msgs = (session?.messages || []).filter((m) => m && m.role === 'client' && m.at)
    if (!msgs.length) return null
    return msgs.reduce((mx, m) => (m.at > mx ? m.at : mx), msgs[0].at)
  }

  // Открыт ли канал мессенджера для проактивной отправки прямо сейчас.
  const messengerOpen = (session) => {
    if (!session || !session.channel) return false
    if (typeof senders[session.channel] !== 'function') return false
    // Без хотя бы одного входящего сообщения клиента проактивная отправка ненадёжна
    // (Telegram может отклонить bot-initiated, Viber — вне сессии) → лучше SMS.
    if (!lastClientAt(session)) return false
    const win = CHANNEL_WINDOW_MS[session.channel]
    if (!win || win <= 0) return true // без лимита (Telegram)
    return Date.now() - new Date(lastClientAt(session)).getTime() <= win
  }

  // Реально ли доставлено. Провайдеры отвечают HTTP 200 даже при логической ошибке
  // (Telegram {ok:false}, Viber {status:≠0}), а send() глотает и сетевые ошибки (→ null).
  // Поэтому проверяем содержимое ответа, иначе провал молча пометится 'sent' и не будет SMS-фолбэка.
  const deliveredOk = (channel, r) => {
    if (!r) return false
    if (channel === 'telegram') return r.ok === true
    if (channel === 'viber') return r.status === 0
    return !!r
  }
  const deliveryDetail = (r) => {
    if (!r) return 'no response'
    return r.description || r.status_message || (typeof r === 'object' ? JSON.stringify(r).slice(0, 120) : String(r))
  }

  // Основной вызов: отправить оповещение клиенту. Авто-выбор канала (мессенджер → иначе SMS).
  // Идемпотентно по (serviceRequestId, event) для авто-событий (offer/actual/ttn) — не задваивает.
  async function notifyClient({ serviceRequestId = null, sessionId = null, phone = null, text = null, event = 'custom', link = null, ttn = null, by = null, clientKey = null }) {
    // Подтягиваем заявку (получатель, ссылки).
    let req = null
    if (serviceRequestId) {
      const snap = await adminDb.collection('serviceRequests').doc(serviceRequestId).get()
      req = snap.exists ? snap.data() : null
    }
    // Пріоритет: явна сесія → Telegram-привʼязка із deep-link (tgSessionId, безкоштовний канал
    // без вікна) → сесія-джерело заявки. Історія чату заявки при цьому не змінюється.
    const sid = sessionId || req?.tgSessionId || req?.sessionId || null
    const toPhone = phone || req?.clientPhone || null

    // Ссылка по событию (если не передана явно).
    let resolvedLink = link
    if (!resolvedLink && req) {
      if (event === 'offer' && req.offerId) resolvedLink = `${siteUrl}/offer/${req.offerId}`
      if (event === 'actual' && req.actualEstimateId) resolvedLink = `${siteUrl}/estimate/${req.actualEstimateId}`
    }
    // ТТН відправлення клієнту: явний номер → returnTtn («→ клієнту»). waybillNumber — ТТН «до нас»,
    // її клієнту НЕ шлемо (легасі-записи переносить бекфіл). Посилання на трекінг НП — з цифр номера.
    const resolvedTtn = event === 'ttn' ? (normTtn(ttn) || normTtn(req?.returnTtn) || null) : null
    if (event === 'ttn' && !resolvedTtn) throw Object.assign(new Error('Вкажіть ТТН відправлення клієнту'), { code: 'NO_TTN', status: 400 })
    if (!resolvedLink && event === 'ttn' && resolvedTtn) resolvedLink = `${NP_TRACK_URL}${resolvedTtn}`
    const body = event === 'custom' ? (text || '') : template(event, { link: resolvedLink, ttn: resolvedTtn, text })
    if (!body || !body.trim()) throw new Error('empty notification body')

    // Идемпотентность авто-событий (offer/actual/ttn): детерминированный id + ТРАНЗАКЦИОННЫЙ захват,
    // чтобы два параллельных вызова не отправили дважды. Уже отправленное → skip; свежую 'pending'
    // (другой вызов сейчас шлёт) тоже пропускаем; иначе резервируем и продолжаем отправку.
    // ВАЖНО: ttn идемпотентен ПО НОМЕРУ накладной — исправленный/новый ТТН уходит клиенту, а
    // повторная отправка того же номера не задваивается (offer/actual — по одному разу на заявку).
    // custom — ідемпотентний за clientKey (ключ генерує клієнт на кожне нове повідомлення; формат
    // валідовано вище), без ключа — як раніше, окремий документ на кожну відправку.
    const ttnSlug = String(resolvedTtn || 'none').replace(/[^\w-]+/g, '').slice(0, 40)
    const customKey = event === 'custom' && clientKey && CLIENT_KEY_RE.test(String(clientKey)) ? String(clientKey) : null
    const autoId = serviceRequestId && (event !== 'custom' || customKey)
      ? (event === 'ttn' ? `ntf-${serviceRequestId}-ttn-${ttnSlug}` : event === 'custom' ? `ntf-${serviceRequestId}-custom-${customKey}` : `ntf-${serviceRequestId}-${event}`)
      : null
    const ref = autoId ? adminDb.collection('notifications').doc(autoId) : adminDb.collection('notifications').doc()
    if (autoId) {
      const claim = await adminDb.runTransaction(async (tx) => {
        const snap = await tx.get(ref)
        const cur = snap.exists ? snap.data() : null
        if (cur && cur.status === 'sent') return { skip: true, rec: cur }
        if (cur && cur.status === 'pending' && cur.claimedAt && Date.now() - new Date(cur.claimedAt).getTime() < 60000) {
          return { skip: true, rec: cur }
        }
        tx.set(ref, { id: autoId, status: 'pending', claimedAt: nowIso(), event, serviceRequestId }, { merge: true })
        return { skip: false }
      })
      if (claim.skip) return { ...claim.rec, skipped: true }
    }

    // Загружаем сессию для выбора канала.
    let session = null
    if (sid) {
      const s = await adminDb.collection('chatSessions').doc(sid).get()
      session = s.exists ? s.data() : null
    }

    let channel = null
    let via = null
    let ok = false
    let error = null
    if (session && messengerOpen(session)) {
      channel = session.channel
      try {
        const r = await senders[channel](session, body)
        if (deliveredOk(channel, r)) { ok = true; via = 'messenger' }
        else error = `messenger(${channel}): ${deliveryDetail(r)}`
      } catch (e) {
        error = `messenger: ${e?.message || e}`
      }
    }
    if (!ok) {
      if (toPhone && typeof sendSms === 'function') {
        channel = 'sms'
        try {
          const r = await sendSms(toPhone, body)
          ok = r?.ok !== false
          via = 'sms'
          if (!ok) error = r?.error || 'sms failed'
        } catch (e) {
          error = `sms: ${e?.message || e}`
        }
      } else if (!error) {
        error = 'немає доступного каналу (мессенджер поза вікном і немає телефону)'
      }
    }
    if (ok) error = null // успешная доставка (в т.ч. SMS-фолбэк) — без ошибки в журнале

    const rec = {
      id: ref.id,
      createdAt: nowIso(),
      serviceRequestId: serviceRequestId || null,
      serviceCenterId: req?.serviceCenterId || null, // розріз по центрах для стрічки «Увага»
      sessionId: sid,
      phone: toPhone || null,
      event,
      channel,
      via,
      status: ok ? 'sent' : 'failed',
      error: error || null,
      text: body,
      by: by || null,
    }
    await ref.set(rec)
    return rec
  }

  // Отправить оповещение (RBAC 1b: владелец/директор/мастер; бухгалтер — только чтение).
  // Авто-события фронт шлёт при публикации калькуляций/ТТН. НЕ-владелец: только в привязке к
  // заявке СВОЕГО центра и только на телефон заявки (платный SMS-шлюз — не для произвольных номеров).
  app.post('/api/notify', async (req, res) => {
    const staff = await verifyFirebaseStaff(req, ['owner', 'director', 'master'])
    if (!staff) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Доступ лише для власника, директора або майстра' } })
    }
    try {
      const { serviceRequestId, text, event, clientKey } = req.body || {}
      let { phone, sessionId, link, ttn } = req.body || {}
      const ev = event || 'custom'
      if (!ALLOWED_EVENTS.includes(ev)) return res.status(400).json({ success: false, error: { code: 'BAD_EVENT', message: 'Невідома подія оповіщення' } })
      if (ev === 'ttn' && ttn !== undefined && ttn !== null && ttn !== '') {
        ttn = normTtn(ttn)
        if (!TTN_RE.test(ttn)) return res.status(400).json({ success: false, error: { code: 'BAD_TTN', message: 'ТТН має містити лише цифри (8–20)' } })
      } else if (ev === 'ttn') ttn = null
      if (staff.role !== 'owner') {
        if (!serviceRequestId) return res.status(400).json({ success: false, error: { code: 'NEED_REQUEST', message: 'Потрібна заявка' } })
        const srSnap = await adminDb.collection('serviceRequests').doc(String(serviceRequestId)).get()
        const sr = srSnap.exists ? srSnap.data() : null
        if (!sr) return res.status(404).json({ success: false, error: { code: 'NO_SR', message: 'Заявку не знайдено' } })
        const own = !!sr.serviceCenterId && staff.centers.some((c) => c && c.centerId === sr.serviceCenterId)
        if (!own) return res.status(403).json({ success: false, error: { code: 'OTHER_CENTER', message: 'Заявка іншого сервісного центру' } })
        // Не-власник: адресат і посилання — ТІЛЬКИ із заявки (інакше можна направити повідомлення
        // в чужу сесію месенджера або підмінити посилання на кошторис).
        phone = null; sessionId = null; link = null
      }
      if (ev === 'custom') {
        const body = String(text || '').trim()
        if (!body) return res.status(400).json({ success: false, error: { code: 'EMPTY_TEXT', message: 'Порожнє повідомлення' } })
        if (body.length > CUSTOM_MAX_LEN) {
          return res.status(400).json({ success: false, error: { code: 'TEXT_TOO_LONG', message: `Повідомлення задовге (максимум ${CUSTOM_MAX_LEN} символів)` } })
        }
      }
      // Ліміт на співробітника для подій, які ініціює людина (custom і ttn; offer/actual ідемпотентні
      // по заявці). combine синхронний: якщо перевищено — 429 уже надіслано.
      if (ev === 'custom' || ev === 'ttn') {
        req.staff = staff
        let passed = false
        customLimiter(req, res, () => { passed = true })
        if (!passed) return
      }
      const rec = await notifyClient({
        serviceRequestId: serviceRequestId || null,
        sessionId: sessionId || null,
        phone: phone || null,
        text: text || null,
        event: ev,
        link: link || null,
        ttn: ttn || null,
        by: staff.email || staff.uid,
        clientKey: clientKey || null,
      })
      res.json({ success: true, data: rec })
    } catch (e) {
      if (e?.status === 400) return res.status(400).json({ success: false, error: { code: e.code || 'BAD_REQ', message: e.message } })
      console.error('notify error:', e?.message || e)
      res.status(500).json({ success: false, error: { code: 'NOTIFY_FAILED', message: e?.message || 'Не вдалося надіслати' } })
    }
  })

  return { notifyClient }
}

export default registerNotifications
