// Справочники Новой Почты В РАЗРЕЗЕ КОНКРЕТНОГО ФОП (владелец). Позволяют не вводить Ref вручную,
// а тянуть отправителей/контакты из кабинета НП по КЛЮЧУ ЭТОГО ФОП и выбирать из списка, а также
// создавать нового отправителя/контакт. Всё owner-gated (гейт ПЕРВЫМ, до валидации/вызова НП).
// Ключ НП — секрет: по умолчанию берём СОХРАНЁННЫЙ у ФОП (fopSecrets); если владелец только что ввёл
// новый в форме и ещё не сохранил — можно передать его в теле запроса (транзитно, не храним).
import { verifyFirebaseAdmin } from './adminAuth.js'
import { getFop } from './fops.js'
import { npCall, npErr } from './novaPoshtaTtn.js'

const clip = (v, n = 200) => (v == null ? '' : String(v).slice(0, n))

export function registerNpAccount(app) {
  const gate = async (req, res) => {
    if (await verifyFirebaseAdmin(req)) return true
    res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Доступ лише для власника' } })
    return false
  }

  // Ключ НП: приоритет — только что введённый в форме (тело), иначе сохранённый у ФОП.
  const resolveKey = (req) => {
    const typed = clip(req.body?.apiKey, 4000).trim()
    if (typed) return typed
    const fop = getFop(clip(req.params.id, 64).replace(/[^\w-]/g, ''))
    return (fop && fop.novaPoshta && fop.novaPoshta.apiKey) || ''
  }

  // Выполнить NP-вызов (гейт уже пройден): проверка ключа + маппинг ошибок в текст.
  const exec = async (req, res, fn) => {
    const apiKey = resolveKey(req)
    if (!apiKey) return res.status(400).json({ success: false, error: { code: 'NO_NP_KEY', message: 'Немає ключа НП: введіть і збережіть ключ у цього ФОП' } })
    try {
      const resp = await fn(apiKey)
      if (!resp || resp.success !== true) {
        return res.status(502).json({ success: false, error: { code: 'NP_ERROR', message: npErr(resp, 'Нова Пошта відхилила запит'), npErrors: (resp && (resp.errors || resp.warnings)) || [] } })
      }
      return res.json({ success: true, data: resp.data || [] })
    } catch (e) {
      console.error('np-account:', e.message)
      return res.status(500).json({ success: false, error: { code: 'NP_FAILED', message: e?.message || 'Помилка запиту до НП' } })
    }
  }

  // Список отправителей (контрагентов) кабинета этого ФОП.
  app.post('/api/fops/admin/:id/np/senders', async (req, res) => {
    if (!(await gate(req, res))) return
    return exec(req, res, (key) => npCall(key, 'Counterparty', 'getCounterparties', { CounterpartyProperty: 'Sender', Page: '1' }))
  })

  // Контакты (ContactPerson) выбранного отправителя. body: { ref }
  app.post('/api/fops/admin/:id/np/contacts', async (req, res) => {
    if (!(await gate(req, res))) return
    const ref = clip(req.body?.ref, 64)
    if (!ref) return res.status(400).json({ success: false, error: { code: 'NO_REF', message: 'Не вказано відправника (ref)' } })
    return exec(req, res, (key) => npCall(key, 'Counterparty', 'getCounterpartyContactPersons', { Ref: ref, Page: '1' }))
  })

  // Создать нового отправителя (контрагента). body: { type:'org'|'person', edrpou?, firstName?, lastName?, middleName?, phone?, cityRef? }
  app.post('/api/fops/admin/:id/np/add-sender', async (req, res) => {
    if (!(await gate(req, res))) return
    const b = req.body || {}
    const type = b.type === 'org' ? 'Organization' : 'PrivatePerson'
    const props = { CounterpartyType: type, CounterpartyProperty: 'Sender', ...(b.cityRef ? { CityRef: clip(b.cityRef, 64) } : {}) }
    if (type === 'Organization') {
      const edrpou = clip(b.edrpou, 32).trim()
      if (!edrpou) return res.status(400).json({ success: false, error: { code: 'NO_EDRPOU', message: 'Для організації потрібен ЄДРПОУ' } })
      props.EDRPOU = edrpou
    } else {
      const firstName = clip(b.firstName, 64).trim(); const lastName = clip(b.lastName, 64).trim()
      if (!firstName || !lastName) return res.status(400).json({ success: false, error: { code: 'NO_NAME', message: 'Вкажіть імʼя та прізвище' } })
      Object.assign(props, { FirstName: firstName, LastName: lastName, MiddleName: clip(b.middleName, 64).trim(), Phone: clip(b.phone, 32).trim() })
    }
    return exec(req, res, (key) => npCall(key, 'Counterparty', 'save', props))
  })

  // Добавить контакт (ContactPerson) отправителю. body: { ref, firstName, lastName, middleName?, phone }
  app.post('/api/fops/admin/:id/np/add-contact', async (req, res) => {
    if (!(await gate(req, res))) return
    const b = req.body || {}
    const ref = clip(b.ref, 64)
    const firstName = clip(b.firstName, 64).trim(); const lastName = clip(b.lastName, 64).trim()
    if (!ref) return res.status(400).json({ success: false, error: { code: 'NO_REF', message: 'Не вказано відправника (ref)' } })
    if (!firstName || !lastName) return res.status(400).json({ success: false, error: { code: 'NO_NAME', message: 'Вкажіть імʼя та прізвище' } })
    return exec(req, res, (key) => npCall(key, 'ContactPerson', 'save', {
      CounterpartyRef: ref, FirstName: firstName, LastName: lastName, MiddleName: clip(b.middleName, 64).trim(), Phone: clip(b.phone, 32).trim(),
    }))
  })
}

export default registerNpAccount
