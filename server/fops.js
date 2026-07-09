// Реестр ФОП для приёма оплат. Оплаты принимаются от РАЗНЫХ ФОП, и КЛЮЧЕВОЕ правило:
// какой ФОП принял оплату частями — тот же ФОП выдаёт фискальный чек (его креды Checkbox).
// Поэтому каждый заказ (payments/{id}) хранит fopId, а фискализация берёт креды по этому fopId.
//
// Конфиг ФОПов — В ENV (JSON), НЕ в коде и НЕ в git. Пример FOPS_CONFIG:
// [
//   {
//     "id": "fop1", "name": "ФОП Іваненко І.І.",
//     "liqpay":      { "publicKey": "...", "privateKey": "..." },
//     "monoChast":   { "storeId": "...", "storeSecret": "..." },
//     "monoAcquire": { "token": "..." },
//     "checkbox":    { "licenseKey": "...", "pinCode": "...", "cashierName": "ФОП Іваненко І.І." }
//   }
// ]

let FOPS = []
try {
  FOPS = JSON.parse(process.env.FOPS_CONFIG || '[]')
  if (!Array.isArray(FOPS)) FOPS = []
} catch (e) {
  console.warn('⚠️  FOPS_CONFIG невалиден (ожидается JSON-массив) — оплаты отключены:', e.message)
  FOPS = []
}
if (!FOPS.length) console.warn('⚠️  FOPS_CONFIG пуст — эндпоинты оплат вернут 503, пока не заданы ФОП (см. .env.example)')

// Полный конфиг ФОП с секретами (для серверной логики). null, если не найден.
export const getFop = (fopId) => FOPS.find((f) => f && f.id === fopId) || null

// Есть ли у ФОП настроенный метод/канал
export const fopHas = (fop, path) => {
  if (!fop) return false
  const [a, b] = path.split('.')
  return b ? !!(fop[a] && fop[a][b]) : !!fop[a]
}

// Публичный список ФОП (БЕЗ секретов) — для UI и /api/fops: id, name и какие методы доступны.
export const listFopsPublic = () =>
  FOPS.map((f) => ({
    id: f.id,
    name: f.name || f.id,
    methods: {
      liqpayCard: fopHas(f, 'liqpay.privateKey'),
      liqpayPaypart: fopHas(f, 'liqpay.privateKey'),
      monoChast: fopHas(f, 'monoChast.storeSecret'),
      monoAcquire: fopHas(f, 'monoAcquire.token'),
    },
    receipts: fopHas(f, 'checkbox.licenseKey'), // может ли этот ФОП выдавать фискальные чеки
  }))

export const hasAnyFop = () => FOPS.length > 0

export default { getFop, fopHas, listFopsPublic, hasAnyFop }
