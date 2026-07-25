// Журнал дзвінків: приём «зеркальных» событий и результатов разговоров от операторского
// Telegram-бота (этап 1 поглощения: старая система шлёт и в 1С, И к нам). Этап 2 (после Б4):
// события 1С/Binotel пойдут к нам напрямую, здесь же появятся НАШИ правила маршрутизации
// (клиент на гарантии / гарантия закончилась / потенциальный / в оформлении — по нашей базе).
// Auth: заголовок X-Calls-Token === CALLS_INGEST_TOKEN (env). Чтение журнала — фронт напрямую
// из Firestore (правила: только владелец).
import axios from 'axios'
import { verifyFirebaseAdmin } from './adminAuth.js'

const nowIso = () => new Date().toISOString()

// Отправка комментария владельца/оператора с портала в 1С как «результат разговора»
// (тот же bot-контур 1С, что использует Telegram-бот: Basic Auth, путь с {phone}).
// Решение владельца: КАЖДЫЙ комментарий к звонку с веб-интерфейса уходит в 1С автоматически.
const ONEC = {
  base: (process.env.ONEC_BOT_BASE_URL || '').replace(/\/+$/, ''),
  user: process.env.ONEC_BOT_USERNAME || '',
  pass: process.env.ONEC_BOT_PASSWORD || '',
  path: process.env.ONEC_CALL_RESULT_PATH || '',
}
const sendNoteTo1C = async ({ sourceCallId, phone, text, by }) => {
  if (!ONEC.base || !ONEC.path) return false
  const digits = String(phone || '').replace(/\D/g, '')
  if (!digits) return false
  const endpoint = ONEC.path.replaceAll('{phone}', digits)
  try {
    await axios.post(`${ONEC.base}${endpoint}`, {
      callId: sourceCallId || '', // 1С чекає свій власний id дзвінка
      phone: digits,
      result: String(text),
      operatorId: 0,
      operatorName: by || 'Портал',
      chatId: 0,
      timestamp: nowIso(),
    }, {
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
      ...(ONEC.user ? { auth: { username: ONEC.user, password: ONEC.pass } } : {}),
    })
    return true
  } catch (e) {
    console.error('note→1C:', e?.response?.status || e.message)
    return false
  }
}

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

  // ==== Kyivstar Віртуальна мобільна АТС — Generic FMC API webhook ====
  // Kyivstar сам добавляет суффикс /callstate к «URL віддаленої системи», поэтому в их портале
  // (fmc.kyivstar.ua/crm-integration, тип CRM «Generic FMC API») указывается БАЗОВЫЙ URL
  // .../api/kyivstar, а POST приходит сюда. Авторизация: Authorization: Bearer <токен>,
  // токен задаём мы же (env KYIVSTAR_WEBHOOK_TOKEN) и вводим в поле «Токен віддаленої системи».
  // Состояния: alerting (телефон зазвонил) → established (ответили) → finished (завершён).
  // Документ на звонок: callEvents/ks-<call_id> — все состояния сливаются в одну запись.
  // ВАЖНО (из спеки): доставка «одна попытка, без повторов» — надёжная история потом
  // добирается методом GET /v1/callhistory (отдельная фаза-reconcile).
  const KS_TOKEN = process.env.KYIVSTAR_WEBHOOK_TOKEN || ''
  app.post('/api/kyivstar/callstate', async (req, res) => {
    if (!KS_TOKEN) return res.status(503).json({ ok: false, error: 'KYIVSTAR_WEBHOOK_TOKEN not set' })
    if ((req.get('authorization') || '') !== `Bearer ${KS_TOKEN}`) return res.status(403).json({ ok: false })
    if (!adminDb) return res.status(503).json({ ok: false })
    try {
      const b = req.body || {}
      const callId = String(b.call_id || '')
      const state = String(b.state_type || '')
      if (!callId || !state) return res.status(400).json({ ok: false, error: 'call_id і state_type обовʼязкові' })
      const ref = adminDb.collection('callEvents').doc(`ks-${callId}`)
      const now = nowIso()
      await adminDb.runTransaction(async (tx) => {
        const snap = await tx.get(ref)
        const cur = snap.exists ? snap.data() : {}
        // state_owner — номер сотрудника АТС (владелец звонка); групповой звонок может звонить
        // нескольким — копим всех, показываем последнего ответившего/актуального.
        const owners = new Set(cur.owners || [])
        if (b.state_owner) owners.add(String(b.state_owner))
        tx.set(ref, {
          callId: `ks-${callId}`,
          sourceCallId: callId,
          source: 'kyivstar',
          phone: normPhone(b.phone_number) || (b.phone_number ? String(b.phone_number) : cur.phone || ''),
          employee: b.state_owner ? String(b.state_owner) : cur.employee || null,
          owners: [...owners],
          direction: b.call_direction || cur.direction || null,
          at: cur.at || now,
          ...(state === 'established' ? { answeredAt: now } : {}),
          ...(state === 'finished' ? { completedAt: now } : {}),
          lastType: `ks.${state}`,
          callControlId: b.call_control_id || cur.callControlId || null,
          updatedAt: now,
        }, { merge: true })
      })
      res.json({ ok: true })
    } catch (e) {
      console.error('kyivstar/callstate:', e.message)
      res.status(500).json({ ok: false })
    }
  })

  // Комментарий к звонку с ПОРТАЛА (владелец/оператор в вебе): сохраняем в документ журнала
  // И автоматически отправляем в 1С как результат разговора. body: { kind, docId, text, by? }
  app.post('/api/calls/note', async (req, res) => {
    if (!(await verifyFirebaseAdmin(req))) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Доступ лише для власника' } })
    }
    if (!adminDb) return res.status(503).json({ success: false })
    try {
      const { kind, docId, text, by } = req.body || {}
      if (!docId || !text || !String(text).trim()) {
        return res.status(400).json({ success: false, error: { code: 'BAD_REQ', message: 'docId і text обовʼязкові' } })
      }
      const coll = kind === 'result' ? 'callResults' : 'callEvents'
      const ref = adminDb.collection(coll).doc(String(docId))
      const snap = await ref.get()
      if (!snap.exists) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Запис не знайдено' } })
      const d = snap.data()

      // 1С-шный id звонка: у события он в sourceCallId; у «сирітського» результата пробуем
      // найти связанное событие по callId (боту 1С отдаёт свой id только через событие).
      let sourceCallId = d.sourceCallId || ''
      if (!sourceCallId && kind === 'result' && d.callId) {
        try {
          const ev = await adminDb.collection('callEvents').doc(String(d.callId)).get()
          sourceCallId = ev.exists ? ev.data().sourceCallId || '' : ''
        } catch { /* некритично */ }
      }

      const sentTo1C = await sendNoteTo1C({ sourceCallId, phone: d.phone, text: String(text).trim(), by })
      const note = { text: String(text).trim(), at: nowIso(), by: by || 'власник', sentTo1C }
      await adminDb.runTransaction(async (tx) => {
        const s = await tx.get(ref)
        const cur = s.exists ? s.data() : {}
        tx.set(ref, { notes: [...(cur.notes || []), note], updatedAt: nowIso() }, { merge: true })
      })
      res.json({ success: true, data: { note } })
    } catch (e) {
      console.error('calls/note:', e.message)
      res.status(500).json({ success: false, error: { code: 'NOTE_FAILED', message: 'Не вдалося зберегти коментар' } })
    }
  })

  // Задача/напоминание из операторского бота (создание, правка, выполнение с результатом).
  // Канбан портала показывает их отдельными колонками; повторные события merge-ятся по id.
  app.post('/api/calls/task', async (req, res) => {
    if (!guard(req, res)) return
    try {
      const b = req.body || {}
      const id = String(b.id || '')
      if (!id || !b.title) return res.status(400).json({ ok: false, error: 'id і title обовʼязкові' })
      await adminDb.collection('botTasks').doc(id).set({
        id,
        kind: b.kind || 'task',
        title: String(b.title),
        assigneeUserId: b.assigneeUserId || null,
        assigneeName: b.assigneeName || null,
        creatorName: b.creatorName || null,
        dueAt: b.dueAt || null,
        status: b.status || 'open',
        result: b.result || null,
        doneAt: b.doneAt || null,
        doneByName: b.doneByName || null,
        createdAt: b.createdAt || nowIso(),
        updatedAt: b.updatedAt || nowIso(),
        mirroredAt: nowIso(),
      }, { merge: true })
      res.json({ ok: true })
    } catch (e) {
      console.error('calls/task:', e.message)
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
