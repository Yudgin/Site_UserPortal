// Проверка, что запрос сделан администратором: Firebase ID-токен в заголовке
// Authorization: Bearer <token>, чей email совпадает с админским и подтверждён.
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'

const ADMIN_EMAIL = 'admin@runferry.de'

export const verifyFirebaseAdmin = async (req) => {
  const m = (req.get('authorization') || '').match(/^Bearer (.+)$/)
  if (!m) return false
  try {
    // checkRevoked=true — отозванный/после разлогина/смены пароля токен не проходит.
    const dec = await getAuth().verifyIdToken(m[1], true)
    return dec.email === ADMIN_EMAIL && dec.email_verified === true
  } catch {
    return false
  }
}

// Проверить, что запрос сделан ЛЮБЫМ аутентифицированным пользователем. Возвращает
// декодированный токен { uid, email, ... } или null (для саморегистрации/резолва роли).
export const verifyFirebaseUser = async (req) => {
  const m = (req.get('authorization') || '').match(/^Bearer (.+)$/)
  if (!m) return null
  try {
    return await getAuth().verifyIdToken(m[1], true)
  } catch {
    return null
  }
}

// RBAC (фаза 1b): запрос сделан АКТИВНЫМ сотрудником — роль читаем из users/{uid}
// (документ пишет только владелец/бэкенд, правила запрещают self-escalation). Владелец по
// email — всегда. roles сужает допустимые роли (напр. ['owner','accountant'] для чеков).
// Возвращает { uid, email, role, centers } или null.
const STAFF_ROLES = ['owner', 'director', 'accountant', 'master']
export const verifyFirebaseStaff = async (req, roles = STAFF_ROLES) => {
  const dec = await verifyFirebaseUser(req)
  if (!dec) return null
  if (dec.email === ADMIN_EMAIL && dec.email_verified === true) return { uid: dec.uid, email: dec.email, role: 'owner', centers: [] }
  try {
    const s = await getFirestore().collection('users').doc(dec.uid).get()
    const p = s.exists ? s.data() : null
    if (!p || p.active !== true || !roles.includes(p.role)) return null
    return { uid: dec.uid, email: dec.email || '', role: p.role, centers: Array.isArray(p.centers) ? p.centers : [] }
  } catch {
    return null
  }
}

export { ADMIN_EMAIL }
export default verifyFirebaseAdmin
