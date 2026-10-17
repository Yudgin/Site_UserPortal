// Відмітка «клієнт отримав кораблик» за зворотною ТТН Нової Пошти (рішення власника 2026-10-17: заявка завершена,
// коли клієнт отримав кораблик і минуло 2 тижні; до того — «відкрита»; записка
// runferry-briefs/telephony/resend-link-and-client-received-2026-10-18.md).
// Поля заявки (serviceRequests/{id}):
//   clientReceivedAt     — ISO-час отримання клієнтом (RecipientDateTime НП; немає — час, коли ми це побачили, і
//                          clientReceivedApprox: true);
//   clientReceivedTtn    — за якою ТТН (returnTtn на той момент); clientReceivedSource: 'np';
//   returnTracking       — {ttn, code, status, firstCheckedAt, changedAt, final?} — останній відомий статус зворотної ТТН;
//                          final: 'received' | 'refused' | 'deleted' | 'not_found' | 'stale' — далі не опитуємо.
// НЕ плутати з етапом stage 'received' — це «кораблик у нас» (onecSync inferStage). Статус заявки (status) тут не
// змінюється: він системний (рішення 2026-10-16).
// Хто ставить: POST /api/np/return-tracking/reconcile (Cloud Scheduler, x-admin-token, або адмін Firebase; ?dryRun=1 —
// лише показати). Пише в заявку лише при зміні коду НП або фіналі — без зайвих записів (застосунок слухає заявки наживо).
import { verifyFirebaseAdmin } from './adminAuth.js'

const DAY_MS = 24 * 3600 * 1000
// Коди getStatusDocuments НП: 9 «Відправлення отримано», 10 і 11 «отримано» з грошовим переказом, 106 «Одержано і
// створено ЄН зворотної доставки».
export const NP_RECEIVED = new Set(['9', '10', '11', '106'])
// 102, 103, 108 — відмова (посилка повертається до нас), 2 — видалено, 3 — номер не знайдено.
export const NP_REFUSED = new Set(['102', '103', '108'])
export const TRACK_MAX_DAYS = 45 // не отримано за 45 днів від першої перевірки — більше не опитуємо
export const NOT_FOUND_GRACE_DAYS = 3 // «не знайдено» вважаємо остаточним не раніше, ніж через 3 дні
const BATCH = 100 // getStatusDocuments приймає до 100 накладних
const RUN_BUDGET_MS = 240000

const nowIso = () => new Date().toISOString()
export const normTtn = (v) => { const d = String(v ?? '').replace(/\D/g, ''); return d && d !== '0' ? d : '' }
const msOf = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : null }

// Київський локальний час НП → UTC ISO. Формати: «21.10.2026 13:22:15» (RecipientDateTime) і «2026-10-21 13:22:15».
const kyivOffsetMin = (probe) => {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Kyiv', timeZoneName: 'longOffset' })
      .formatToParts(probe).find((p) => p.type === 'timeZoneName')
    const m = String(part?.value || '').match(/GMT([+-])(\d{2}):(\d{2})/)
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 180
  } catch { return 180 }
}
export const parseNpDate = (s) => {
  const str = String(s || '').trim()
  let y, mo, d, h = 0, mi = 0, se = 0
  let m = str.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
  if (m) [, d, mo, y, h = 0, mi = 0, se = 0] = m
  else {
    m = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
    if (!m) return null
    ;[, y, mo, d, h = 0, mi = 0, se = 0] = m
  }
  const guess = Date.UTC(+y, +mo - 1, +d, +h || 0, +mi || 0, +se || 0)
  if (!Number.isFinite(guess) || +mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null
  return new Date(guess - kyivOffsetMin(new Date(guess)) * 60000).toISOString()
}

// Чи треба опитувати НП для цієї заявки зараз.
export function needsTracking(sr) {
  if (!sr || sr.status === 'cancelled') return false
  const ttn = normTtn(sr.returnTtn)
  if (!ttn) return false
  if (sr.clientReceivedAt && sr.clientReceivedTtn === ttn) return false
  const tr = sr.returnTracking
  return !(tr && tr.ttn === ttn && tr.final)
}

// Зміни в заявці за відповіддю НП (npDoc — елемент data[] getStatusDocuments або null, якщо НП його не повернула).
// → patch або null (нічого не змінилось — не пишемо).
export function trackingPatch(sr, npDoc, nowMs = Date.now()) {
  const ttn = normTtn(sr?.returnTtn)
  if (!ttn) return null
  const prev = sr.returnTracking && sr.returnTracking.ttn === ttn ? sr.returnTracking : null
  const now = new Date(nowMs).toISOString()
  const firstCheckedAt = prev?.firstCheckedAt || now
  const ageDays = (nowMs - (msOf(firstCheckedAt) ?? nowMs)) / DAY_MS
  const code = npDoc ? String(npDoc.StatusCode ?? '').trim() : (prev?.code ?? '')
  const status = npDoc ? String(npDoc.Status || '').slice(0, 160) : (prev?.status ?? '')

  let final = null
  if (NP_RECEIVED.has(code)) final = 'received'
  else if (NP_REFUSED.has(code)) final = 'refused'
  else if (code === '2') final = 'deleted'
  else if (code === '3' && ageDays >= NOT_FOUND_GRACE_DAYS) final = 'not_found'
  else if (ageDays >= TRACK_MAX_DAYS) final = 'stale'

  const changed = !prev || prev.code !== code || !!final
  if (!changed) return null
  const tracking = { ttn, code, status, firstCheckedAt, changedAt: prev && prev.code === code ? (prev.changedAt || now) : now, ...(final ? { final } : {}) }
  const patch = { returnTracking: tracking }
  if (final === 'received') {
    const at = parseNpDate(npDoc?.RecipientDateTime)
    const atMs = msOf(at)
    // Час із майбутнього (розбіжність годинників) — беремо «зараз».
    const ok = atMs != null && atMs <= nowMs + 5 * 60000
    patch.clientReceivedAt = ok ? at : now
    patch.clientReceivedApprox = !ok
    patch.clientReceivedTtn = ttn
    patch.clientReceivedSource = 'np'
  }
  return patch
}

// Телефон для getStatusDocuments (з ним НП віддає повні дані, зокрема дату отримання): 380XXXXXXXXX або нічого.
const npPhone = (raw) => {
  let d = String(raw || '').replace(/\D/g, '')
  if (d.length === 10 && d.startsWith('0')) d = '38' + d
  if (d.length === 9) d = '380' + d
  return /^380\d{9}$/.test(d) ? d : ''
}

export function registerReturnTracking(app, deps) {
  const {
    adminDb,
    np, // async (model, method, props) → відповідь НП ({success, data: [...]})
    adminToken = process.env.PAYMENTS_ADMIN_TOKEN || '',
    verifyAdmin = verifyFirebaseAdmin,
    now = () => Date.now(),
  } = deps

  const allowed = async (req) => {
    if (adminToken && req.get('x-admin-token') === adminToken) return true
    return verifyAdmin(req)
  }

  async function reconcile({ dryRun = false } = {}) {
    const started = now()
    // Усі заявки зі зворотною ТТН (рядок > '' — порожні й відсутні поля не потрапляють); фільтр — у пам'яті.
    const snap = await adminDb.collection('serviceRequests').where('returnTtn', '>', '')
      .select('returnTtn', 'status', 'clientPhone', 'clientReceivedAt', 'clientReceivedTtn', 'returnTracking').get()
    const todo = snap.docs.map((d) => ({ id: d.id, ref: d.ref, sr: d.data() })).filter((x) => needsTracking(x.sr))
    const stats = { withReturnTtn: snap.size, tracked: todo.length, checked: 0, received: 0, final: 0, written: 0, unchanged: 0, deferred: 0, errors: [] }
    const changes = []
    for (let i = 0; i < todo.length; i += BATCH) {
      if (now() - started > RUN_BUDGET_MS) { stats.deferred = todo.length - i; break }
      const batch = todo.slice(i, i + BATCH)
      let byTtn = new Map()
      try {
        const r = await np('TrackingDocument', 'getStatusDocuments', {
          Documents: batch.map(({ sr }) => {
            const phone = npPhone(sr.clientPhone)
            return { DocumentNumber: normTtn(sr.returnTtn), ...(phone ? { Phone: phone } : {}) }
          }),
        })
        if (!r || r.success === false) throw new Error(`NP: ${(r?.errors || []).join('; ').slice(0, 160) || 'success=false'}`)
        byTtn = new Map((r.data || []).filter((d) => d && d.Number).map((d) => [normTtn(d.Number), d]))
      } catch (e) {
        stats.errors.push(String(e?.message || e).slice(0, 200))
        continue
      }
      for (const { id, ref, sr } of batch) {
        const ttn = normTtn(sr.returnTtn)
        const doc = byTtn.get(ttn) || null
        if (doc) stats.checked++
        const patch = trackingPatch(sr, doc, now())
        if (!patch) { stats.unchanged++; continue }
        if (patch.returnTracking.final) stats.final++
        if (patch.clientReceivedAt) stats.received++
        changes.push({ id, code: patch.returnTracking.code, final: patch.returnTracking.final || null, clientReceivedAt: patch.clientReceivedAt || null, approx: patch.clientReceivedApprox ?? null })
        if (dryRun) continue
        try {
          await ref.update(patch)
          stats.written++
        } catch (e) {
          stats.errors.push(`${id}: ${String(e?.message || e).slice(0, 160)}`)
        }
      }
    }
    if (stats.errors.length > 20) stats.errors = stats.errors.slice(0, 20)
    return { ...stats, dryRun, changes: changes.slice(0, 200) }
  }

  // POST /api/np/return-tracking/reconcile[?dryRun=1] → {withReturnTtn, tracked, checked, received, final, written, …}
  app.post('/api/np/return-tracking/reconcile', async (req, res) => {
    if (!adminDb) return res.status(503).json({ success: false, error: 'no adminDb' })
    if (!(await allowed(req))) return res.status(403).json({ success: false })
    const dryRun = req.query.dryRun === '1' || req.body?.dryRun === true
    // Замок від паралельних прогонів (Scheduler + ручний виклик), протухає за 10 хв; пробний прогін без замка.
    const lockRef = adminDb.collection('system').doc('returnTracking')
    if (!dryRun) {
      const claimed = await adminDb.runTransaction(async (tx) => {
        const s = await tx.get(lockRef)
        const since = s.exists ? s.data().runningSince : null
        if (since && now() - Date.parse(since) < 10 * 60 * 1000) return false
        tx.set(lockRef, { runningSince: nowIso() }, { merge: true })
        return true
      }).catch(() => false)
      if (!claimed) return res.status(409).json({ success: false, error: 'reconcile already running' })
    }
    try {
      const out = await reconcile({ dryRun })
      console.log(`return-tracking: tracked=${out.tracked} checked=${out.checked} received=${out.received} final=${out.final} written=${out.written} errors=${out.errors.length}${dryRun ? ' (dry run)' : ''}`)
      if (!dryRun) {
        const { changes, ...brief } = out
        await lockRef.set({ runningSince: null, lastRunAt: nowIso(), lastStats: { ...brief, errors: out.errors.length } }, { merge: true }).catch(() => {})
      }
      res.json({ success: true, ...out })
    } catch (e) {
      if (!dryRun) await lockRef.set({ runningSince: null }, { merge: true }).catch(() => {})
      console.error('return-tracking:', e?.message || e)
      res.status(502).json({ success: false, error: String(e?.message || e).slice(0, 200) })
    }
  })

  return { reconcile }
}

export default registerReturnTracking
