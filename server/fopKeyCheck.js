// Проверка ключей ФОП БЕЗ денег (кнопка «Перевірити ключі» на /fops). Каждый запрос только читает:
//  • LiqPay — статус несуществующего заказа: подпись проверяется, платёж не создаётся;
//  • monobank эквайринг — данные мерчанта: название кабинета и код показывают, чей это токен;
//  • monobank Частини — отчёт магазина за сегодня: при чужом store-id или подписи банк отвечает 401;
//  • Checkbox — касса по ключу лицензии, вход кассира по PIN, его профиль, готовность подписи, смена и оплата
//    услуг Checkbox (подписка, блокировка за неоплату); смену не открываем, чеков не создаём;
//  • Нова Пошта — отправители кабинета и опции выбранного отправителя («контроль оплаты»).
// Значения ключей наружу и в журнал не попадают: отдаём только вердикты. Зелёный вердикт — лишь
// по подтверждённому ответу; всё непонятное — 'unknown' с кодом ответа, а не «всё хорошо».
import { queryStatus } from './liqpay.js'
import { merchantDetails } from './monoAcquire.js'
import { storeReport } from './monoChast.js'
import { cashRegisterInfo, signin, cashierMe, checkSignature, cashierShift, billingStatus } from './checkbox.js'
import { npCall, npErr } from './novaPoshtaTtn.js'
import { methodOn } from './fops.js'

const clip = (v, n = 200) => (v == null ? '' : String(v).slice(0, n))
const verdict = (status, message, extra = {}) => ({ status, message, ...extra })
// Значение уходит в заголовок: кириллица, пробел или перевод строки внутри — заголовок не уйдёт, повтор не поможет.
const printable = (v) => /^[\x21-\x7e]+$/.test(String(v))
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const KYIV_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' })

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
  if (!printable(token)) return verdict('bad', 'Токен містить зайві символи: вставте його ще раз')
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

// «Покупка частинами»: отчёт магазина за сегодня. 401 банка: «Signature is not valid» — secret не тот,
// «... store [...] not found» — банк не знает store id (проверено на песочнице банка).
export const checkMonoChast = async (fop, report = storeReport, now = () => new Date()) => {
  const { storeId, storeSecret } = fop.monoChast || {}
  if (!storeId && !storeSecret) return verdict('none', 'Ключі не задані')
  if (!storeId) return verdict('bad', 'Немає store id')
  if (!storeSecret) return verdict('bad', 'Немає store secret')
  if (!printable(storeId)) return verdict('bad', 'Store id містить зайві символи: вставте його ще раз')
  try {
    const r = await report(fop, KYIV_DATE.format(now()))
    if (!isObject(r)) return verdict('unknown', 'monobank повернув незрозумілу відповідь, спробуйте пізніше')
    return verdict('ok', 'Ключі дійсні. monobank не показує, чий це магазин: звірте store id з кабінетом «Покупки частинами».',
      payNote(fop, 'Оплату частинами monobank', 'monoChast'))
  } catch (e) {
    const http = e?.response?.status
    if (http === 401) {
      const text = String(e?.response?.data?.message || '')
      return verdict('bad', /not found/i.test(text) ? 'monobank не знає цей store id' : 'Store secret не підходить до store id')
    }
    console.error('key-check mono chast:', http || e?.message)
    return verdict('unknown', http ? `monobank відповів кодом ${http}, спробуйте пізніше` : 'monobank не відповів, спробуйте пізніше')
  }
}

// Текст ошибки Checkbox ({message}) без значений ключа, PIN и пароля кассира.
const cbMessage = (e, fop) => {
  const d = e?.response?.data
  let msg = isObject(d) && typeof d.message === 'string' ? d.message : ''
  for (const secret of [fop.checkbox?.licenseKey, fop.checkbox?.pinCode, fop.checkbox?.password]) {
    if (secret) msg = msg.split(String(secret)).join('***')
  }
  return clip(msg, 160)
}
const cbCode = (e) => {
  const d = e?.response?.data
  return isObject(d) && typeof d.code === 'string' ? d.code : ''
}
// Касса заблокирована за неоплату услуг Checkbox (на продаже — organization.billing_disabled, снято в бою 2026-11-10).
const BILLING_BLOCK = /^organization\.billing/
// 401/403/422 — Checkbox отказал в том, что мы проверяем (ключ или PIN), как и блок за неоплату; остальное — сбой,
// а не плохой ключ.
const cbFail = (e, fop, what) => {
  const http = e?.response?.status
  if (http === 401 || http === 403 || http === 422 || BILLING_BLOCK.test(cbCode(e))) {
    const msg = cbMessage(e, fop)
    return verdict('bad', msg ? `Checkbox: ${msg}` : `Checkbox не приймає ${what}`)
  }
  console.error(`key-check checkbox (${what}):`, http || e?.message)
  return verdict('unknown', http ? `Checkbox відповів кодом ${http}, спробуйте пізніше` : 'Checkbox не відповів, спробуйте пізніше')
}

const CHECKBOX_IO = { register: cashRegisterInfo, signIn: signin, me: cashierMe, signature: checkSignature, shift: cashierShift, billing: billingStatus }
// Статусы оплаты Checkbox не документированы: красным считаем только явно «плохие» слова, остальное показываем как есть.
const BAD_BILLING_STATUS = /block|disabl|suspend|debt|unpaid|inactive|expired/i
const DAY_MS = 24 * 3600 * 1000
const uaDate = (v) => {
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' })
}

// Checkbox: касса по ключу лицензии → вход кассира по PIN → профиль, подпись (КЕП), смена. Только чтение.
export const checkCheckbox = async (fop, io = {}, now = () => new Date()) => {
  const { register, signIn, me, signature, shift, billing } = { ...CHECKBOX_IO, ...io }
  const cb = fop.checkbox || {}
  if (!cb.licenseKey && !cb.pinCode) return verdict('none', 'Ключі не задані')
  if (!cb.licenseKey) return verdict('bad', 'Немає ключа ліцензії каси')
  if (!printable(cb.licenseKey)) return verdict('bad', 'Ключ ліцензії містить зайві символи: вставте його ще раз')
  if (!cb.pinCode && !(cb.login && cb.password)) return verdict('bad', 'Немає PIN касира')

  let reg
  try {
    reg = await register(fop)
  } catch (e) {
    return cbFail(e, fop, 'ключ ліцензії каси')
  }
  if (!isObject(reg)) return verdict('unknown', 'Checkbox повернув незрозумілу відповідь, спробуйте пізніше')
  const cashRegister = { title: clip(reg.title), fiscalNumber: clip(reg.fiscal_number, 64), address: clip(reg.address) }
  if (reg.is_test === true) {
    return verdict('bad', 'Це тестова каса Checkbox: її чеки не йдуть у податкову. Вставте ключ ліцензії робочої каси.', { cashRegister })
  }

  // Свежий вход, а не токен из кэша: ключ кассы могли только что сменить. Вход смену не открывает.
  try {
    await signIn(fop)
  } catch (e) {
    return { ...cbFail(e, fop, 'PIN касира'), cashRegister }
  }

  const [meR, sigR, shiftR, billR] = await Promise.allSettled([me(fop), signature(fop), shift(fop), billing(fop)])
  const m = meR.status === 'fulfilled' && isObject(meR.value) ? meR.value : null
  const s = sigR.status === 'fulfilled' && isObject(sigR.value) ? sigR.value : null
  const b = billR.status === 'fulfilled' && isObject(billR.value) ? billR.value : null
  // Смены нет: тело пустое, это не сбой.
  const shiftState = shiftR.status !== 'fulfilled' ? null : (isObject(shiftR.value) && clip(shiftR.value.status, 40)) || 'NONE'
  if (meR.status === 'rejected') console.error('key-check checkbox (касир):', meR.reason?.response?.status || meR.reason?.message)
  if (sigR.status === 'rejected') console.error('key-check checkbox (підпис):', sigR.reason?.response?.status || sigR.reason?.message)
  if (billR.status === 'rejected') console.error('key-check checkbox (оплата):', billR.reason?.response?.status || billR.reason?.message, cbCode(billR.reason))
  const subscriptionExp = clip(m?.organization?.subscription_exp, 40)
  const dateToBlock = clip(b?.date_to_block, 40)
  const billingState = clip(b?.status, 40)
  // Значения статуса оплаты ещё не сверены с документацией: пишем их в журнал, чтобы уточнить правила.
  if (b || subscriptionExp) console.log('key-check checkbox billing:', JSON.stringify({ fop: fop.id, status: billingState, dateToBlock, subscriptionExp, units: b?.units ?? null }))
  const extra = {
    cashRegister,
    shift: shiftState,
    ...(m ? {
      cashierName: clip(m.full_name),
      merchantName: clip(m.organization?.title),
      edrpou: clip(m.organization?.edrpou, 32),
      certificateEnd: clip(m.certificate_end, 40),
    } : {}),
    ...(subscriptionExp ? { subscriptionExp } : {}),
    ...(billingState ? { billingStatus: billingState } : {}),
    ...(dateToBlock ? { dateToBlock } : {}),
  }
  // Касса заблокирована за неоплату: любой из запросов мог получить этот отказ.
  const blocked = [meR, sigR, shiftR, billR].find((r) => r.status === 'rejected' && BILLING_BLOCK.test(cbCode(r.reason)))
  if (blocked) {
    const msg = cbMessage(blocked.reason, fop)
    return verdict('bad', `Checkbox: ${msg || 'касу заблоковано через несплату послуг'}. Чеки не підуть, поки не оплатите послуги в кабінеті Checkbox (my.checkbox.ua).`, extra)
  }
  const today = KYIV_DATE.format(now())
  if (subscriptionExp && subscriptionExp < today) {
    return verdict('bad', `Підписка Checkbox закінчилась ${uaDate(subscriptionExp)}: каса не видасть чек. Оплатіть послуги в кабінеті Checkbox (my.checkbox.ua).`, extra)
  }
  const blockAt = dateToBlock ? new Date(dateToBlock) : null
  const msToBlock = blockAt && !Number.isNaN(blockAt.getTime()) ? blockAt.getTime() - now().getTime() : null
  if (msToBlock !== null && msToBlock <= 0) {
    return verdict('bad', `Checkbox заблокував касу ${uaDate(dateToBlock)} через несплату: чеки не підуть. Оплатіть послуги в кабінеті Checkbox (my.checkbox.ua).`, extra)
  }
  if (billingState && BAD_BILLING_STATUS.test(billingState)) {
    return verdict('bad', `Стан оплати Checkbox «${billingState}»: чеки, найімовірніше, не підуть. Перевірте оплату в кабінеті Checkbox (my.checkbox.ua).`, extra)
  }
  if (!m) return verdict('unknown', 'Ключ і PIN дійсні, але Checkbox не показав профіль касира: спробуйте пізніше', extra)
  if (m.blocked === true || (typeof m.blocked === 'string' && m.blocked.trim() && m.blocked !== 'false')) {
    return verdict('bad', 'Касира заблоковано в Checkbox: чеки від його імені не підуть.', extra)
  }
  if (m.is_test === true || m.signature_type === 'TEST') return verdict('bad', 'Це тестовий касир Checkbox: справжніх чеків не буде.', extra)
  const end = m.certificate_end ? new Date(m.certificate_end) : null
  const msLeft = end && !Number.isNaN(end.getTime()) ? end.getTime() - now().getTime() : null
  if (msLeft !== null && msLeft <= 0) return verdict('bad', 'Строк дії ключа підпису (КЕП) касира скінчився: оновіть його в кабінеті Checkbox.', extra)
  if (!s) return verdict('unknown', 'Ключ і PIN дійсні, але Checkbox не повідомив, чи працює підпис касира: спробуйте пізніше', extra)
  // Открытую смену второй раз не открыть: «нельзя открыть» тогда не значит, что подпись сломана. Смену не прочитали —
  // не знаем, какой это случай.
  if (s.shift_open_possibility === false && shiftState === null) {
    return verdict('unknown', 'Ключ і PIN дійсні, але Checkbox не показав зміну, тож не зрозуміло, чи підуть чеки: спробуйте пізніше', extra)
  }
  if (s.shift_open_possibility === false && shiftState !== 'OPENED') {
    return verdict('bad', 'Checkbox каже, що зміну зараз відкрити не можна: чеки не підуть. Перевірте ключ підпису (КЕП) касира в кабінеті Checkbox.', extra)
  }
  if (s.online === false && s.shift_open_possibility !== true) {
    return verdict('bad', 'Підпис касира зараз недоступний: чеки не підпишуться. Перевірте ключ підпису (КЕП) касира в кабінеті Checkbox.', extra)
  }
  const notes = []
  if (msLeft !== null && msLeft < 14 * DAY_MS) notes.push('Ключ підпису касира закінчується менш ніж за 14 днів: оновіть його в кабінеті Checkbox заздалегідь.')
  if (subscriptionExp && subscriptionExp <= KYIV_DATE.format(new Date(now().getTime() + 7 * DAY_MS))) {
    notes.push(`Підписка Checkbox закінчується ${uaDate(subscriptionExp)}: оплатіть заздалегідь, інакше каса не видасть чек.`)
  }
  if (msToBlock !== null && msToBlock < 7 * DAY_MS) notes.push(`Checkbox заблокує касу ${uaDate(dateToBlock)}, якщо не оплатити послуги.`)
  if (!b && !subscriptionExp) notes.push('Checkbox не показав стан оплати: чи оплачені послуги каси, перевірте в кабінеті Checkbox.')
  return verdict('ok', 'Каса, касир і підпис у порядку. Звірте, що каса належить саме цьому ФОП: чек має бути від тієї ж особи, що й оплата.', {
    ...extra, ...(notes.length ? { note: notes.join(' ') } : {}),
  })
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

const digits = (v) => String(v || '').replace(/\D/g, '')

export const checkFopKeys = async (fop, io = {}) => {
  const [liqpay, monoAcquire, monoChast, checkbox, novaPoshta] = await Promise.all([
    checkLiqpay(fop, io.liqpayStatus),
    checkMonoAcquire(fop, io.monoDetails),
    checkMonoChast(fop, io.monoReport),
    checkCheckbox(fop, io.checkbox),
    checkNovaPoshta(fop, io.np),
  ])
  // Чек и оплата должны быть от одного лица: коды кассы Checkbox и кабинета monobank сверяем сами.
  const cashCode = digits(checkbox.edrpou)
  const monoCode = digits(monoAcquire.edrpou)
  if (checkbox.status === 'ok' && monoAcquire.status === 'ok' && cashCode && monoCode && cashCode !== monoCode) {
    checkbox.status = 'bad'
    checkbox.message = `Каса належить іншій особі, ніж кабінет monobank: код каси ${cashCode}, код monobank ${monoCode}. Чек і оплата мають бути від одного ФОП.`
  }
  return { liqpay, monoAcquire, monoChast, checkbox, novaPoshta }
}

export default checkFopKeys
