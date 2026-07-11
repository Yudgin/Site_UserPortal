// Реестр ФОП для приёма оплат. Оплаты принимаются от РАЗНЫХ ФОП, и КЛЮЧЕВОЕ правило:
// какой ФОП принял оплату частями — тот же ФОП выдаёт фискальный чек (его креды Checkbox).
// Поэтому каждый заказ (payments/{id}) хранит fopId, а фискализация берёт креды по этому fopId.
//
// ИСТОЧНИК: Firestore (не-секретная мета в `fops/{id}` + секреты в `fopSecrets/{id}`, доступном
// ТОЛЬКО backend-у через Admin SDK — правила запрещают клиентский доступ). Секреты в браузер
// НЕ отдаются. ENV FOPS_CONFIG остаётся seed/fallback (пока не мигрировали в Firestore).

// Начальный сид из ENV (fallback, пока Firestore не загрузился / если там пусто).
const seedFromEnv = () => {
  try {
    const e = JSON.parse(process.env.FOPS_CONFIG || '[]')
    return Array.isArray(e) ? e : []
  } catch (err) {
    console.warn('⚠️  FOPS_CONFIG невалиден (ожидается JSON-массив):', err.message)
    return []
  }
}

// In-memory кэш полных конфигов (payments.js читает синхронно). Обновляется refreshFops().
let FOPS = seedFromEnv()

// Перезагрузить ФОПы из Firestore (мета + секреты), смёржить в полный конфиг. Если в Firestore
// нет ФОПов — оставляем ENV-сид (не ломаем текущие живые оплаты до миграции).
export async function refreshFops(adminDb) {
  if (!adminDb) return FOPS
  try {
    const [metaSnap, secSnap] = await Promise.all([
      adminDb.collection('fops').get(),
      adminDb.collection('fopSecrets').get(),
    ])
    const secrets = {}
    secSnap.forEach((d) => { secrets[d.id] = d.data() || {} })
    const merged = metaSnap.docs.map((d) => {
      const m = d.data() || {}
      const s = secrets[d.id] || {}
      return {
        id: d.id,
        name: m.name || d.id,
        active: m.active !== false,
        methods: m.methods || {}, // включённые методы (намерение владельца)
        novaPoshta: { ...(m.novaPoshta || {}), ...(s.novaPoshta || {}) }, // refs (мета) + apiKey (секрет)
        liqpay: s.liqpay,
        monoChast: s.monoChast,
        monoAcquire: s.monoAcquire,
        privatPaypart: s.privatPaypart, // ПриватБанк оплата частями
        checkbox: s.checkbox,
      }
    }).filter((f) => f.active !== false)
    // Мержим env-сид + Firestore: Firestore перекрывает/дополняет по id, но env-ФОПы НЕ теряются
    // (иначе создание первого ФОПа в UI обесточило бы живые env-оплаты).
    const byId = new Map(seedFromEnv().map((f) => [f.id, f]))
    for (const f of merged) byId.set(f.id, f)
    FOPS = [...byId.values()]
  } catch (e) {
    console.error('refreshFops:', e.message)
  }
  return FOPS
}

// Полный конфиг ФОП с секретами (для серверной логики). null, если не найден.
export const getFop = (fopId) => FOPS.find((f) => f && f.id === fopId) || null

// Есть ли у ФОП настроенный метод/канал (по наличию ключа)
export const fopHas = (fop, path) => {
  if (!fop) return false
  const [a, b] = path.split('.')
  return b ? !!(fop[a] && fop[a][b]) : !!fop[a]
}

// Метод доступен, если ключ задан И владелец его не отключил в настройках (methods[key] !== false).
const methodOn = (f, key, hasKey) => hasKey && (f.methods ? f.methods[key] !== false : true)

// Публичный список ФОП (БЕЗ секретов) — для UI и /api/fops: id, name и какие методы доступны.
export const listFopsPublic = () =>
  FOPS.map((f) => ({
    id: f.id,
    name: f.name || f.id,
    methods: {
      liqpayCard: methodOn(f, 'liqpayCard', fopHas(f, 'liqpay.privateKey')),
      liqpayPaypart: methodOn(f, 'liqpayPaypart', fopHas(f, 'liqpay.privateKey')),
      monoChast: methodOn(f, 'monoChast', fopHas(f, 'monoChast.storeSecret')),
      monoAcquire: methodOn(f, 'monoAcquire', fopHas(f, 'monoAcquire.token')),
      privatPaypart: methodOn(f, 'privatPaypart', fopHas(f, 'privatPaypart.storeId')),
    },
    novaPoshta: fopHas(f, 'novaPoshta.apiKey'), // может ли этот ФОП создавать ТТН
    receipts: fopHas(f, 'checkbox.licenseKey'), // может ли выдавать фискальные чеки
  }))

export const hasAnyFop = () => FOPS.length > 0

export default { getFop, fopHas, listFopsPublic, hasAnyFop, refreshFops }
