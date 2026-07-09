// Ответ менеджера из веб-инбокса (обращения). Единый серверный путь:
//  1) сохраняем сообщение менеджера в сессию;
//  2) ДОСТАВЛЯЕМ его клиенту в его канал (Telegram/Viber — пуш; web — клиент видит по поллингу);
//  3) если менеджер УПОМЯНУЛ бота («…зараз Клод підкаже…») — бот снимает паузу и продолжает
//     диалог с клиентом по указанию (как в Telegram Business).
// Доступ — только админ (Firebase ID-токен). Канальные отправители инжектятся через deps.senders.
import { createMessengerCore, nowIso, genMsgId, accumulateUsage, mentionsBot } from './messengerCore.js'
import { verifyFirebaseAdmin } from './adminAuth.js'

export function registerManagerReply(app, deps) {
  const { adminDb, senders = {} } = deps
  const core = createMessengerCore(deps)

  app.post('/api/messenger/manager-reply', async (req, res) => {
    if (!(await verifyFirebaseAdmin(req))) return res.status(403).json({ success: false })
    if (!adminDb) return res.status(503).json({ success: false, error: { code: 'NO_DB', message: 'Firestore не настроен' } })
    try {
      const { sessionId, text } = req.body || {}
      const t = String(text || '').trim()
      if (!sessionId || !t) return res.status(400).json({ success: false, error: { code: 'BAD_INPUT', message: 'Потрібні sessionId і text' } })

      const snap = await adminDb.collection('chatSessions').doc(String(sessionId)).get()
      if (!snap.exists) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Сесію не знайдено' } })
      const session = snap.data()
      session.messages = Array.isArray(session.messages) ? session.messages : []
      session.messages.push({ id: genMsgId(), role: 'manager', text: t, at: nowIso() })

      // Доставка в канал клиента (web — отправителя нет, клиент читает сессию поллингом).
      const deliver = senders[session.channel]
      if (deliver) { try { await deliver(session, t) } catch (e) { console.error('deliver manager msg:', e.message) } }

      let botReply = null
      if (mentionsBot(t)) {
        // Менеджер позвал бота — возвращаем его в диалог и продолжаем по директиве.
        session.botPaused = false
        const { reply, needsManager, intent, usage } = await core.aiReply(session, { managerDirective: t })
        session.messages.push({ id: genMsgId(), role: 'ai', text: reply, at: nowIso() })
        if (usage) session.aiUsage = accumulateUsage(session.aiUsage, usage)
        if (intent) session.topic = intent
        if (needsManager) core.applyEscalation(session, intent)
        if (deliver) { try { await deliver(session, reply) } catch (e) { console.error('deliver bot reply:', e.message) } }
        botReply = reply
      } else {
        // Менеджер ведёт сам — бот на паузе для этого диалога.
        session.botPaused = true
      }

      await core.saveSession(session)
      return res.json({ success: true, data: { session, botReply } })
    } catch (e) {
      console.error('manager-reply:', e.message)
      res.status(500).json({ success: false, error: { code: 'REPLY_FAILED', message: 'Не вдалося надіслати відповідь' } })
    }
  })
}

export default registerManagerReply
