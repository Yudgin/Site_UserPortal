// Журнал информирования клиента: оповещения (готова калькуляция, отправлен кораблик и т.д.)
// с АВТО-выбором канала. Правила окна доставки (проверено по докам провайдеров):
//   • Telegram — окна нет: после первого контакта бот может писать в любой момент
//     (бесплатно). Значит если есть Telegram-сессия — шлём в мессенджер.
//   • Viber — сессия = 24 часа от последнего сообщения КЛИЕНТА; внутри бесплатно/без лимита,
//     вне — «bot-initiated» (платно/ненадёжно) → уходим в SMS.
//   • Нет мессенджер-сессии (заявка с веб-формы) или окно закрыто → SMS (TurboSMS).
// Пороги настраиваются через env (в часах): NOTIFY_VIBER_WINDOW_H (24), NOTIFY_TELEGRAM_WINDOW_H (0=без лимита).
import { verifyFirebaseAdmin } from './adminAuth.js'

const nowIso = () => new Date().toISOString()

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
  async function notifyClient({ serviceRequestId = null, sessionId = null, phone = null, text = null, event = 'custom', link = null, ttn = null, by = null }) {
    // Подтягиваем заявку (получатель, ссылки).
    let req = null
    if (serviceRequestId) {
      const snap = await adminDb.collection('serviceRequests').doc(serviceRequestId).get()
      req = snap.exists ? snap.data() : null
    }
    const sid = sessionId || req?.sessionId || null
    const toPhone = phone || req?.clientPhone || null

    // Ссылка по событию (если не передана явно).
    let resolvedLink = link
    if (!resolvedLink && req) {
      if (event === 'offer' && req.offerId) resolvedLink = `${siteUrl}/offer/${req.offerId}`
      if (event === 'actual' && req.actualEstimateId) resolvedLink = `${siteUrl}/estimate/${req.actualEstimateId}`
    }
    const resolvedTtn = ttn || req?.waybillNumber || null
    const body = event === 'custom' ? (text || '') : template(event, { link: resolvedLink, ttn: resolvedTtn, text })
    if (!body || !body.trim()) throw new Error('empty notification body')

    // Идемпотентность авто-событий (offer/actual/ttn): детерминированный id + ТРАНЗАКЦИОННЫЙ захват,
    // чтобы два параллельных вызова не отправили дважды. Уже отправленное → skip; свежую 'pending'
    // (другой вызов сейчас шлёт) тоже пропускаем; иначе резервируем и продолжаем отправку.
    const autoId = serviceRequestId && event !== 'custom' ? `ntf-${serviceRequestId}-${event}` : null
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

  // Отправить оповещение (админ). Авто-события фронт шлёт при публикации калькуляций/ТТН.
  app.post('/api/notify', async (req, res) => {
    if (!(await verifyFirebaseAdmin(req))) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Доступ лише для адміністратора' } })
    }
    try {
      const { serviceRequestId, sessionId, phone, text, event, link, ttn } = req.body || {}
      const rec = await notifyClient({
        serviceRequestId: serviceRequestId || null,
        sessionId: sessionId || null,
        phone: phone || null,
        text: text || null,
        event: event || 'custom',
        link: link || null,
        ttn: ttn || null,
        by: 'admin@runferry.de',
      })
      res.json({ success: true, data: rec })
    } catch (e) {
      console.error('notify error:', e?.message || e)
      res.status(500).json({ success: false, error: { code: 'NOTIFY_FAILED', message: e?.message || 'Не вдалося надіслати' } })
    }
  })

  return { notifyClient }
}

export default registerNotifications
