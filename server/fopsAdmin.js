// Админ-управление ФОПами (владелец). Не-секретная мета → fops/{id}; СЕКРЕТЫ → fopSecrets/{id}
// (правила запрещают клиентский доступ; пишет/читает только backend). Секреты — WRITE-ONLY:
// GET возвращает лишь флаги «задано/не задано», значения ключей наружу НЕ отдаются. PUT
// перезаписывает только НЕПУСТЫЕ переданные ключи (пустые оставляют прежние).
import { verifyFirebaseAdmin } from './adminAuth.js'
import { getFop, loadFopFresh } from './fops.js'
import { signin, sellReceipt, returnReceipt, getReceipt } from './checkbox.js'
import { checkFopKeys } from './fopKeyCheck.js'
import { runDailyKeyCheck, saveKeyCheck, forgetKeyCheck, loadKeyChecks, ownerTelegram, RUNS } from './fopKeyCheckDaily.js'

const nowIso = () => new Date().toISOString()
const clip = (v, n = 200) => (v == null ? '' : String(v).slice(0, n))

// Оставить только непустые строковые ключи по группам секретов (write-only).
const SECRET_GROUPS = ['liqpay', 'monoChast', 'monoAcquire', 'privatPaypart', 'checkbox', 'novaPoshta', 'monoPersonal', 'privatAutoclient', 'novaPay']
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

// Реквизиты продавца для магазина на сайте. Пишем только переданные строки. Форма, где пусто всё (реквизиты не
// загрузились, старая страница), прежние данные не стирает; очистить можно отдельное поле.
const SELLER_FIELDS = { displayName: 200, ipn: 32, address: 300, actualAddress: 300, email: 120, phone: 32 }
const pickSeller = (seller) => {
  if (!seller || typeof seller !== 'object') return null
  const out = {}
  for (const [k, n] of Object.entries(SELLER_FIELDS)) {
    if (typeof seller[k] === 'string') out[k] = seller[k].trim().slice(0, n)
  }
  return Object.values(out).some(Boolean) ? out : null
}

export function registerFopsAdmin(app, deps) {
  const {
    adminDb, refreshFops, verifyAdmin = verifyFirebaseAdmin, loadFop = loadFopFresh, checkKeys = checkFopKeys,
    receipts = { signin, sellReceipt, returnReceipt, getReceipt }, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    // Тот же общий токен, что у других заданий Cloud Scheduler (pay-reconcile, calls-reconcile): заголовок x-admin-token.
    cronToken = process.env.PAYMENTS_ADMIN_TOKEN || '', notify = ownerTelegram(),
  } = deps
  const gate = async (req, res) => {
    if (await verifyAdmin(req)) return true
    res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Доступ лише для власника' } })
    return false
  }
  // Ключи или настройки ФОП поменялись — прежний результат проверки уже не про них: метки станут серыми до новой проверки.
  const forgetCheck = (id) => forgetKeyCheck(adminDb, id).catch((e) => console.error(`fops ${id}: скидання перевірки:`, e?.message))

  // Список ФОП для админки: мета + ФЛАГИ наличия секретов (без значений).
  app.get('/api/fops/admin', async (req, res) => {
    if (!(await gate(req, res))) return
    if (!adminDb) return res.status(503).json({ success: false })
    try {
      const [metaSnap, secSnap, checks] = await Promise.all([
        adminDb.collection('fops').get(),
        adminDb.collection('fopSecrets').get(),
        // Без результатов проверок список всё равно нужен: метки будут серыми.
        loadKeyChecks(adminDb).catch((e) => { console.error('fops admin list: перевірки:', e.message); return {} }),
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
          seller: m.seller || {},
          secretsSet: {
            liqpay: !!(s.liqpay && s.liqpay.privateKey),
            monoChast: !!(s.monoChast && s.monoChast.storeSecret),
            monoAcquire: !!(s.monoAcquire && s.monoAcquire.token),
            privatPaypart: !!(s.privatPaypart && s.privatPaypart.storeId),
            checkbox: !!(s.checkbox && s.checkbox.licenseKey),
            novaPoshtaApiKey: !!(s.novaPoshta && s.novaPoshta.apiKey),
            monoPersonal: !!(s.monoPersonal && s.monoPersonal.token),
            privatAutoclient: !!(s.privatAutoclient && s.privatAutoclient.token),
            novaPay: !!(s.novaPay && s.novaPay.refreshToken),
          },
          // Последняя проверка ключей (вручную или ежедневно): от неё цвет меток в списке.
          lastCheck: checks[d.id] || null,
        }
      }).sort((a, b) => a.name.localeCompare(b.name))
      res.json({ success: true, data: items })
    } catch (e) {
      console.error('fops admin list:', e.message)
      res.status(500).json({ success: false })
    }
  })

  // Создать/обновить ФОП. body: { name, active, methods, novaPoshta(refs), seller, secrets:{...} }
  app.put('/api/fops/admin/:id', async (req, res) => {
    if (!(await gate(req, res))) return
    if (!adminDb) return res.status(503).json({ success: false })
    const id = clip(req.params.id, 64).replace(/[^\w-]/g, '')
    if (!id) return res.status(400).json({ success: false, error: { code: 'BAD_ID', message: 'Некоректний id' } })
    try {
      const b = req.body || {}
      const seller = pickSeller(b.seller)
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
        ...(seller ? { seller } : {}),
        updatedAt: nowIso(),
      }
      await adminDb.collection('fops').doc(id).set(meta, { merge: true })

      // Секреты: пишем только непустые переданные ключи (write-only, deep-merge).
      const secretPatch = pickSecrets(b.secrets)
      if (Object.keys(secretPatch).length) {
        await adminDb.collection('fopSecrets').doc(id).set(secretPatch, { merge: true })
      }
      await forgetCheck(id)

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
      await forgetCheck(id)
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
        forgetCheck(id),
      ])
      if (typeof refreshFops === 'function') await refreshFops(adminDb)
      res.json({ success: true })
    } catch (e) {
      console.error('fops admin delete:', e.message)
      res.status(500).json({ success: false })
    }
  })

  // Проверка ключей без денег (см. fopKeyCheck.js): ключи читаем из Firestore, наружу — только вердикты.
  app.post('/api/fops/admin/:id/check-keys', async (req, res) => {
    if (!(await gate(req, res))) return
    if (!adminDb) return res.status(503).json({ success: false })
    const id = clip(req.params.id, 64).replace(/[^\w-]/g, '')
    if (!id) return res.status(400).json({ success: false, error: { code: 'BAD_ID', message: 'Некоректний id' } })
    try {
      const fop = await loadFop(adminDb, id)
      if (!fop) return res.status(404).json({ success: false, error: { code: 'NO_FOP', message: 'ФОП не знайдено' } })
      const startedAt = nowIso()
      const data = await checkKeys(fop)
      // Результат — в список (цвет меток). Не записался — проверка всё равно отдаётся владельцу.
      try {
        await saveKeyCheck(adminDb, id, data, 'manual', nowIso(), startedAt)
      } catch (e) {
        console.error(`fops check-keys ${id}: запис результату:`, e?.message)
      }
      return res.json({ success: true, data })
    } catch (e) {
      console.error(`fops check-keys ${id}:`, e?.message)
      return res.status(500).json({ success: false, error: { code: 'CHECK_FAILED', message: 'Не вдалося перевірити ключі' } })
    }
  })

  // Ежедневная проверка ключей всех активных ФОП (Cloud Scheduler с x-admin-token) или по кнопке владельца.
  app.post('/api/fops/checks/daily', async (req, res) => {
    const byCron = !!cronToken && req.get('x-admin-token') === cronToken
    if (!byCron && !(await gate(req, res))) return
    if (!adminDb) return res.status(503).json({ success: false })
    try {
      const run = await runDailyKeyCheck({ adminDb, loadFop, checkKeys, notify })
      if (run.busy) return res.status(409).json({ success: false, error: { code: 'BUSY', message: 'Перевірка вже йде: спробуйте за хвилину' } })
      return res.json({ success: true, data: { at: run.at, checked: run.checked, failed: run.failed, issues: run.issues, sent: run.sent, telegram: run.telegram } })
    } catch (e) {
      console.error('fops daily check:', e?.message)
      return res.status(500).json({ success: false, error: { code: 'DAILY_FAILED', message: 'Щоденна перевірка не виконалась' } })
    }
  })

  // Для страницы /fops: подключены ли сообщения в Telegram и чем закончилась последняя ежедневная проверка.
  app.get('/api/fops/admin/checks-status', async (req, res) => {
    if (!(await gate(req, res))) return
    if (!adminDb) return res.status(503).json({ success: false })
    try {
      const snap = await adminDb.collection(RUNS).doc('last').get()
      const run = snap.exists ? snap.data() : null
      return res.json({
        success: true,
        data: {
          telegram: notify.configured,
          lastRun: run ? { at: run.at, checked: run.checked, failed: run.failed, issues: run.issues || 0, sent: run.sent } : null,
        },
      })
    } catch (e) {
      console.error('fops checks-status:', e?.message)
      return res.status(500).json({ success: false })
    }
  })

  // Тестовый фискальный чек: РЕАЛЬНЫЙ чек продажи на 10 грн кассой ЭТОГО ФОП (Checkbox) и сразу чек возврата на ту
  // же сумму, чтобы в кассе не оставалось продажи. Деньги не двигаются: это только фискальные записи. Открывает
  // реальную смену. Ошибку Checkbox отдаём текстом — по ней видно причину (неверный licenseKey/PIN, касса не активна).
  const TEST_GOODS = [{ name: 'Ремонт (тестовий чек)', price: 10, qty: 1, code: 'TEST-REPAIR' }]
  const SETTLED = new Set(['DONE', 'ERROR', 'CANCELLED'])
  const checkboxText = (e) => {
    const d = e.response && e.response.data
    if (!d) return e.message || 'невідома помилка'
    if (typeof d === 'string') return d
    // Обычный ответ Checkbox {code, message}: человеку — текст, в скобках — код для поиска.
    if (typeof d.message === 'string' && d.message) return typeof d.code === 'string' && d.code ? `${d.message} (${d.code})` : d.message
    return JSON.stringify(d)
  }
  // Регистрация чека в ДПС асинхронная (CREATED → DONE): ждём до ~20 с, дальше отдаём то, что есть.
  const settle = async (fop, r) => {
    let cur = r
    for (let i = 0; i < 13 && !SETTLED.has(cur?.status); i++) {
      await sleep(1500)
      try {
        cur = { ...cur, ...(await receipts.getReceipt(fop, r.receiptId)) }
      } catch (e) {
        console.warn(`fops test-receipt ${fop.id}: статус чека:`, e?.response?.status || e?.message)
      }
    }
    return cur
  }

  app.post('/api/fops/admin/:id/test-receipt', async (req, res) => {
    if (!(await gate(req, res))) return
    const id = clip(req.params.id, 64).replace(/[^\w-]/g, '')
    let fop
    try {
      // Прямо из Firestore: ключ кассы могли только что сменить, а запрос попасть на другой экземпляр сервера.
      fop = adminDb ? await loadFop(adminDb, id) : getFop(id)
    } catch (e) {
      console.error(`fops test-receipt ${id}: читання ФОП:`, e?.message)
      return res.status(500).json({ success: false, error: { code: 'LOAD_FAILED', message: 'Не вдалося прочитати ФОП' } })
    }
    if (!fop) return res.status(404).json({ success: false, error: { code: 'NO_FOP', message: 'ФОП не знайдено' } })
    if (!fop.checkbox || !fop.checkbox.licenseKey) {
      return res.status(400).json({ success: false, error: { code: 'NO_CHECKBOX', message: 'У ФОП не заданий Checkbox (ключ каси/PIN). Спочатку збережіть дані каси.' } })
    }
    let sale
    try {
      await receipts.signin(fop) // свежий вход: токен в кэше мог остаться от прежнего ключа кассы
      sale = await receipts.sellReceipt(fop, { goods: TEST_GOODS, paymentLabel: 'Оплата (тест)' })
    } catch (e) {
      const detail = checkboxText(e)
      console.error(`fops test-receipt ${id}:`, detail)
      return res.status(502).json({ success: false, error: { code: 'CHECKBOX_ERROR', message: `Checkbox: ${detail}` } })
    }
    sale = await settle(fop, sale)
    // Возврат — только к продаже, которую ДПС уже приняла: возврат к незарегистрированной продаже Checkbox может принять,
    // а продажа потом упасть в ERROR — останется возврат без продажи. Продажа не прошла — возвращать нечего; ещё в
    // очереди — возврат делает владелец в кабинете Checkbox, когда она зарегистрируется.
    let refund
    if (sale.status === 'ERROR' || sale.status === 'CANCELLED') {
      refund = { skipped: 'not_registered' }
    } else if (sale.status !== 'DONE') {
      refund = { skipped: 'sale_pending' }
    } else {
      try {
        refund = await settle(fop, await receipts.returnReceipt(fop, { goods: TEST_GOODS, paymentLabel: 'Повернення (тест)', relatedReceiptId: sale.receiptId }))
      } catch (e) {
        const detail = checkboxText(e)
        console.error(`fops test-receipt ${id}: повернення:`, detail)
        refund = { error: `Checkbox: ${detail}` }
      }
    }
    return res.json({ success: true, data: { ...sale, refund } })
  })
}

export default registerFopsAdmin
