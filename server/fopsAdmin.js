// Админ-управление ФОПами (владелец). Не-секретная мета → fops/{id}; СЕКРЕТЫ → fopSecrets/{id}
// (правила запрещают клиентский доступ; пишет/читает только backend). Секреты — WRITE-ONLY:
// GET возвращает лишь флаги «задано/не задано», значения ключей наружу НЕ отдаются. PUT
// перезаписывает только НЕПУСТЫЕ переданные ключи (пустые оставляют прежние).
import { verifyFirebaseAdmin } from './adminAuth.js'
import { getFop } from './fops.js'
import { sellReceipt } from './checkbox.js'

const nowIso = () => new Date().toISOString()
const clip = (v, n = 200) => (v == null ? '' : String(v).slice(0, n))

// Оставить только непустые строковые ключи по группам секретов (write-only).
const SECRET_GROUPS = ['liqpay', 'monoChast', 'monoAcquire', 'privatPaypart', 'checkbox', 'novaPoshta']
const pickSecrets = (secrets = {}) => {
  const out = {}
  for (const g of SECRET_GROUPS) {
    const src = secrets[g]
    if (src && typeof src === 'object') {
      const patch = {}
      for (const [k, v] of Object.entries(src)) {
        if (typeof v === 'string' && v.trim()) patch[k] = v.trim().slice(0, 4000)
      }
      if (Object.keys(patch).length) out[g] = patch
    }
  }
  return out
}

export function registerFopsAdmin(app, deps) {
  const { adminDb, refreshFops } = deps
  const gate = async (req, res) => {
    if (await verifyFirebaseAdmin(req)) return true
    res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Доступ лише для власника' } })
    return false
  }

  // Список ФОП для админки: мета + ФЛАГИ наличия секретов (без значений).
  app.get('/api/fops/admin', async (req, res) => {
    if (!(await gate(req, res))) return
    if (!adminDb) return res.status(503).json({ success: false })
    try {
      const [metaSnap, secSnap] = await Promise.all([
        adminDb.collection('fops').get(),
        adminDb.collection('fopSecrets').get(),
      ])
      const secrets = {}
      secSnap.forEach((d) => { secrets[d.id] = d.data() || {} })
      const items = metaSnap.docs.map((d) => {
        const m = d.data() || {}
        const s = secrets[d.id] || {}
        return {
          id: d.id,
          name: m.name || d.id,
          active: m.active !== false,
          methods: m.methods || {},
          novaPoshta: m.novaPoshta || {}, // refs (не-секрет)
          secretsSet: {
            liqpay: !!(s.liqpay && s.liqpay.privateKey),
            monoChast: !!(s.monoChast && s.monoChast.storeSecret),
            monoAcquire: !!(s.monoAcquire && s.monoAcquire.token),
            privatPaypart: !!(s.privatPaypart && s.privatPaypart.storeId),
            checkbox: !!(s.checkbox && s.checkbox.licenseKey),
            novaPoshtaApiKey: !!(s.novaPoshta && s.novaPoshta.apiKey),
          },
        }
      }).sort((a, b) => a.name.localeCompare(b.name))
      res.json({ success: true, data: items })
    } catch (e) {
      console.error('fops admin list:', e.message)
      res.status(500).json({ success: false })
    }
  })

  // Создать/обновить ФОП. body: { name, active, methods, novaPoshta(refs), secrets:{...} }
  app.put('/api/fops/admin/:id', async (req, res) => {
    if (!(await gate(req, res))) return
    if (!adminDb) return res.status(503).json({ success: false })
    const id = clip(req.params.id, 64).replace(/[^\w-]/g, '')
    if (!id) return res.status(400).json({ success: false, error: { code: 'BAD_ID', message: 'Некоректний id' } })
    try {
      const b = req.body || {}
      const meta = {
        name: clip(b.name, 200) || id,
        active: b.active !== false,
        methods: {
          liqpayCard: !!b.methods?.liqpayCard,
          liqpayPaypart: !!b.methods?.liqpayPaypart,
          monoChast: !!b.methods?.monoChast,
          monoAcquire: !!b.methods?.monoAcquire,
          privatPaypart: !!b.methods?.privatPaypart,
          cod: !!b.methods?.cod, // накладений платіж (Нова Пошта)
        },
        novaPoshta: {
          senderRef: clip(b.novaPoshta?.senderRef, 64),
          senderName: clip(b.novaPoshta?.senderName, 200),
          contactRef: clip(b.novaPoshta?.contactRef, 64),
          contactName: clip(b.novaPoshta?.contactName, 200),
          senderPhone: clip(b.novaPoshta?.senderPhone, 32),
          cityRef: clip(b.novaPoshta?.cityRef, 64),
          cityName: clip(b.novaPoshta?.cityName, 120),
          settlementRef: clip(b.novaPoshta?.settlementRef, 64),
          warehouseRef: clip(b.novaPoshta?.warehouseRef, 64),
          warehouseName: clip(b.novaPoshta?.warehouseName, 200),
        },
        updatedAt: nowIso(),
      }
      await adminDb.collection('fops').doc(id).set(meta, { merge: true })

      // Секреты: пишем только непустые переданные ключи (write-only, deep-merge).
      const secretPatch = pickSecrets(b.secrets)
      if (Object.keys(secretPatch).length) {
        await adminDb.collection('fopSecrets').doc(id).set(secretPatch, { merge: true })
      }

      if (typeof refreshFops === 'function') await refreshFops(adminDb)
      res.json({ success: true, data: { id } })
    } catch (e) {
      console.error('fops admin put:', e.message)
      res.status(500).json({ success: false })
    }
  })

  // Удалить конкретный секретный ключ группы (сброс). body: { group }
  app.post('/api/fops/admin/:id/clear-secret', async (req, res) => {
    if (!(await gate(req, res))) return
    if (!adminDb) return res.status(503).json({ success: false })
    const id = clip(req.params.id, 64).replace(/[^\w-]/g, '')
    const group = clip(req.body?.group, 32)
    if (!id || !SECRET_GROUPS.includes(group)) return res.status(400).json({ success: false })
    try {
      await adminDb.collection('fopSecrets').doc(id).set({ [group]: null }, { merge: true })
      if (typeof refreshFops === 'function') await refreshFops(adminDb)
      res.json({ success: true })
    } catch (e) {
      console.error('fops clear-secret:', e.message)
      res.status(500).json({ success: false })
    }
  })

  // Удалить ФОП (мета + секреты).
  app.delete('/api/fops/admin/:id', async (req, res) => {
    if (!(await gate(req, res))) return
    if (!adminDb) return res.status(503).json({ success: false })
    const id = clip(req.params.id, 64).replace(/[^\w-]/g, '')
    if (!id) return res.status(400).json({ success: false, error: { code: 'BAD_ID', message: 'Некоректний id' } })
    try {
      await Promise.all([
        adminDb.collection('fops').doc(id).delete(),
        adminDb.collection('fopSecrets').doc(id).delete(),
      ])
      if (typeof refreshFops === 'function') await refreshFops(adminDb)
      res.json({ success: true })
    } catch (e) {
      console.error('fops admin delete:', e.message)
      res.status(500).json({ success: false })
    }
  })

  // Тестовый фискальный чек: РЕАЛЬНЫЙ чек продажи на 10 грн кредами ЭТОГО ФОП (Checkbox), чтобы
  // проверить, что данные кассы внесены верно. Открывает реальную смену. Ошибку Checkbox отдаём
  // текстом — по ней видно причину (неверный licenseKey/PIN, каса не активна и т.п.).
  app.post('/api/fops/admin/:id/test-receipt', async (req, res) => {
    if (!(await gate(req, res))) return
    const id = clip(req.params.id, 64).replace(/[^\w-]/g, '')
    const fop = getFop(id)
    if (!fop) return res.status(404).json({ success: false, error: { code: 'NO_FOP', message: 'ФОП не знайдено' } })
    if (!fop.checkbox || !fop.checkbox.licenseKey) {
      return res.status(400).json({ success: false, error: { code: 'NO_CHECKBOX', message: 'У ФОП не заданий Checkbox (ключ каси/PIN). Спочатку збережіть дані каси.' } })
    }
    try {
      const r = await sellReceipt(fop, { goods: [{ name: 'Ремонт (тестовий чек)', price: 10, qty: 1, code: 'TEST-REPAIR' }], paymentLabel: 'Оплата (тест)' })
      return res.json({ success: true, data: r })
    } catch (e) {
      const detail = (e.response && e.response.data)
        ? (typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data))
        : (e.message || 'невідома помилка')
      console.error(`fops test-receipt ${id}:`, detail)
      return res.status(502).json({ success: false, error: { code: 'CHECKBOX_ERROR', message: `Checkbox: ${detail}` } })
    }
  })
}

export default registerFopsAdmin
