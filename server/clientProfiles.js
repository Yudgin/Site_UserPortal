// Публичный upsert профиля клиента по телефону — через BACKEND (Admin SDK), чтобы аноним не мог
// ПЕРЕЗАПИСАТЬ чужой PII по угадываемому ключу (нормализованный телефон). Правила Firestore на
// clientProfiles закрыты на запись; пишет только этот эндпоинт с безопасным слиянием:
// имя/email заполняются ТОЛЬКО если пусты; массивы — arrayUnion (только добавление).
import { FieldValue } from 'firebase-admin/firestore'
import { rateLimit } from './rateLimit.js'

const nowIso = () => new Date().toISOString()
const clip = (v, n) => (v ? String(v).slice(0, n).trim() : '')
const isEmpty = (v) => v === undefined || v === null || v === ''

// 15 upsert-ов/час на IP (анти-спам; id детерминированный по телефону).
const cpLimiter = rateLimit({ name: 'client-profiles', windowMs: 60 * 60 * 1000, max: 15 })

export function registerClientProfiles(app, deps) {
  const { adminDb } = deps

  app.post('/api/client-profiles/upsert', cpLimiter, async (req, res) => {
    if (!adminDb) return res.status(503).json({ success: false })
    try {
      const b = req.body || {}
      // id — нормализованный телефон (нормализацию делает клиент, единый источник формата).
      const id = String(b.id || '').replace(/\D/g, '')
      if (!/^\d{9,15}$/.test(id)) return res.status(400).json({ success: false, error: { code: 'BAD_ID', message: 'Некоректний телефон' } })
      const ref = adminDb.collection('clientProfiles').doc(id)

      await adminDb.runTransaction(async (tx) => {
        const s = await tx.get(ref)
        const cur = s.exists ? s.data() : null
        const patch = { id, phone: id, updatedAt: nowIso() }
        // Имя/email — только если ещё пусто (не затираем PII реального владельца телефона).
        const name = clip(b.name, 120)
        const email = clip(b.email, 160)
        if (name && (!s.exists || isEmpty(cur.name))) patch.name = name
        if (email && (!s.exists || isEmpty(cur.email))) patch.email = email
        // Массивы связей — только ДОБАВЛЯЕМ (arrayUnion), не перезаписываем.
        const uid = clip(b.authUid, 128)
        const boatId = clip(b.boatId, 128)
        const sessionId = clip(b.sessionId, 128)
        const taskId = clip(b.taskId, 128)
        if (uid) patch.authUids = FieldValue.arrayUnion(uid)
        if (boatId) patch.boatIds = FieldValue.arrayUnion(boatId)
        if (sessionId) patch.sessionIds = FieldValue.arrayUnion(sessionId)
        if (taskId) patch.taskIds = FieldValue.arrayUnion(taskId)
        tx.set(ref, patch, { merge: true })
      })
      return res.json({ success: true, data: { id } })
    } catch (e) {
      console.error('client-profiles upsert:', e.message)
      res.status(500).json({ success: false })
    }
  })
}

export default registerClientProfiles
