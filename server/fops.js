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

// Полный конфиг ФОП из документов Firestore: мета (fops) + секреты (fopSecrets).
const mergeFop = (id, m, s) => ({
  id,
  name: m.name || id,
  active: m.active !== false,
  methods: m.methods || {}, // включённые методы (намерение владельца)
  seller: m.seller, // реквизиты продавца для магазина на сайте (публичные)
  novaPoshta: { ...(m.novaPoshta || {}), ...(s.novaPoshta || {}) }, // refs (мета) + apiKey (секрет)
  liqpay: s.liqpay,
  monoChast: s.monoChast,
  monoAcquire: s.monoAcquire,
  privatPaypart: s.privatPaypart, // ПриватБанк оплата частями
  checkbox: s.checkbox,
  // Банки ФОП, только чтение остатков и выписок (не приём оплат)
  monoPersonal: s.monoPersonal, // личный токен monobank владельца ФОП
  privatAutoclient: s.privatAutoclient, // «Автоклієнт» Приват24 для бізнесу
  novaPay: s.novaPay, // API бизнес-кабинета NovaPay
})

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
    const merged = metaSnap.docs.map((d) => mergeFop(d.id, d.data() || {}, secrets[d.id] || {}))
    // Мержим env-сид + Firestore: Firestore перекрывает/дополняет по id, но env-ФОПы НЕ теряются
    // (иначе создание первого ФОПа в UI обесточило бы живые env-оплаты). НЕактивные ФОПы тоже
    // держим в кэше — getFop должен резолвить их для УЖЕ созданных заказов (вебхуки/чеки/reconcile).
    // Флаг active скрывает ФОП только из ВЫБОРА для НОВЫХ оплат (listFopsPublic + createPayment).
    const byId = new Map(seedFromEnv().map((f) => [f.id, f]))
    for (const f of merged) byId.set(f.id, f)
    FOPS = [...byId.values()]
  } catch (e) {
    console.error('refreshFops:', e.message)
  }
  return FOPS
}

// Один ФОП прямо из Firestore, минуя кэш: сразу после смены ключа запрос мог попасть на другой
// экземпляр сервера. Ошибку Firestore НЕ глотаем: иначе вердикт был бы про старый ключ. ФОП только
// из ENV (документа нет) берём из кэша.
export async function loadFopFresh(adminDb, fopId) {
  const [meta, sec] = await Promise.all([
    adminDb.collection('fops').doc(fopId).get(),
    adminDb.collection('fopSecrets').doc(fopId).get(),
  ])
  return meta.exists ? mergeFop(fopId, meta.data() || {}, (sec.exists && sec.data()) || {}) : getFop(fopId)
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
export const methodOn = (f, key, hasKey) => hasKey && (f.methods ? f.methods[key] !== false : true)

// Публичный список ФОП (БЕЗ секретов) — для UI и /api/fops: id, name и какие методы доступны.
// НЕактивные ФОПы скрываем — они не должны предлагаться для НОВЫХ оплат (но getFop их резолвит).
export const listFopsPublic = () =>
  FOPS.filter((f) => f && f.active !== false).map((f) => ({
    id: f.id,
    name: f.name || f.id,
    methods: {
      liqpayCard: methodOn(f, 'liqpayCard', fopHas(f, 'liqpay.privateKey')),
      liqpayPaypart: methodOn(f, 'liqpayPaypart', fopHas(f, 'liqpay.privateKey')),
      monoChast: methodOn(f, 'monoChast', fopHas(f, 'monoChast.storeSecret')),
      monoAcquire: methodOn(f, 'monoAcquire', fopHas(f, 'monoAcquire.token')),
      privatPaypart: methodOn(f, 'privatPaypart', fopHas(f, 'privatPaypart.storeId')),
      // Накладений платіж (COD) — клиент платит при получении через НП; требует ключ НП у ФОП.
      cod: methodOn(f, 'cod', fopHas(f, 'novaPoshta.apiKey')),
    },
    novaPoshta: fopHas(f, 'novaPoshta.apiKey'), // может ли этот ФОП создавать ТТН
    receipts: fopHas(f, 'checkbox.licenseKey'), // может ли выдавать фискальные чеки
  }))

// ФОПы с ключом Новой Почты — С КЛЮЧОМ, только для серверной синхронизации журнала посылок (parcels.js).
// Неактивные тоже: их посылки ещё могут быть в дороге. Наружу этот список не отдавать.
export const listNpFops = () =>
  FOPS.filter((f) => f && f.novaPoshta && f.novaPoshta.apiKey).map((f) => ({
    id: f.id,
    name: f.name || f.id,
    active: f.active !== false,
    apiKey: f.novaPoshta.apiKey,
    senderRef: f.novaPoshta.senderRef || '',
    senderPhone: f.novaPoshta.senderPhone || '',
  }))

export const hasAnyFop = () => FOPS.length > 0

export default { getFop, fopHas, listFopsPublic, hasAnyFop, refreshFops }
