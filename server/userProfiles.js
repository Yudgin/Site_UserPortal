// Профили сотрудников: саморегистрация identity при входе. Пишет BACKEND (Admin SDK), поэтому
// клиент НЕ может выдать себе роль (в firestore.rules запись users — только владелец).
// На первом входе создаётся заготовка { role:'master', active:false, centers:[] } — доступа НЕТ,
// пока владелец не назначит роль/центры. На последующих — обновляем лишь email/имя/lastLogin.
import { verifyFirebaseUser, ADMIN_EMAIL } from './adminAuth.js'

const nowIso = () => new Date().toISOString()

export function registerUserProfiles(app, deps) {
  const { adminDb } = deps

  app.post('/api/me/register', async (req, res) => {
    if (!adminDb) return res.status(503).json({ success: false })
    const dec = await verifyFirebaseUser(req)
    if (!dec) return res.status(401).json({ success: false, error: { code: 'UNAUTH', message: 'Потрібна авторизація' } })
    try {
      const ref = adminDb.collection('users').doc(dec.uid)
      await adminDb.runTransaction(async (tx) => {
        const snap = await tx.get(ref)
        const identity = {
          uid: dec.uid,
          email: dec.email || '',
          displayName: dec.name || '',
          lastLogin: nowIso(),
          updatedAt: nowIso(),
        }
        if (!snap.exists) {
          // Владелец по email — сразу owner; остальные — заготовка без доступа.
          const isOwner = dec.email === ADMIN_EMAIL && dec.email_verified === true
          tx.set(ref, {
            ...identity,
            role: isOwner ? 'owner' : 'master',
            active: isOwner,
            centers: [],
            createdAt: nowIso(),
            createdBy: 'self',
          }, { merge: true })
        } else {
          // Обновляем ТОЛЬКО identity — роль/центры/активность не трогаем.
          tx.set(ref, identity, { merge: true })
        }
      })
      return res.json({ success: true })
    } catch (e) {
      console.error('me/register:', e.message)
      res.status(500).json({ success: false })
    }
  })
}

export default registerUserProfiles
