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
      const managerMsg = { id: genMsgId(), role: 'manager', text: t, at: nowIso() }
      const newMsgs = [managerMsg]
      const patch = {}

      // Доставка в канал клиента (web — отправителя нет, клиент читает сессию поллингом).
      const deliver = senders[session.channel]
      if (deliver) { try { await deliver(session, t) } catch (e) { console.error('deliver manager msg:', e.message) } }

      let botReply = null
      if (mentionsBot(t)) {
        // Менеджер позвал бота — возвращаем его в диалог и продолжаем по директиве.
        // Для контекста ИИ используем снимок + сообщение менеджера (записываем транзакционно ниже).
        const sessForAi = { ...session, messages: [...(session.messages || []), managerMsg] }
        const { reply, needsManager, intent, usage } = await core.aiReply(sessForAi, { managerDirective: t })
        newMsgs.push({ id: genMsgId(), role: 'ai', text: reply, at: nowIso() })
        patch.botPaused = false
        if (intent) patch.topic = intent
        if (usage) patch.aiUsage = accumulateUsage(session.aiUsage, usage)
        if (needsManager && session.status === 'active') {
          const esc = { ...session }
          core.applyEscalation(esc, intent)
          patch.status = esc.status
          patch.escalation = esc.escalation
        }
        if (deliver) { try { await deliver(session, reply) } catch (e) { console.error('deliver bot reply:', e.message) } }
        botReply = reply
      } else {
        patch.botPaused = true // менеджер ведёт сам
      }

      // Транзакционно дозаписываем сообщения к АКТУАЛЬНОМУ документу (не теряем параллельные).
      const updated = await core.appendMessages(sessionId, newMsgs, patch)
      return res.json({ success: true, data: { session: updated || session, botReply } })
    } catch (e) {
      console.error('manager-reply:', e.message)
      res.status(500).json({ success: false, error: { code: 'REPLY_FAILED', message: 'Не вдалося надіслати відповідь' } })
    }
  })
}

export default registerManagerReply
