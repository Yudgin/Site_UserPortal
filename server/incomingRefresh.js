// Статус вхідної посилки (клієнт → ми) для заявок, де кораблик ще не в нас. Правило власника 2026-10-18: без ТТН
// клієнт привозить кораблик сам і це відмічають вручну (етап «Отримано»); з ТТН заявка відкрита, поки посилка жива,
// «Номер не знайдено» — клієнт так і не відправив, заявка закрита (isOpen у binotelWebhook.js). Для заявок з 1С
// статус дає синхронізація (onecSync, source '1c'), для порталу — це опитування Нової Пошти (source 'np').
//
//   POST /api/service-requests/refresh-incoming   (x-admin-token = PAYMENTS_ADMIN_TOKEN, як calls-reconcile)
//     Cloud Scheduler раз на добу. Бере заявки зі статусом не done/cancelled, без етапу, з вхідною ТТН і без
//     зворотної; питає НП пакетами по 100 (TrackingDocument.getStatusDocuments); пише incomingDelivery
//     {ttn, status, statusCode, statusAt, arrivedAt, notFound, source: 'np', checkedAt}.
const nowIso = () => new Date().toISOString()
const OPEN_STATUSES = ['new', 'diagnostics', 'offered', 'approved', 'in_work']
// Коди статусів НП: 9/10/11/106 — отримано; 3 — «Номер не знайдено»; 2 — видалено відправником.
export const NP_DELIVERED = new Set(['9', '10', '11', '106'])
export const NP_GONE = new Set(['2', '3'])
const digits = (v) => { const d = String(v ?? '').replace(/\D/g, ''); return d && d !== '0' ? d : '' }

// «21.05.2024 13:53:47» (київський час НП) → ISO UTC; інакше null.
const kyivOffsetMin = (probe) => {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Kyiv', timeZoneName: 'longOffset' }).formatToParts(probe).find((p) => p.type === 'timeZoneName')
    const m = String(part?.value || '').match(/GMT([+-])(\d{2}):(\d{2})/)
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 180
  } catch { return 180 }
}
export const npDateToIso = (s) => {
  const m = String(s || '').match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/) || String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/)
  if (!m) return null
  const [y, mo, d] = m[1].length === 4 ? [m[1], m[2], m[3]] : [m[3], m[2], m[1]]
  const guess = Date.UTC(+y, +mo - 1, +d, +m[4], +m[5], +(m[6] || 0))
  if (Number.isNaN(guess)) return null
  const off2 = kyivOffsetMin(new Date(guess - kyivOffsetMin(new Date(guess)) * 60000))
  return new Date(guess - off2 * 60000).toISOString()
}

// Запис НП → incomingDelivery (з урахуванням уже відомого: дату отримання не губимо).
export function incomingFromNp(doc, prev, now = nowIso()) {
  const code = String(doc?.StatusCode ?? '')
  const status = String(doc?.Status || '').slice(0, 120)
  const deliveredNow = NP_DELIVERED.has(code) || (/отримано|вручен/i.test(status) && !/відправник|відмов|поверн/i.test(status))
  const arrivedAt = prev?.arrivedAt || (deliveredNow ? npDateToIso(doc?.RecipientDateTime) || npDateToIso(doc?.ActualDeliveryDate) || now : null)
  return {
    ttn: digits(doc?.Number) || prev?.ttn || null,
    status: status || null,
    statusCode: code || null,
    statusAt: now,
    arrivedAt,
    notFound: !arrivedAt && (NP_GONE.has(code) || /не знайдено|видален/i.test(status)),
    source: 'np',
    checkedAt: now,
  }
}

// Чи чекаємо ще кораблик від клієнта за цією заявкою (поза isOpen — щоб вибрати, кого опитувати).
export const awaitingBoat = (sr) => !!sr && !['done', 'cancelled'].includes(sr.status)
  && !sr.stage && !(Array.isArray(sr.stageHistory) && sr.stageHistory.length) && !digits(sr.returnTtn) && !sr.returnDelivery

export function registerIncomingRefresh(app, deps) {
  const { adminDb, npRequest } = deps
  const ADMIN_TOKEN = process.env.PAYMENTS_ADMIN_TOKEN || ''
  app.post('/api/service-requests/refresh-incoming', async (req, res) => {
    if (!ADMIN_TOKEN || req.get('x-admin-token') !== ADMIN_TOKEN) return res.status(403).json({ success: false })
    if (!adminDb || !npRequest) return res.status(503).json({ success: false })
    try {
      const snap = await adminDb.collection('serviceRequests').where('status', 'in', OPEN_STATUSES).get()
      const todo = snap.docs.map((d) => ({ ref: d.ref, sr: d.data() })).filter(({ sr }) => awaitingBoat(sr) && digits(sr.waybillNumber))
      let updated = 0, arrived = 0, gone = 0
      for (let i = 0; i < todo.length; i += 100) {
        const batch = todo.slice(i, i + 100)
        const data = await npRequest('TrackingDocument', 'getStatusDocuments', { Documents: batch.map(({ sr }) => ({ DocumentNumber: digits(sr.waybillNumber) })) })
        const byNumber = new Map(((data && data.data) || []).filter(Boolean).map((d) => [digits(d.Number), d]))
        const now = nowIso()
        for (const { ref, sr } of batch) {
          const doc = byNumber.get(digits(sr.waybillNumber))
          if (!doc) continue
          const prev = sr.incomingDelivery && digits(sr.incomingDelivery.ttn) === digits(sr.waybillNumber) ? sr.incomingDelivery : null
          const inc = incomingFromNp(doc, prev, now)
          await ref.update({ incomingDelivery: inc })
          updated++
          if (inc.arrivedAt) arrived++
          if (inc.notFound) gone++
        }
      }
      res.json({ success: true, data: { checked: todo.length, updated, arrived, gone } })
    } catch (e) {
      console.error('refresh-incoming:', e.message)
      res.status(500).json({ success: false })
    }
  })
}

export default registerIncomingRefresh
