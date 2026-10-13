// Профили сотрудников: саморегистрация identity при входе. Пишет BACKEND (Admin SDK), поэтому
// клиент НЕ может выдать себе роль (в firestore.rules запись users — только владелец).
// На первом входе создаётся заготовка { role:'master', active:false, centers:[] } — доступа НЕТ,
// пока владелец не назначит роль/центры. На последующих — обновляем лишь email/имя/lastLogin.
import { verifyFirebaseUser, ADMIN_EMAIL } from './adminAuth.js'
import { rateLimit } from './rateLimit.js'

const nowIso = () => new Date().toISOString()

// Ендпоінт приймає БУДЬ-ЯКОГО автентифікованого користувача (і клієнтів) і пише users/{uid} —
// ліміт на uid, щоб він не був підсилювачем записів Firestore (мобільний клієнт кличе при вході).
const registerLimiter = rateLimit({ name: 'me-register', windowMs: 60 * 1000, max: 6, keyFn: (req) => req.uid })

export function registerUserProfiles(app, deps) {
  const { adminDb } = deps

  app.post('/api/me/register', async (req, res) => {
    if (!adminDb) return res.status(503).json({ success: false })
    const dec = await verifyFirebaseUser(req)
    if (!dec) return res.status(401).json({ success: false, error: { code: 'UNAUTH', message: 'Потрібна авторизація' } })
    req.uid = dec.uid
    let passed = false
    registerLimiter(req, res, () => { passed = true })
    if (!passed) return // 429 уже надіслано
    try {
      const ref = adminDb.collection('users').doc(dec.uid)
      await adminDb.runTransaction(async (tx) => {
        const snap = await tx.get(ref)
        // displayName — лише коли токен його несе: у Apple/email-акаунтів імені в токені немає, і
        // порожній рядок затирав би імʼя, яке власник бачить у списку співробітників.
        const identity = {
          uid: dec.uid,
          email: dec.email || '',
          ...(dec.name ? { displayName: dec.name } : {}),
          lastLogin: nowIso(),
          updatedAt: nowIso(),
        }
        // Владелец по email (с подтверждённой почтой) всегда должен иметь role='owner'/active.
        const isOwner = dec.email === ADMIN_EMAIL && dec.email_verified === true
        if (!snap.exists) {
          // Первый вход: владелец — сразу owner; остальные — заготовка без доступа.
          tx.set(ref, {
            ...identity,
            displayName: dec.name || '',
            role: isOwner ? 'owner' : 'master',
            active: isOwner,
            centers: [],
            createdAt: nowIso(),
            createdBy: 'self',
          }, { merge: true })
        } else {
          // Повторный вход: обновляем identity; для владельца по email — само-исцеление до owner/active
          // (на случай, если первый вход был без верификации почты). Роль остальных не трогаем.
          tx.set(ref, { ...identity, ...(isOwner ? { role: 'owner', active: true } : {}) }, { merge: true })
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
