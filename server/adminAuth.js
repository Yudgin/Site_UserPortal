// Проверка, что запрос сделан администратором: Firebase ID-токен в заголовке
// Authorization: Bearer <token>, чей email совпадает с админским и подтверждён.
import { getAuth } from 'firebase-admin/auth'

const ADMIN_EMAIL = 'admin@runferry.de'

export const verifyFirebaseAdmin = async (req) => {
  const m = (req.get('authorization') || '').match(/^Bearer (.+)$/)
  if (!m) return false
  try {
    const dec = await getAuth().verifyIdToken(m[1])
    return dec.email === ADMIN_EMAIL && dec.email_verified === true
  } catch {
    return false
  }
}

export default verifyFirebaseAdmin
