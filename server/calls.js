// Журнал дзвінків: приём «зеркальных» событий и результатов разговоров от операторского
// Telegram-бота (этап 1 поглощения: старая система шлёт и в 1С, И к нам). Этап 2 (после Б4):
// события 1С/Binotel пойдут к нам напрямую, здесь же появятся НАШИ правила маршрутизации
// (клиент на гарантии / гарантия закончилась / потенциальный / в оформлении — по нашей базе).
// Auth: заголовок X-Calls-Token === CALLS_INGEST_TOKEN (env). Чтение журнала — фронт напрямую
// из Firestore (правила: только владелец).
const nowIso = () => new Date().toISOString()

// Телефон к каноничному +380… (бот шлёт 380XXXXXXXXX без плюса).
const normPhone = (raw) => {
  const d = String(raw || '').replace(/\D/g, '')
  if (d.length === 9) return '+380' + d
  if (d.length === 10 && d.startsWith('0')) return '+38' + d
  if (d.length === 11 && d.startsWith('80')) return '+3' + d
  if (d.length === 12 && d.startsWith('380')) return '+' + d
  return d ? '+' + d : ''
}

export function registerCalls(app, deps) {
  const { adminDb } = deps
  const TOKEN = process.env.CALLS_INGEST_TOKEN || ''

  const guard = (req, res) => {
    if (!TOKEN) { res.status(503).json({ ok: false, error: 'CALLS_INGEST_TOKEN not set' }); return false }
    if (req.get('x-calls-token') !== TOKEN) { res.status(403).json({ ok: false, error: 'bad token' }); return false }
    if (!adminDb) { res.status(503).json({ ok: false, error: 'no db' }); return false }
    return true
  }

  // Событие звонка (call.incoming / call.completed). Документ на звонок: callEvents/{callId}.
  app.post('/api/calls/event', async (req, res) => {
    if (!guard(req, res)) return
    try {
      const b = req.body || {}
      const callId = String(b.callId || '')
      if (!callId || !b.phone) return res.status(400).json({ ok: false, error: 'callId і phone обовʼязкові' })
      const ref = adminDb.collection('callEvents').doc(callId)
      const ts = b.timestamp || nowIso()
      await adminDb.runTransaction(async (tx) => {
        const snap = await tx.get(ref)
        const cur = snap.exists ? snap.data() : {}
        tx.set(ref, {
          callId,
          sourceCallId: b.sourceCallId || cur.sourceCallId || null,
          phone: normPhone(b.phone) || String(b.phone),
          clientName: b.clientName || cur.clientName || null,
          clientId: b.clientId || cur.clientId || null,
          line: b.line || cur.line || null,
          employee: b.employee || cur.employee || null,
          employeeId: b.employeeId || cur.employeeId || null,
          at: cur.at || ts, // час початку (перше подія)
          ...(b.type === 'call.completed' ? { completedAt: ts } : {}),
          lastType: b.type || null,
          updatedAt: nowIso(),
        }, { merge: true })
      })
      res.json({ ok: true })
    } catch (e) {
      console.error('calls/event:', e.message)
      res.status(500).json({ ok: false })
    }
  })

  // Результат разговора (резюме оператора; при «Принято» руководителем приходит повторно
  // с reviewedAt/reviewedByName — merge обновляет карточку).
  app.post('/api/calls/result', async (req, res) => {
    if (!guard(req, res)) return
    try {
      const b = req.body || {}
      const id = String(b.id || '')
      if (!id || !b.resultText) return res.status(400).json({ ok: false, error: 'id і resultText обовʼязкові' })
      await adminDb.collection('callResults').doc(id).set({
        id,
        callId: b.callId || null,
        phone: normPhone(b.phone) || String(b.phone || ''),
        clientName: b.clientName || null,
        resultText: String(b.resultText),
        operatorName: b.operatorName || null,
        operatorId: b.operatorId ?? null,
        createdAt: b.createdAt || nowIso(),
        sentTo1C: b.sentTo1C !== false,
        reviewedAt: b.reviewedAt || null,
        reviewedByName: b.reviewedByName || null,
        mirroredAt: nowIso(),
      }, { merge: true })
      res.json({ ok: true })
    } catch (e) {
      console.error('calls/result:', e.message)
      res.status(500).json({ ok: false })
    }
  })
}

export default registerCalls
