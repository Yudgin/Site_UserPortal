// Дзвінок через віртуальну мобільну АТС Київстар (Generic FMC API, /v1/originate):
// АТС спочатку дзвонить СПІВРОБІТНИКУ (originator — його номер у АТС з пакетом API),
// після відповіді набирає клієнта. Розмова йде через АТС: запис, історія, стани дзвінка
// приходять на наш вебхук /api/kyivstar/callstate (server/calls.js).
// Авторизація до Київстар: Authorization: Bearer <FMC token> + ?integrator_id=… — обидва
// значення лише в env (KYIVSTAR_FMC_TOKEN, KYIVSTAR_FMC_INTEGRATOR_ID), у код не потрапляють.
// Хто може: власник/директор/майстер; номер клієнта — ТІЛЬКИ із заявки (як у /api/notify),
// не-власник — лише заявка свого центру; номер співробітника — з users/{uid}.fmcPhone.
import axios from 'axios'
import { verifyFirebaseStaff } from './adminAuth.js'
import { normPhone } from './phone.js'
import { rateLimit } from './rateLimit.js'

const FMC_BASE = (process.env.KYIVSTAR_FMC_BASE_URL || 'https://fmc.kyivstar.ua/api/fmc').replace(/\/+$/, '')

export function registerFmcCalls(app, deps) {
  const { adminDb } = deps
  const token = process.env.KYIVSTAR_FMC_TOKEN || ''
  const integratorId = process.env.KYIVSTAR_FMC_INTEGRATOR_ID || ''

  const staffOnly = async (req, res, next) => {
    const staff = await verifyFirebaseStaff(req, ['owner', 'director', 'master'])
    if (!staff) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Доступ лише для власника, директора або майстра' } })
    req.staff = staff
    next()
  }
  // Один дзвінок = один виклик АТС; захист від подвійного тапу і зациклення — 6/хв на співробітника.
  const limiter = rateLimit({ name: 'fmc-originate', windowMs: 60 * 1000, max: 6, keyFn: (req) => req.staff.uid, message: 'Забагато дзвінків поспіль — зачекайте хвилину' })

  // POST /api/calls/originate { serviceRequestId } → { callControlId, originator, destination }
  app.post('/api/calls/originate', staffOnly, limiter, async (req, res) => {
    if (!adminDb) return res.status(503).json({ success: false })
    if (!token || !integratorId) {
      return res.status(503).json({ success: false, error: { code: 'FMC_NOT_CONFIGURED', message: 'Дзвінки через АТС не налаштовані (ключі Київстар FMC)' } })
    }
    const staff = req.staff
    try {
      const srId = String(req.body?.serviceRequestId || '')
      if (!srId) return res.status(400).json({ success: false, error: { code: 'NEED_REQUEST', message: 'Потрібна заявка' } })
      const [srSnap, userSnap] = await Promise.all([
        adminDb.collection('serviceRequests').doc(srId).get(),
        adminDb.collection('users').doc(staff.uid).get(),
      ])
      const sr = srSnap.exists ? srSnap.data() : null
      if (!sr) return res.status(404).json({ success: false, error: { code: 'NO_SR', message: 'Заявку не знайдено' } })
      if (staff.role !== 'owner') {
        const own = !!sr.serviceCenterId && staff.centers.some((c) => c && c.centerId === sr.serviceCenterId)
        if (!own) return res.status(403).json({ success: false, error: { code: 'OTHER_CENTER', message: 'Заявка іншого сервісного центру' } })
      }
      const destination = normPhone(sr.clientPhone)
      if (!destination) return res.status(400).json({ success: false, error: { code: 'NO_CLIENT_PHONE', message: 'У заявці немає телефону клієнта' } })
      const originator = normPhone(userSnap.exists ? userSnap.data().fmcPhone : '')
      if (!originator) {
        return res.status(400).json({ success: false, error: { code: 'NO_FMC_PHONE', message: 'Вкажіть у профілі свій номер у АТС Київстар' } })
      }

      let r
      try {
        r = await axios.post(`${FMC_BASE}/v1/originate`, { originator, destination }, {
          params: { integrator_id: integratorId },
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          timeout: 15000,
          validateStatus: () => true,
        })
      } catch (e) {
        return res.status(502).json({ success: false, error: { code: 'FMC_UNREACHABLE', message: 'АТС Київстар не відповідає' } })
      }
      if (r.status !== 200) {
        const map = {
          400: 'АТС відхилила номер (перевірте номер у профілі: він має бути підключений до АТС з пакетом API)',
          401: 'Невірний токен Київстар FMC',
          403: 'АТС не дозволяє дзвінок з цього номера',
          429: 'АТС: забагато запитів, зачекайте хвилину',
          503: 'АТС не змогла ініціювати дзвінок',
        }
        const detail = typeof r.data === 'string' ? r.data.slice(0, 200) : (r.data && (r.data.message || r.data.error)) || ''
        console.warn('fmc originate:', r.status, detail)
        return res.status(502).json({ success: false, error: { code: `FMC_${r.status}`, message: map[r.status] || `АТС: помилка ${r.status}` } })
      }
      const callControlId = r.data && r.data.call_control_id ? String(r.data.call_control_id) : null
      // Слід у журналі дзвінків: стани alerting/established/finished прийдуть вебхуком окремо.
      adminDb.collection('callEvents').add({
        source: 'fmc-originate', kind: 'originate', at: new Date().toISOString(),
        byUid: staff.uid, byRole: staff.role, serviceRequestId: srId,
        originator, destination, callControlId,
      }).catch(() => {})
      return res.json({ success: true, data: { callControlId, originator, destination } })
    } catch (e) {
      console.error('calls/originate:', e.message)
      res.status(500).json({ success: false, error: { code: 'ORIGINATE_FAILED', message: 'Не вдалося ініціювати дзвінок' } })
    }
  })
}

export default registerFmcCalls
