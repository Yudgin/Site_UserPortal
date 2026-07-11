// Проверка, что запрос сделан администратором: Firebase ID-токен в заголовке
// Authorization: Bearer <token>, чей email совпадает с админским и подтверждён.
import { getAuth } from 'firebase-admin/auth'

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

export { ADMIN_EMAIL }
export default verifyFirebaseAdmin
