// Сценарій вхідного дзвінка голосового шлюзу — чиста машина станів, без I/O. Усе зовнішнє приходить ззовні:
// send(cmd) — команда рушію, clock {now, setTimeout, clearTimeout}, lookup(phone), buildCard(lookup, {number, phone}),
// tts(text) → {file, cached}, voicemailPath({gcid, number}) → шлях WAV голосової пошти (теку створює той, хто передав),
// onDone(entry) — запис у журнал, log(msg) — рядок статусу для оператора (рос.).
//
// Нога A — клієнт (вхідний на лінію), нога B — той, кому зараз дзвонимо: менеджер (managerUri), а якщо він не взяв —
// запасна лінія (fallbackUri). Порядок:
//   вхідний A → (не з білого списку і не внутрішній → 486) → answer 200 → привітання → утримання (по колу);
//   паралельно: пошук клієнта → текст картки → синтез; через ~1 с після відповіді — набір менеджера.
//   Набір: 503/408/480 або помилка рушія до відповіді → повтор через dialRetryIntervalMs, поки наступна спроба
//   починається в межах dialRetryWindowSec від першого набору цієї сторони (Android-софтфон, що спить, кілька секунд
//   відповідає 503); утримання клієнту весь цей час грає по колу.
//   Тайм-аут сторони (managerTimeoutSec / fallbackTimeoutSec) — скільки дзвонить спроба: від її першого 180/183
//   (немає 180 — від її INVITE), тож повтор, що зазвонив на 10-й с, теж дзвонить повний час. Уся сторона разом із
//   повторами — не довше dialRetryWindowSec + тайм-аут від першого набору.
//   B відповів → картка на B (синтез чекаємо ≤ ttsWaitMs; не вдався — genericCardFile або без картки) →
//   кінець картки + afterCardMs (але не пізніше cardMaxSec від її початку) → xfer_replaces(A, B) →
//   фінальний 2xx — з'єднано (АТС гасить обидві ноги; жива через xferClearMs — кладемо);
//   REFER прийнято (202/NOTIFY 100), фінального NOTIFY немає, а АТС поклала обидві ноги — теж успіх Replaces
//   (…_unconfirmed); поклала лише B, а клієнт і через xferTimeoutMs на нашій нозі — переведення не відбулося
//   (…_xfer_unconfirmed → наступна сторона або пошта): при вдалому Replaces Binotel кладе A одразу за B;
//   невдача — локальний міст A↔B (bridged, не довше bridgeMaxMin). A поклав — кладемо B (client_hangup).
//   Менеджер не взяв / зайнятий / поклав до переведення / повтори вичерпано → те саме із запасною лінією
//   (connected_fallback); не вийшло і з нею або її немає → голосова пошта: привітання, якщо ще грає, догрує →
//   стоп утримання → voicemailPromptFile → сигнал beepFile → запис голосу клієнта (record) до voicemailMaxSec або
//   до його відбою → кладемо (voicemail; запис коротший за voicemailMinSec або файла немає — voicemail_empty,
//   порожній файл видаляє gateway.mjs). Шлюз зупинили під час запису — voicemail з stop 'aborted' і abortReason.
//   Сліпе переведення (REFER без Replaces) — лише з fallbackMode 'blind' (старий шлях, для дослідів): живий Binotel
//   2026-10-17 відповідав на нього фінальним NOTIFY 200 за ~2 мс, навіть коли запасна була недоступна, і клієнта
//   просто роз'єднувало через 4–5 с. У blind: немає жодної відповіді на REFER за xferTimeoutMs — кладемо A;
//   REFER прийнято — чекаємо BYE від АТС або фінальний NOTIFY до fallbackRingMs.
import { normPhone } from '../../server/phone.js'

const ok2xx = (c) => Number(c) >= 200 && Number(c) < 300

// Внутрішній дзвінок — тризначний номер БЕЗ X-BINOTEL-GCID: дзвінки зі сценарію (клієнти, у т. ч. короткі
// номери операторів) Binotel завжди позначає GCID, внутрішні з 907 — ні.
export const isInternal = (n, gcid = null) => /^\d{3}$/.test(String(n ?? '').trim()) && !gcid
// Внутрішні — усі (або лише з allowedInternal, якщо список задано); інші — лише з allowedCallers (порівнюємо в E.164).
export function isAllowed(number, allowedCallers = [], { gcid = null, allowedInternal = [] } = {}) {
  const n = String(number ?? '').trim()
  if (isInternal(n, gcid)) return !allowedInternal?.length || allowedInternal.map((x) => String(x).trim()).includes(n)
  const p = normPhone(n)
  return !!p && allowedCallers.map((x) => normPhone(x)).includes(p)
}
export const callerAllowed = (incoming, config) =>
  isAllowed(incoming?.number, config.allowedCallers, { gcid: incoming?.gcid ?? null, allowedInternal: config.allowedInternal || [] })

// Номер стороннього (не пропущеного) абонента в журналі й статусі — лише останні 4 цифри.
export const maskNumber = (n) => {
  const d = String(n ?? '').replace(/\D/g, '')
  return d ? `…${d.slice(-4)}` : null
}

// Мітки кроків у журналі для кожної сторони: менеджер — як і раніше, запасна — з префіксом fb.
const MARKS = {
  manager: { dial: 'dial', ringing: 'managerRinging', answered: 'managerAnswered', ready: 'managerReady', down: 'managerDown', card: 'card', cardDone: 'cardDone', xfer: 'xfer', xferAccepted: 'xferAccepted', xferFinal: 'xferFinal' },
  fallback: { dial: 'fbDial', ringing: 'fbRinging', answered: 'fbAnswered', ready: 'fbReady', down: 'fbDown', card: 'fbCard', cardDone: 'fbCardDone', xfer: 'fbXfer', xferAccepted: 'fbXferAccepted', xferFinal: 'fbXferFinal' },
}
// Рядки статусу (рос.) для кожної сторони
const WHO = {
  manager: { name: 'менеджер', call: 'звоню менеджеру', redial: 'повторный набор менеджера', to: 'менеджеру', noAnswer: 'менеджер не ответил', answered: 'менеджер ответил', with: 'с менеджером', down: 'менеджер положил трубку' },
  fallback: { name: 'запасная линия', call: 'звоню на запасную линию', redial: 'повторный набор запасной линии', to: 'запасной линии', noAnswer: 'запасная линия не ответила', answered: 'запасная линия ответила', with: 'с запасной линией', down: 'запасная линия положила трубку' },
}
// Таймери етапу дзвінка стороні B — скасовуємо всі, коли переходимо до наступної сторони чи до пошти
const STAGE_TIMERS = ['dial', 'ring', 'stageCap', 'graceB', 'tts', 'cardCap', 'afterCard', 'xfer', 'bothDown', 'bridgeCap']
const VM_PROMPT_MAX_MS = 30000 // play_done фрази пошти не прийшов — сигнал усе одно
const VM_BEEP_MAX_MS = 3000
const VM_DONE_WAIT_MS = 3000 // record_done після зупинки запису не прийшов — завершуємо без нього

export function createFlow({ incoming, config, send, clock, lookup = null, buildCard, tts = null, voicemailPath = null, log = () => {}, onDone = () => {}, rejectReason = null }) {
  const A = incoming.call
  const number = String(incoming.number ?? '').trim()
  const internal = isInternal(number, incoming.gcid ?? null)
  const allowed = callerAllowed(incoming, config)
  const phone = internal ? null : normPhone(number) || null
  // Чужий номер (його відхиляємо) у статус і журнал — лише маскою
  const shownNumber = allowed ? phone || number || null : maskNumber(phone || number)
  const who = shownNumber || 'без номера'
  const t0 = clock.now()
  const fallbackMode = config.fallbackMode === 'blind' ? 'blind' : 'consult'
  const targets = {
    manager: { uri: config.managerUri, timeoutSec: config.managerTimeoutSec, prefix: 'mgr' },
    fallback: { uri: config.fallbackUri || '', timeoutSec: config.fallbackTimeoutSec ?? 20, prefix: 'fb' },
  }

  let phase = 'new' // new → dialing → card → transferring → connected | bridged | voicemail | fallback (blind) → done
  let target = 'manager' // кому зараз дзвонимо: manager → fallback
  let stageAt = null // clock.now() першого набору поточної сторони
  let done = false
  let outcome = null
  let reason = null // чому не вийшло з менеджером (або card_cap / bridge_cap на його етапі)
  let fallbackReason = null // те саме для запасної
  let abortReason = null // дзвінок обірвано ззовні: shutdown (зупинка шлюзу) або engine_exit (рушій упав)
  let answeredBy = null
  const marks = {} // крок → мс від вхідного
  const errors = []
  const dials = []
  const dialByCall = new Map() // виклик рушія → запис у dials: код розриву ноги, від якої вже відмовились (487 після CANCEL)
  const retries = { manager: 0, fallback: 0 }
  const bCodes = { manager: null, fallback: null } // код розриву ноги B кожної сторони
  const timers = new Set()
  const legA = { call: A, confirmed: false, media: false, grace: false, down: false, code: null }
  let legB = null
  let pendingRef = null
  const abandoned = new Set() // ref наборів, які вже не потрібні: запізнілий 'dialing' → одразу кладемо
  let greeting = 'none' // none | playing | done
  let holdOn = false
  let cardStarted = false
  let cardPlaying = false
  let cardSource = null
  let fbCardSource = null
  let cardChars = null
  let category = null
  let serviceRequestId = null
  let lookupState = lookup && phone ? 'pending' : 'off'
  let xferCode = null
  let xferFinalCode = null
  let xferAccepted = false // REFER/Replaces прийнято (202 або NOTIFY 1xx)
  let fbAccepted = false // blind: сліпий REFER на запасну прийнято
  let vm = null // голосова пошта: {state: wait|prompt|beep|rec|stopping|done, file, sec, stop, empty}
  let cardP = Promise.resolve(null)
  const tm = {} // іменовані таймери

  const mark = (k) => { if (marks[k] == null) marks[k] = clock.now() - t0 }
  const markT = (k) => mark(MARKS[target][k])
  const W = () => WHO[target]
  const setReason = (why) => { if (target === 'fallback') fallbackReason = why; else reason = why }
  // Підсумок для сторони, що відповіла: connected → connected_fallback, bridged → bridged_fallback тощо
  const won = (base) => (target === 'fallback' ? base.replace(/^(connected|bridged)/, '$1_fallback') : base)
  const err = (where, msg) => { errors.push({ at: clock.now() - t0, where, msg: String(msg ?? '').slice(0, 200) }) }
  const later = (name, ms, fn) => {
    cancel(name)
    const h = clock.setTimeout(() => {
      timers.delete(h)
      if (tm[name] === h) delete tm[name]
      if (!done) fn()
    }, ms)
    timers.add(h)
    tm[name] = h
    return h
  }
  const cancel = (name) => {
    const h = tm[name]
    if (h == null) return
    clock.clearTimeout(h)
    timers.delete(h)
    delete tm[name]
  }
  const say = (msg) => log(`[${who}] ${msg}`)
  const hangup = (call, code) => send(code ? { cmd: 'hangup', call, code } : { cmd: 'hangup', call })
  const bAlive = () => !!legB && !legB.down
  const legReady = (leg) => leg.confirmed && (leg.media || leg.grace)
  // Клієнту вже не граємо привітання/утримання: він з кимось говорить, у пошті або дзвінок скінчився
  const clientBusy = () => phase === 'bridged' || phase === 'connected' || phase === 'voicemail' || phase === 'done'

  // ---------- старт ----------

  function start() {
    if (rejectReason || !allowed) {
      reason = rejectReason || 'not_allowed'
      hangup(A, 486)
      outcome = 'rejected'
      say(rejectReason === 'busy' ? 'отклонён (486): уже идёт максимум звонков' : 'отклонён (486): номера нет в списке разрешённых')
      return finish()
    }
    phase = 'dialing'
    send({ cmd: 'answer', call: A, code: 200 })
    mark('answer')
    say('принят, отвечаю')
    cardP = prepareCard()
    later('dial', config.dialDelayMs, dial)
  }

  // Пошук → текст → синтез. Ніколи не відхиляється: будь-яка помилка → null (тоді genericCardFile або без картки).
  function prepareCard() {
    return (async () => {
      let res = null
      if (lookup && phone) {
        try {
          res = await lookup(phone)
          lookupState = res ? 'ok' : 'none'
        } catch (e) {
          lookupState = 'error'
          err('lookup', e?.message)
        }
        mark('lookupDone')
      }
      let card = null
      try {
        card = buildCard(res, { number, phone })
      } catch (e) {
        err('card', e?.message)
        return null
      }
      category = card?.category ?? null
      serviceRequestId = card?.serviceRequestId ?? null
      cardChars = card?.text ? card.text.length : null
      if (!tts || !card?.text || done) return null // дзвінок уже скінчився — синтез не потрібен
      try {
        const r = await tts(card.text)
        mark('ttsDone')
        return r && r.file ? r : null
      } catch (e) {
        err('tts', e?.message)
        return null
      }
    })()
  }

  // ---------- клієнт: привітання, утримання ----------

  function maybeGreeting() {
    if (greeting !== 'none' || legA.down || !legReady(legA) || clientBusy()) return
    if (!config.greetingFile) {
      greeting = 'done'
      return startHold()
    }
    greeting = 'playing'
    send({ cmd: 'play', call: A, file: config.greetingFile, loop: false, tag: 'greeting' })
    mark('greeting')
  }

  function onGreetingDone() {
    if (greeting === 'done') return
    greeting = 'done'
    mark('greetingDone')
    startHold() // на голосовій пошті утримання вже не вмикається (clientBusy)
    maybeVoicemail() // пошта чекала, поки привітання догра
  }

  function startHold() {
    if (holdOn || legA.down || !config.holdFile || clientBusy()) return
    holdOn = true
    send({ cmd: 'play', call: A, file: config.holdFile, loop: true, tag: 'hold' })
    mark('hold')
  }

  // ---------- набір сторони B (менеджер, потім запасна): повтори, тайм-аут ----------

  function dial() {
    if (phase !== 'dialing' || legA.down) return
    const t = targets[target]
    const attempt = dials.filter((d) => d.to === target).length + 1
    const ref = `${t.prefix}-${A}-${attempt}`
    pendingRef = ref
    legB = null
    dials.push({ to: target, attempt, ref, at: clock.now() - t0, code: null })
    if (attempt === 1) {
      stageAt = clock.now()
      markT('dial')
      later('stageCap', stageCapMs(), () => onRingTimeout('cap'))
    }
    // Час дзвінка цієї спроби — від її INVITE; перший 180/183 цієї ноги починає відлік заново (onBRinging)
    later('ring', t.timeoutSec * 1000, () => onRingTimeout('ring'))
    send({ cmd: 'dial', ref, uri: t.uri })
    say(attempt === 1 ? W().call : `${W().redial} (${attempt})`)
  }

  // Межа всієї сторони від її першого набору: вікно повторів + повний час дзвінка останньої спроби
  const windowMs = () => Math.max(0, Number(config.dialRetryWindowSec) || 0) * 1000
  const stageCapMs = () => windowMs() + targets[target].timeoutSec * 1000

  function onDialing(ev) {
    if (ev.ref !== pendingRef) {
      if (abandoned.has(ev.ref)) hangup(ev.call)
      return
    }
    pendingRef = null
    legB = { call: ev.call, ref: ev.ref, confirmed: false, media: false, grace: false, down: false, ringing: false, code: null }
    const d = dials.find((x) => x.ref === ev.ref)
    if (d) dialByCall.set(ev.call, d)
    if (phase !== 'dialing') hangup(ev.call) // поки набирали, сценарій уже пішов далі
  }

  // B дзвонить (180/183). Тайм-аут сторони рахуємо від цього моменту: повтор після 503 міг початися на 10-й с, а
  // менеджер на Android-софтфоні бере трубку через ~16 с після 180 (живий Binotel 2026-10-17).
  function onBRinging() {
    markT('ringing')
    if (phase !== 'dialing' || legB.ringing) return
    legB.ringing = true
    later('ring', targets[target].timeoutSec * 1000, () => onRingTimeout('ring'))
  }

  // Через скільки повторити набір, або null — повторів більше немає: наступна спроба має початися не пізніше
  // dialRetryWindowSec від першого набору цієї сторони; dialRetries (якщо задано) — ліміт кількості.
  function retryWaitMs() {
    const wait = Math.max(0, Number(config.dialRetryIntervalMs) || 0)
    if (config.dialRetries != null && retries[target] >= config.dialRetries) return null
    const next = clock.now() - stageAt + wait
    if (next > windowMs()) return null
    return wait
  }

  // Набір не вдався до відповіді: повтор (лише 503/408/480 або помилка рушія) чи наступна сторона.
  function dialFailed(code, why) {
    const last = dials[dials.length - 1]
    if (last && last.code == null) last.code = code
    if (phase !== 'dialing') return
    const retryable = why === 'engine' || config.retryCodes.includes(Number(code))
    const wait = retryable ? retryWaitMs() : null
    if (wait != null) {
      retries[target]++
      say(`${W().name}: ${code || why}, повтор через ${wait} мс`)
      later('dial', wait, dial)
      return
    }
    stageFailed(`${target}_${code || why}`)
  }

  // kind: 'ring' — спроба дзвонила timeoutSec без відповіді; 'cap' — вичерпано межу сторони разом із повторами
  function onRingTimeout(kind) {
    if (phase !== 'dialing') return
    say(kind === 'cap'
      ? `${W().noAnswer} за ${Math.round(stageCapMs() / 1000)} с вместе с повторами`
      : `${W().noAnswer} за ${targets[target].timeoutSec} с звонка`)
    stageFailed(`${target}_timeout`)
  }

  function onBConfirmed() {
    if (phase !== 'dialing') return
    legB.confirmed = true
    const last = dials[dials.length - 1]
    if (last) last.code = 200
    phase = 'card'
    cancel('ring')
    cancel('stageCap')
    cancel('dial')
    markT('answered')
    say(W().answered)
    if (!legB.media) {
      const leg = legB
      later('graceB', config.mediaGraceMs, () => { leg.grace = true; maybeCard() })
    }
    maybeCard()
  }

  // ---------- картка на B ----------

  function maybeCard() {
    if (phase !== 'card' || cardStarted || !legB || legB.down || !legReady(legB)) return
    cardStarted = true
    markT('ready')
    const waited = new Promise((resolve) => {
      later('tts', config.ttsWaitMs, () => { err('tts', 'wait timeout'); resolve(null) })
      cardP.then((r) => { cancel('tts'); resolve(r) })
    })
    const leg = legB
    waited.then((r) => {
      if (done || phase !== 'card' || !bAlive() || legB !== leg) return
      const file = r?.file || config.genericCardFile || null
      const src = r?.file ? (r.cached ? 'cache' : 'tts') : file ? 'generic' : 'none'
      if (target === 'fallback') fbCardSource = src
      else cardSource = src
      if (!file) {
        say('карточки нет — сразу перевожу')
        later('afterCard', config.afterCardMs, () => transfer('no_card'))
        return
      }
      cardPlaying = true
      send({ cmd: 'play', call: legB.call, file, loop: false, tag: 'card' })
      markT('card')
      say(`карточка ${W().to} (${src})`)
      later('cardCap', config.cardMaxSec * 1000, () => transfer('card_cap'))
    })
  }

  function onCardDone() {
    if (!cardPlaying) return
    cardPlaying = false
    markT('cardDone')
    cancel('cardCap')
    later('afterCard', config.afterCardMs, () => transfer('card_done'))
  }

  // ---------- переведення ----------

  function transfer(why) {
    if (phase !== 'card') return
    if (legA.down) return clientGone()
    if (!bAlive()) return stageFailed(`${target}_hangup`)
    phase = 'transferring'
    cancel('cardCap')
    cancel('afterCard')
    send({ cmd: 'xfer_replaces', call: A, dest: legB.call })
    markT('xfer')
    if (why === 'card_cap') setReason('card_cap')
    say(`соединяю клиента ${W().with} (REFER/Replaces)`)
    later('xfer', config.xferTimeoutMs, onXferTimeout)
  }

  function onXfer(ev) {
    xferCode = ev.code ?? null
    if (ev.final) xferFinalCode = ev.code ?? null
    if (phase === 'transferring') onReplacesXfer(ev)
    else if (phase === 'fallback') onBlindXfer(ev)
  }

  function onReplacesXfer(ev) {
    if (!ev.final) {
      xferAccepted = true
      markT('xferAccepted')
      return
    }
    cancel('xfer')
    cancel('bothDown')
    markT('xferFinal')
    if (ok2xx(ev.code)) {
      phase = 'connected'
      outcome = won('connected')
      answeredBy = target
      say('соединены, выхожу из звонка')
      if (legA.down && !bAlive()) return finish()
      later('clear', config.xferClearMs, clearLegs)
    } else {
      err('xfer', `${ev.code} ${ev.reason || ''}`.trim())
      say(`перевод не удался (${ev.code}) — соединяю через себя`)
      bridgeOrRecover()
    }
  }

  // Після REFER/Replaces АТС гасить обидві ноги — це успіх, навіть без фінального NOTIFY.
  const unconfirmed = () => {
    outcome = won('connected_unconfirmed')
    answeredBy = target
    finish()
  }

  function onXferTimeout() {
    if (phase !== 'transferring') return
    err('xfer', xferAccepted ? 'no final NOTIFY' : 'timeout')
    if (!legA.down && bAlive()) {
      say('нет ответа на перевод — соединяю через себя')
      return bridgeOrRecover()
    }
    // REFER/Replaces принят, АТС сняла ногу B, а клиент всё ещё на нашей ноге A. При удачном Replaces Binotel
    // кладёт A сразу за B (вживую 2026-10-17 — через 1 мс после NOTIFY 200), а 202/NOTIFY Binotel о переводе на
    // слово верить нельзя. Раз A жива xferTimeoutMs — клиента никуда не перевели: следующая сторона или почта.
    if (xferAccepted && !legA.down) {
      say(`перевод принят, АТС сняла звонок ${W().to}, а клиент всё ещё на линии — перевод не состоялся`)
      return stageFailed(`${target}_xfer_unconfirmed`)
    }
    // REFER/Replaces принят, и АТС уже сняла ногу клиента — так она завершает заменённый диалог после
    // успешного Replaces. Следующая сторона здесь увела бы клиента от того, кто ответил: просто выходим.
    if (xferAccepted) {
      say('перевод принят, итог не пришёл — считаю соединёнными, выхожу из звонка')
      if (bAlive()) hangup(legB.call)
      return unconfirmed()
    }
    if (!legA.down) return stageFailed(`${target}_hangup`)
    if (bAlive()) return clientGone()
    unconfirmed()
  }

  function bridgeOrRecover() {
    if (!legA.down && bAlive()) {
      phase = 'bridged'
      outcome = won('bridged')
      answeredBy = target
      holdOn = false
      send({ cmd: 'bridge', a: A, b: legB.call })
      mark('bridged')
      // Страховка від «вічного» моста: BYE міг загубитися (зник інтернет), а RTP рушій не стежить
      if (config.bridgeMaxMin > 0) {
        later('bridgeCap', config.bridgeMaxMin * 60000, () => {
          setReason('bridge_cap')
          say(`разговор через шлюз дольше ${config.bridgeMaxMin} мин — кладу обе ноги`)
          clearLegs()
        })
      }
      return
    }
    if (legA.down) return clientGone()
    return stageFailed(`${target}_hangup`)
  }

  // ---------- наступна сторона: менеджер → запасна → голосова пошта ----------

  // Поточна сторона не взяла, зайнята, поклала до переведення або повтори вичерпано: кладемо її ногу (чи
  // відмовляємось від набору, що ще йде) і йдемо далі.
  function stageFailed(why) {
    if (done) return
    if (legA.down) return clientGone()
    for (const k of STAGE_TIMERS) cancel(k)
    setReason(why)
    if (pendingRef) {
      abandoned.add(pendingRef)
      pendingRef = null
    }
    if (bAlive()) hangup(legB.call)
    if (target === 'manager' && targets.fallback.uri) {
      if (fallbackMode === 'blind') return blindFallback(why)
      return startFallback(why)
    }
    return startVoicemail(why)
  }

  // Запасна — так само, як менеджер: набір із повторами, картка, REFER/Replaces. Клієнт тим часом на утриманні.
  function startFallback(why) {
    target = 'fallback'
    phase = 'dialing'
    stageAt = null
    cardStarted = false
    cardPlaying = false
    xferAccepted = false
    mark('fallback')
    say(`запасная линия (${why})`)
    dial()
  }

  // Старий шлях (fallbackMode 'blind'): сліпий REFER клієнта на запасну.
  function blindFallback(why) {
    phase = 'fallback'
    outcome = 'fallback'
    send({ cmd: 'xfer', call: A, uri: targets.fallback.uri })
    mark('fallback')
    say(`перевожу на запасную линию вслепую (${why})`)
    later('fallbackXfer', config.xferTimeoutMs, onBlindTimeout) // ни 202, ни NOTIFY — АТС перевод не взяла
  }

  // Сліпий REFER на запасну: 202/NOTIFY 1xx — АТС уже набирає запасну лінію. Фінальний NOTIFY Binotel може
  // надіслати лише після відповіді запасної (так робить pjsua), тому після прийняття чекаємо довше — BYE
  // від АТС (onADown) або фінал до fallbackRingMs. Утримання не зупиняємо: якщо АТС ще тримає клієнта на
  // нашій нозі, краще музика, ніж тиша; якщо вже забрала — звук нікуди не йде.
  function onBlindXfer(ev) {
    if (!ev.final) {
      if (!fbAccepted) {
        fbAccepted = true
        mark('fallbackAccepted')
        say('запасная линия: перевод принят АТС, жду ответа')
        if (config.fallbackRingMs > 0) later('fallbackXfer', config.fallbackRingMs, onBlindTimeout)
      }
      return
    }
    cancel('fallbackXfer')
    mark('fallbackFinal')
    if (ok2xx(ev.code)) {
      say('переведён на запасную линию')
      if (legA.down) return finish()
      later('clear', config.xferClearMs, clearLegs)
    } else {
      err('fallback_xfer', `${ev.code} ${ev.reason || ''}`.trim())
      outcome = 'failed'
      say(`перевод на запасную линию не удался (${ev.code}) — кладу трубку`)
      if (!legA.down) hangup(A)
      finish()
    }
  }

  function onBlindTimeout() {
    if (phase !== 'fallback') return
    if (fbAccepted) {
      err('fallback_xfer', 'no final NOTIFY')
      outcome = 'fallback_unconfirmed'
      say(`запасная линия: нет итога перевода за ${Math.round(config.fallbackRingMs / 1000)} с — кладу трубку`)
    } else {
      err('fallback_xfer', 'timeout')
      outcome = 'failed'
      say('запасная линия: АТС не ответила на перевод — кладу трубку')
    }
    if (!legA.down) hangup(A)
    finish()
  }

  // ---------- голосова пошта ----------

  function startVoicemail(why) {
    phase = 'voicemail'
    if (config.voicemailEnabled === false || config.recordSupported === false || !voicemailPath) {
      err('voicemail', config.recordSupported === false ? 'engine without record' : 'disabled')
      outcome = 'failed'
      say('никто не ответил, голосовая почта недоступна — кладу трубку')
      hangup(A)
      return finish()
    }
    vm = { state: 'wait', file: null, sec: null, stop: null, startedAt: null }
    mark('voicemail')
    say(`никто не ответил (${why}) — голосовая почта`)
    maybeVoicemail()
  }

  // Утримання зупиняємо, далі: фраза → сигнал → запис. Нога A ще не готова — чекаємо. Привітання ще грає (менеджер і
  // запасна відмовили за 1–2 с) — даємо догратися, щоб не обірвати на півслові: onGreetingDone покличе знову;
  // play_done загубився — не довше VM_PROMPT_MAX_MS.
  function maybeVoicemail() {
    if (phase !== 'voicemail' || !vm || vm.state !== 'wait' || legA.down || !legReady(legA)) return
    if (greeting === 'playing') {
      if (tm.vmGreeting == null) later('vmGreeting', VM_PROMPT_MAX_MS, () => { greeting = 'done'; maybeVoicemail() })
      return
    }
    cancel('vmGreeting')
    holdOn = false
    send({ cmd: 'stop', call: A })
    if (!config.voicemailPromptFile) return vmBeep()
    vm.state = 'prompt'
    send({ cmd: 'play', call: A, file: config.voicemailPromptFile, loop: false, tag: 'voicemail' })
    mark('vmPrompt')
    later('vmStep', VM_PROMPT_MAX_MS, vmBeep)
  }

  function vmBeep() {
    if (!vm || (vm.state !== 'wait' && vm.state !== 'prompt')) return
    cancel('vmStep')
    if (!config.beepFile) return vmRecord()
    vm.state = 'beep'
    send({ cmd: 'play', call: A, file: config.beepFile, loop: false, tag: 'beep' })
    mark('vmBeep')
    later('vmStep', VM_BEEP_MAX_MS, vmRecord)
  }

  function vmRecord() {
    if (!vm || (vm.state !== 'wait' && vm.state !== 'prompt' && vm.state !== 'beep')) return
    cancel('vmStep')
    let file = null
    try {
      file = voicemailPath({ gcid: incoming.gcid ?? null, number: phone || number || null })
    } catch (e) {
      err('voicemail', e?.message)
    }
    if (!file) return vmFailed('no file')
    vm.state = 'rec'
    vm.file = file
    vm.startedAt = clock.now()
    send({ cmd: 'record', call: A, file })
    mark('vmRecord')
    say(`записываю сообщение (до ${config.voicemailMaxSec} с)`)
    later('vmMax', config.voicemailMaxSec * 1000, () => vmStop('max'))
  }

  // Зупинка запису: рушій закриває WAV і шле record_done; нога A вже розірвана — рушій зупинив запис сам.
  function vmStop(why) {
    if (!vm || vm.state !== 'rec') return
    cancel('vmMax')
    vm.state = 'stopping'
    vm.stop = why
    if (!legA.down) send({ cmd: 'record_stop', call: A })
    later('vmDone', VM_DONE_WAIT_MS, () => onRecordDone(null))
  }

  function onRecordDone(ev) {
    if (!vm || (vm.state !== 'rec' && vm.state !== 'stopping')) return
    cancel('vmMax')
    cancel('vmDone')
    if (vm.state === 'rec') vm.stop = legA.down ? 'client_hangup' : 'engine' // рушій зупинив запис сам
    vm.state = 'done'
    if (ev && Number.isFinite(Number(ev.sec))) vm.sec = Number(ev.sec)
    else {
      vm.sec = null
      err('voicemail', ev ? 'record_done without sec' : 'no record_done')
    }
    mark('vmDone')
    // Порожньо: клієнт поклав одразу після сигналу (так роблять часто), звук не дійшов до запису або файла немає.
    // Окремий підсумок — щоб пропущений дзвінок не виглядав залишеним повідомленням; файл прибирає gateway.mjs.
    const minSec = config.voicemailMinSec != null && Number.isFinite(Number(config.voicemailMinSec)) ? Number(config.voicemailMinSec) : 1
    vm.empty = !!ev && (ev.missing === true || (vm.sec != null && vm.sec < minSec))
    if (vm.empty) {
      outcome = 'voicemail_empty'
      say(`сообщения нет (${ev.missing ? 'файла нет' : `запись ${vm.sec.toFixed(1)} с`}${vm.stop === 'client_hangup' ? ', клиент положил трубку сразу после сигнала' : ''})`)
    } else {
      outcome = 'voicemail'
      say(`сообщение записано${vm.sec != null ? ` (${vm.sec.toFixed(1)} с)` : ''}`)
    }
    if (!legA.down) hangup(A)
    finish()
  }

  function vmFailed(msg) {
    if (msg) err('voicemail', msg)
    if (vm && vm.state === 'rec') vm.file = null // рушій запис не почав
    if (vm) vm.state = 'done'
    outcome = 'failed'
    say('голосовая почта не удалась — кладу трубку')
    if (!legA.down) hangup(A)
    finish()
  }

  // ---------- завершення ----------

  function clearLegs() {
    if (!legA.down) hangup(A)
    if (bAlive()) hangup(legB.call)
    finish()
  }

  function clientGone() {
    outcome = 'client_hangup'
    if (pendingRef) {
      abandoned.add(pendingRef)
      pendingRef = null
    }
    if (bAlive()) hangup(legB.call)
    say('клиент положил трубку')
    finish()
  }

  // ---------- розрив ніг ----------

  function onADown(code) {
    legA.down = true
    legA.code = code ?? null
    mark('clientDown')
    switch (phase) {
      case 'dialing':
      case 'card':
        return clientGone()
      case 'transferring':
        // АТС після REFER гасить обидві ноги — це не обов'язково клієнт поклав. Чекаємо NOTIFY або тайм-аут.
        if (!bAlive()) later('bothDown', 1000, unconfirmed)
        return
      case 'bridged':
        if (bAlive()) hangup(legB.call)
        say('клиент положил трубку')
        return finish()
      case 'connected':
        if (!bAlive()) finish()
        return
      case 'fallback':
        return finish()
      case 'voicemail':
        // Поклав під час запису — запис зберігаємо: рушій сам закриває файл і шле record_done
        if (vm?.state === 'rec') {
          cancel('vmMax')
          vm.state = 'stopping'
          vm.stop = 'client_hangup'
          say('клиент положил трубку — сохраняю запись')
          later('vmDone', VM_DONE_WAIT_MS, () => onRecordDone(null))
          return
        }
        if (vm?.state === 'stopping') return
        return clientGone()
      default:
    }
  }

  function onBDown(code) {
    legB.down = true
    legB.code = code ?? null
    bCodes[target] = code ?? null
    const d = dialByCall.get(legB.call)
    if (d && d.code == null) d.code = code ?? null
    switch (phase) {
      case 'dialing':
        return dialFailed(code, 'hangup')
      case 'card':
        markT('down')
        say(`${W().down} до перевода`)
        return stageFailed(`${target}_hangup`)
      case 'transferring':
        if (legA.down) later('bothDown', 1000, unconfirmed)
        return
      case 'bridged':
        if (!legA.down) hangup(A)
        say(W().down)
        return finish()
      case 'connected':
        if (legA.down) finish()
        return
      default:
    }
  }

  // ---------- події рушія ----------

  function onError(ev) {
    err(ev.cmd || 'engine', ev.msg)
    switch (ev.cmd) {
      case 'dial':
        if (ev.ref && ev.ref === pendingRef) {
          pendingRef = null
          dialFailed(0, 'engine')
        }
        return
      case 'play':
        if (ev.call === A && phase === 'voicemail' && (vm?.state === 'prompt' || vm?.state === 'beep')) {
          if (vm.state === 'prompt') vmBeep()
          else vmRecord()
        } else if (ev.call === A && greeting === 'playing') onGreetingDone() // пошта, що чекала привітання, піде далі
        else if (legB && ev.call === legB.call && cardPlaying) onCardDone()
        return
      case 'record':
        if (ev.call === A && vm?.state === 'rec') vmFailed(null)
        return
      case 'xfer_replaces':
        if (phase === 'transferring') onXfer({ code: 0, final: true, reason: 'engine error' })
        return
      case 'xfer':
        if (phase === 'fallback') onXfer({ code: 0, final: true, reason: 'engine error' })
        return
      case 'bridge':
        if (phase === 'bridged') {
          outcome = 'failed'
          if (!legA.down) hangup(A)
          if (bAlive()) hangup(legB.call)
          finish()
        }
        return
      default: // record_stop на вже розірвану ногу тощо: record_done прийде від рушія або спрацює vmDone
    }
  }

  function handle(ev) {
    if (!ev || typeof ev !== 'object') return
    if (done) {
      // Запізнілий набір, від якого ми вже відмовились, — одразу кладемо
      if (ev.ev === 'dialing' && (abandoned.has(ev.ref) || ev.ref === pendingRef)) hangup(ev.call)
      return
    }
    const isA = ev.call === A
    const isB = !!legB && ev.call === legB.call
    switch (ev.ev) {
      case 'dialing':
        return onDialing(ev)
      case 'state':
        if (isA) {
          if (ev.state === 'CONFIRMED' && !legA.confirmed) {
            legA.confirmed = true
            mark('clientConfirmed')
            if (!legA.media) later('graceA', config.mediaGraceMs, () => { legA.grace = true; maybeGreeting(); maybeVoicemail() })
            maybeGreeting()
            maybeVoicemail()
          } else if (ev.state === 'DISCONNECTED' && !legA.down) onADown(ev.code)
        } else if (isB && !legB.down) {
          if (ev.state === 'EARLY') onBRinging()
          else if (ev.state === 'CONFIRMED' && !legB.confirmed) onBConfirmed()
          else if (ev.state === 'DISCONNECTED') onBDown(ev.code)
        } else if (ev.state === 'DISCONNECTED' && dialByCall.has(ev.call)) {
          // нога, яку ми вже поклали (тайм-аут, перехід до запасної): лише код у журнал
          const d = dialByCall.get(ev.call)
          if (d.code == null) d.code = ev.code ?? null
          if (bCodes[d.to] == null) bCodes[d.to] = ev.code ?? null
        }
        return
      case 'media':
        if (isA && ev.active) {
          legA.media = true
          cancel('graceA')
          maybeGreeting()
          maybeVoicemail()
        } else if (isB && ev.active) {
          legB.media = true // може прийти й у EARLY (183): картку граємо лише після CONFIRMED
          if (legB.confirmed) cancel('graceB')
          maybeCard()
        }
        return
      case 'play_done':
        if (isA && ev.tag === 'greeting') onGreetingDone()
        else if (isA && ev.tag === 'voicemail') vmBeep()
        else if (isA && ev.tag === 'beep') vmRecord()
        else if (isB && ev.tag === 'card') onCardDone()
        return
      case 'record_done':
        if (isA) onRecordDone(ev)
        return
      case 'xfer':
        if (isA) onXfer(ev)
        return
      case 'error':
        return onError(ev)
      default:
    }
  }

  // Аварійне завершення без команд рушію (рушій упав, вихід шлюзу). Причини по менеджеру й запасній лишаємо як є,
  // чому обірвали — окремо (abortReason).
  function abort(why) {
    if (done) return
    abortReason = why
    if (vm?.file && (vm.state === 'rec' || vm.state === 'stopping')) {
      // Запис уже йшов: файл є (при зупинці шлюзу рушій його закриває, після падіння заголовок лагодить gateway.mjs) —
      // це повідомлення клієнта, а не просто обірваний дзвінок
      if (vm.state === 'rec') vm.stop = 'aborted'
      outcome = 'voicemail'
    } else if (phase !== 'connected') outcome = 'aborted' // переведення вже вдалося — лишаємо connected
    finish()
  }

  function finish() {
    if (done) return
    done = true
    phase = 'done'
    for (const h of timers) clock.clearTimeout(h)
    timers.clear()
    mark('end')
    const entry = {
      v: 2,
      startedAt: new Date(t0).toISOString(),
      endedAt: new Date(clock.now()).toISOString(),
      durationMs: clock.now() - t0,
      gcid: incoming.gcid ?? null,
      number: shownNumber,
      internal,
      outcome,
      reason,
      fallbackReason,
      abortReason,
      answeredBy,
      fallbackMode,
      category,
      serviceRequestId,
      lookup: lookupState === 'pending' ? 'unfinished' : lookupState,
      cardSource,
      fbCardSource,
      cardChars,
      dials: dials.map(({ to, attempt, at, code }) => ({ to, attempt, at, code })),
      retries: retries.manager,
      fallbackRetries: retries.fallback,
      xferCode: xferFinalCode ?? xferCode,
      clientCode: legA.code,
      managerCode: bCodes.manager,
      fallbackCode: bCodes.fallback,
      voicemail: vm && (vm.file || vm.stop) ? { file: vm.file, sec: vm.sec, stop: vm.stop, ...(vm.empty ? { empty: true } : {}) } : null,
      t: { ...marks },
      errors,
    }
    const why = [reason, fallbackReason, abortReason].filter(Boolean).join(', ')
    say(`итог: ${outcome}${why ? ` (${why})` : ''}`)
    onDone(entry)
  }

  return {
    start,
    handle,
    abort,
    get done() { return done },
    get phase() { return phase },
    get target() { return target },
    get callA() { return A },
    get callB() { return legB?.call ?? null },
  }
}

// ---------- диспетчер: події рушія → потрібний сценарій ----------
// Вхідний створює сценарій; 'dialing' прив'язує ногу B за ref; решта — за номером виклику (error без call — за ref).
// Подію для ще невідомого виклику тримаємо недовго: рушій міг повідомити стан B раніше за 'dialing'.
export function createDispatcher({ config, send, clock, lookup = null, buildCard, tts = null, voicemailPath = null, log = () => {}, onDone = () => {} }) {
  const byCall = new Map()
  const byRef = new Map()
  const active = new Set()
  const owned = new Map() // сценарій → {calls, refs}: що прибрати з мап після завершення
  const orphans = new Map() // call → [{ev, at}]
  const ORPHAN_MS = 2000

  // Завершений сценарій ще lateEventsMs відповідає на запізнілі події (напр. 'dialing' набору, від якого відмовились).
  function forget(flow) {
    clock.setTimeout(() => {
      const own = owned.get(flow)
      owned.delete(flow)
      if (!own) return
      for (const c of own.calls) if (byCall.get(c) === flow) byCall.delete(c)
      for (const r of own.refs) if (byRef.get(r) === flow) byRef.delete(r)
    }, config.lateEventsMs)
  }

  function onIncoming(ev) {
    if (byCall.has(ev.call)) return
    const own = { calls: new Set([ev.call]), refs: new Set() }
    let flow = null
    const flowSend = (cmd) => {
      if (cmd.cmd === 'dial' && cmd.ref) {
        byRef.set(cmd.ref, flow)
        own.refs.add(cmd.ref)
      }
      send(cmd)
    }
    flow = createFlow({
      incoming: ev,
      config,
      send: flowSend,
      clock,
      lookup,
      buildCard,
      tts,
      voicemailPath,
      log,
      rejectReason: active.size >= config.maxCalls ? 'busy' : null,
      onDone: (entry) => {
        active.delete(flow)
        forget(flow)
        onDone(entry)
      },
    })
    owned.set(flow, own)
    byCall.set(ev.call, flow)
    active.add(flow)
    flow.start()
  }

  function handle(ev) {
    if (!ev || typeof ev.ev !== 'string') return
    if (ev.ev === 'incoming') return onIncoming(ev)
    if (ev.ev === 'dialing') {
      const flow = byRef.get(ev.ref)
      if (!flow) {
        log(`неизвестный набор ${ev.ref} (звонок ${ev.call}) — кладу`)
        send({ cmd: 'hangup', call: ev.call })
        return
      }
      byCall.set(ev.call, flow)
      owned.get(flow)?.calls.add(ev.call)
      flow.handle(ev)
      const queued = orphans.get(ev.call)
      if (queued) {
        orphans.delete(ev.call)
        for (const q of queued) flow.handle(q.ev)
      }
      return
    }
    let flow = ev.call != null ? byCall.get(ev.call) : null
    if (!flow && ev.ref != null) flow = byRef.get(ev.ref)
    if (flow) return flow.handle(ev)
    if (ev.call != null && ev.ev !== 'error') {
      const now = clock.now()
      const q = (orphans.get(ev.call) || []).filter((x) => now - x.at < ORPHAN_MS)
      q.push({ ev, at: now })
      orphans.set(ev.call, q.slice(-20))
      for (const [c, list] of orphans) if (list.every((x) => now - x.at >= ORPHAN_MS)) orphans.delete(c)
    }
  }

  function abortAll(why) {
    for (const f of [...active]) f.abort(why)
  }

  return { handle, abortAll, get active() { return active.size } }
}

export default createFlow
