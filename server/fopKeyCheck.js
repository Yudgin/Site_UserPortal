// Проверка ключей ФОП БЕЗ денег (кнопка «Перевірити ключі» на /fops). Каждый запрос только читает:
//  • LiqPay — статус несуществующего заказа: подпись проверяется, платёж не создаётся;
//  • monobank эквайринг — данные мерчанта: название кабинета и код показывают, чей это токен;
//  • Нова Пошта — отправители кабинета и опции выбранного отправителя («контроль оплаты»).
// Значения ключей наружу и в журнал не попадают: отдаём только вердикты. Зелёный вердикт — лишь
// по подтверждённому ответу; всё непонятное — 'unknown' с кодом ответа, а не «всё хорошо».
import { queryStatus } from './liqpay.js'
import { merchantDetails } from './monoAcquire.js'
import { npCall, npErr } from './novaPoshtaTtn.js'
import { methodOn } from './fops.js'

const clip = (v, n = 200) => (v == null ? '' : String(v).slice(0, n))
const verdict = (status, message, extra = {}) => ({ status, message, ...extra })

// Ключ годен, но способ выключен. Галочка убирает его только из нового выбора: createPayment её не
// проверяет, поэтому центр с этим ФОП по умолчанию и готовые калькуляции продолжают его предлагать.
const payNote = (fop, label, ...keys) => {
  if (fop.active === false) return { note: 'ФОП вимкнено: нові оплати на нього не проходять.' }
  if (keys.some((k) => methodOn(fop, k, true))) return {}
  return { note: `${label} вимкнено у формі ФОП: при новому виборі способу цього варіанта не буде. Але центр із цим ФОП за замовчуванням і вже створені калькуляції все одно можуть його пропонувати.` }
}

// computeCod учитывает только галочку, а не active.
const codNote = (fop) => {
  if (fop.active === false) return { note: 'ФОП вимкнено, але ТТН і накладений платіж від нього все одно створюються.' }
  return methodOn(fop, 'cod', true) ? {} : { note: 'Накладений платіж вимкнено у формі ФОП: у ТТН сам не підставляється, суму може вказати лише власник.' }
}

export const checkLiqpay = async (fop, liqpayStatus = queryStatus) => {
  const { publicKey, privateKey } = fop.liqpay || {}
  if (!publicKey && !privateKey) return verdict('none', 'Ключі не задані')
  if (!publicKey) return verdict('bad', 'Немає public key')
  if (!privateKey) return verdict('bad', 'Немає private key')
  if (String(publicKey).startsWith('sandbox_')) return verdict('bad', 'Це тестовий ключ LiqPay (sandbox): справжні оплати з ним не пройдуть')
  const r = await liqpayStatus(fop, `keycheck-${Date.now()}`)
  const code = r && typeof r === 'object' ? clip(r.err_code || r.code, 64) : ''
  if (code === 'payment_not_found') {
    return verdict('ok', 'Ключі дійсні. LiqPay не показує власника кабінету: звірте його самі.', payNote(fop, 'Оплату LiqPay', 'liqpayCard', 'liqpayPaypart'))
  }
  if (code === 'public_key_not_found') return verdict('bad', 'LiqPay не знає цей public key')
  if (code.includes('signature')) return verdict('bad', 'Private key не підходить до public key')
  return verdict('unknown', code ? `Не вдалося підтвердити, відповідь LiqPay: ${code}` : 'LiqPay не відповів, спробуйте пізніше')
}

export const checkMonoAcquire = async (fop, monoDetails = merchantDetails) => {
  const token = fop.monoAcquire?.token
  if (!token) return verdict('none', 'Токен не заданий')
  // Кириллица или перевод строки внутри токена: заголовок не уйдёт вообще, повтор не поможет.
  if (!/^[\x21-\x7e]+$/.test(token)) return verdict('bad', 'Токен містить зайві символи: вставте його ще раз')
  try {
    const d = await monoDetails(fop)
    // Без названия и кода сверять нечего: ради этого проверка и нужна.
    if (!d?.merchantName && !d?.edrpou) return verdict('unknown', 'monobank не повідомив, чий це кабінет: спробуйте пізніше')
    return verdict('ok', 'Токен дійсний. Звірте, що кабінет належить саме цьому ФОП: оплата і чек мають бути від однієї особи.', {
      merchantName: clip(d.merchantName), edrpou: clip(d.edrpou, 32), ...payNote(fop, 'Еквайринг monobank', 'monoAcquire'),
    })
  } catch (e) {
    const http = e?.response?.status
    if (http === 401 || http === 403) return verdict('bad', 'monobank не приймає цей токен')
    console.error('key-check mono:', http || e?.message)
    return verdict('unknown', http ? `monobank відповів кодом ${http}, спробуйте пізніше` : 'monobank не відповів, спробуйте пізніше')
  }
}

// Без этих полей создание ТТН откажет (NP_SENDER_INCOMPLETE в novaPoshtaTtn.js), телефон уйдёт пустым.
const NP_REQUIRED = [['senderRef', 'відправник'], ['contactRef', 'контактна особа'], ['senderPhone', 'телефон відправника'], ['cityRef', 'місто'], ['warehouseRef', 'відділення']]

export const checkNovaPoshta = async (fop, np = npCall) => {
  const npc = fop.novaPoshta || {}
  const { apiKey } = npc
  if (!apiKey) return verdict('none', 'Ключ не заданий')
  try {
    const list = await np(apiKey, 'Counterparty', 'getCounterparties', { CounterpartyProperty: 'Sender', Page: '1' })
    if (list?.success !== true) {
      const text = clip(String(npErr(list, '')).split(apiKey).join('***'))
      if (list?.success === false && /api.?key|auth/i.test(text)) return verdict('bad', `Нова Пошта не приймає цей ключ: ${text}`)
      return verdict('unknown', text ? `Не вдалося підтвердити, відповідь Нової Пошти: ${text}` : 'Нова Пошта не відповіла, спробуйте пізніше')
    }
    const missing = NP_REQUIRED.filter(([k]) => !npc[k]).map(([, title]) => title)
    if (missing.length) return verdict('bad', `Ключ дійсний, але у формі ФОП не заповнено: ${missing.join(', ')}. ТТН не створиться.`)
    if (!Array.isArray(list.data)) return verdict('unknown', 'Нова Пошта повернула незрозумілу відповідь, спробуйте пізніше')
    if (!list.data.some((s) => s && s.Ref === npc.senderRef)) return verdict('bad', 'Ключ дійсний, але обраний відправник не з цього кабінету')
    // «Контроль оплаты» (деньги на счёт ФОП) требует отдельного договора: спрашиваем у самой НП.
    let paymentControl = null
    try {
      const opt = await np(apiKey, 'Counterparty', 'getCounterpartyOptions', { Ref: npc.senderRef })
      const v = opt?.success === true && Array.isArray(opt.data) ? opt.data[0]?.CanAfterpaymentOnGoodsCost : undefined
      if (typeof v === 'boolean') paymentControl = v
    } catch (e) {
      console.error('key-check np options:', e?.message)
    }
    return verdict('ok', 'Ключ і відправник дійсні.', { paymentControl, ...codNote(fop) })
  } catch (e) {
    console.error('key-check np:', e?.message)
    return verdict('unknown', 'Нова Пошта не відповіла, спробуйте пізніше')
  }
}

export const checkFopKeys = async (fop, io = {}) => {
  const [liqpay, monoAcquire, novaPoshta] = await Promise.all([
    checkLiqpay(fop, io.liqpayStatus),
    checkMonoAcquire(fop, io.monoDetails),
    checkNovaPoshta(fop, io.np),
  ])
  return { liqpay, monoAcquire, novaPoshta }
}

export default checkFopKeys
