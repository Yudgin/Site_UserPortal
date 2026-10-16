// Сценарій вхідного дзвінка голосового шлюзу — чиста машина станів, без I/O. Усе зовнішнє приходить ззовні:
// send(cmd) — команда рушію, clock {now, setTimeout, clearTimeout}, lookup(phone), buildCard(lookup, {number, phone}),
// tts(text) → {file, cached}, onDone(entry) — запис у журнал, log(msg) — рядок статусу для оператора (рос.).
//
// Нога A — клієнт (вхідний на лінію), нога B — менеджер (наш вихідний на managerUri). Порядок:
//   вхідний A → (не з білого списку і не внутрішній → 486) → answer 200 → привітання → утримання (по колу);
//   паралельно: пошук клієнта → текст картки → синтез; через ~1 с після відповіді — набір менеджера
//   (503/408/480 до відповіді → повтор, до dialRetries разів через 1 с; тиша managerTimeoutSec → запасна лінія);
//   B відповів → картка на B (синтез чекаємо ≤ ttsWaitMs; не вдався — genericCardFile або без картки) →
//   кінець картки + afterCardMs (але не пізніше cardMaxSec від її початку) → xfer_replaces(A, B) →
//   фінальний 2xx — з'єднано (АТС гасить обидві ноги; жива через xferClearMs — кладемо);
//   REFER прийнято (202/NOTIFY 100), а потім АТС поклала B — це теж успіх Replaces (connected_unconfirmed);
//   невдача — локальний міст A↔B (bridged, не довше bridgeMaxMin). A поклав — кладемо B (client_hangup).
//   B поклав або не взяв — сліпе переведення A на fallbackUri (fallback): немає жодної відповіді на REFER
//   за xferTimeoutMs — кладемо A; REFER прийнято — чекаємо BYE від АТС або фінальний NOTIFY до fallbackRingMs.
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

export function createFlow({ incoming, config, send, clock, lookup = null, buildCard, tts = null, log = () => {}, onDone = () => {}, rejectReason = null }) {
  const A = incoming.call
  const number = String(incoming.number ?? '').trim()
  const internal = isInternal(number, incoming.gcid ?? null)
  const allowed = callerAllowed(incoming, config)
  const phone = internal ? null : normPhone(number) || null
  // Чужий номер (його відхиляємо) у статус і журнал — лише маскою
  const shownNumber = allowed ? phone || number || null : maskNumber(phone || number)
  const who = shownNumber || 'без номера'
  const t0 = clock.now()

  let phase = 'new' // new → dialing → card → transferring → connected | bridged | fallback → done
  let done = false
  let outcome = null
  let reason = null
  const marks = {} // крок → мс від вхідного
  const errors = []
  const dials = []
  const timers = new Set()
  const legA = { call: A, confirmed: false, media: false, grace: false, down: false, code: null }
  let legB = null
  let pendingRef = null
  const abandoned = new Set() // ref наборів, які вже не потрібні: запізнілий 'dialing' → одразу кладемо
  let retries = 0
  let greeting = 'none' // none | playing | done
  let holdOn = false
  let cardStarted = false
  let cardPlaying = false
  let cardSource = null
  let cardChars = null
  let category = null
  let serviceRequestId = null
  let lookupState = lookup && phone ? 'pending' : 'off'
  let xferCode = null
  let xferFinalCode = null
  let xferAccepted = false // REFER/Replaces прийнято (202 або NOTIFY 1xx)
  let fbAccepted = false // сліпий REFER на запасну прийнято
  let cardP = Promise.resolve(null)
  const tm = {} // іменовані таймери

  const mark = (k) => { if (marks[k] == null) marks[k] = clock.now() - t0 }
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
    if (greeting !== 'none' || legA.down || !legReady(legA)) return
    if (phase === 'bridged' || phase === 'connected' || phase === 'done') return
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
    startHold()
  }

  function startHold() {
    if (holdOn || legA.down || !config.holdFile) return
    if (phase === 'bridged' || phase === 'connected' || phase === 'done') return
    holdOn = true
    send({ cmd: 'play', call: A, file: config.holdFile, loop: true, tag: 'hold' })
    mark('hold')
  }

  // ---------- менеджер: набір, повтори, тайм-аут ----------

  function dial() {
    if (phase !== 'dialing' || legA.down) return
    const attempt = dials.length + 1
    const ref = `mgr-${A}-${attempt}`
    pendingRef = ref
    legB = null
    dials.push({ attempt, ref, at: clock.now() - t0, code: null })
    if (attempt === 1) {
      mark('dial')
      later('manager', config.managerTimeoutSec * 1000, onManagerTimeout)
    }
    send({ cmd: 'dial', ref, uri: config.managerUri })
    say(attempt === 1 ? 'звоню менеджеру' : `повторный набор менеджера (${attempt})`)
  }

  function onDialing(ev) {
    if (ev.ref !== pendingRef) {
      if (abandoned.has(ev.ref)) hangup(ev.call)
      return
    }
    pendingRef = null
    legB = { call: ev.call, ref: ev.ref, confirmed: false, media: false, grace: false, down: false, code: null }
    if (phase !== 'dialing') hangup(ev.call) // поки набирали, сценарій уже пішов далі
  }

  // Набір не вдався до відповіді: повтор (лише 503/408/480 або помилка рушія) чи запасна лінія.
  function dialFailed(code, why) {
    const last = dials[dials.length - 1]
    if (last && last.code == null) last.code = code
    if (phase !== 'dialing') return
    const retryable = why === 'engine' || config.retryCodes.includes(Number(code))
    if (retryable && retries < config.dialRetries) {
      retries++
      say(`менеджер: ${code || why}, повтор через ${config.dialRetryDelayMs} мс`)
      later('dial', config.dialRetryDelayMs, dial)
      return
    }
    fallback(code ? `manager_${code}` : `manager_${why}`)
  }

  function onManagerTimeout() {
    if (phase !== 'dialing') return
    say(`менеджер не ответил за ${config.managerTimeoutSec} с`)
    fallback('manager_timeout')
  }

  function onBConfirmed() {
    if (phase !== 'dialing') return
    legB.confirmed = true
    const last = dials[dials.length - 1]
    if (last) last.code = 200
    phase = 'card'
    cancel('manager')
    cancel('dial')
    mark('managerAnswered')
    say('менеджер ответил')
    if (!legB.media) later('graceB', config.mediaGraceMs, () => { if (legB) { legB.grace = true; maybeCard() } })
    maybeCard()
  }

  // ---------- картка на B ----------

  function maybeCard() {
    if (phase !== 'card' || cardStarted || !legB || legB.down || !legReady(legB)) return
    cardStarted = true
    mark('managerReady')
    const waited = new Promise((resolve) => {
      later('tts', config.ttsWaitMs, () => { err('tts', 'wait timeout'); resolve(null) })
      cardP.then((r) => { cancel('tts'); resolve(r) })
    })
    waited.then((r) => {
      if (done || phase !== 'card' || !bAlive()) return
      const file = r?.file || config.genericCardFile || null
      cardSource = r?.file ? (r.cached ? 'cache' : 'tts') : file ? 'generic' : 'none'
      if (!file) {
        say('карточки нет — сразу перевожу')
        later('afterCard', config.afterCardMs, () => transfer('no_card'))
        return
      }
      cardPlaying = true
      send({ cmd: 'play', call: legB.call, file, loop: false, tag: 'card' })
      mark('card')
      say(`карточка менеджеру (${cardSource})`)
      later('cardCap', config.cardMaxSec * 1000, () => transfer('card_cap'))
    })
  }

  function onCardDone() {
    if (!cardPlaying) return
    cardPlaying = false
    mark('cardDone')
    cancel('cardCap')
    later('afterCard', config.afterCardMs, () => transfer('card_done'))
  }

  // ---------- переведення ----------

  function transfer(why) {
    if (phase !== 'card') return
    if (legA.down) return clientGone()
    if (!bAlive()) return fallback('manager_hangup')
    phase = 'transferring'
    cancel('cardCap')
    cancel('afterCard')
    send({ cmd: 'xfer_replaces', call: A, dest: legB.call })
    mark('xfer')
    if (why === 'card_cap') reason = 'card_cap'
    say('соединяю клиента с менеджером (REFER/Replaces)')
    later('xfer', config.xferTimeoutMs, onXferTimeout)
  }

  function onXfer(ev) {
    xferCode = ev.code ?? null
    if (ev.final) xferFinalCode = ev.code ?? null
    if (phase === 'transferring') onReplacesXfer(ev)
    else if (phase === 'fallback') onFallbackXfer(ev)
  }

  function onReplacesXfer(ev) {
    if (!ev.final) {
      xferAccepted = true
      mark('xferAccepted')
      return
    }
    cancel('xfer')
    cancel('bothDown')
    mark('xferFinal')
    if (ok2xx(ev.code)) {
      phase = 'connected'
      outcome = 'connected'
      say('соединены, выхожу из звонка')
      if (legA.down && !bAlive()) return finish()
      later('clear', config.xferClearMs, clearLegs)
    } else {
      err('xfer', `${ev.code} ${ev.reason || ''}`.trim())
      say(`перевод не удался (${ev.code}) — соединяю через себя`)
      bridgeOrRecover()
    }
  }

  // Сліпий REFER на запасну: 202/NOTIFY 1xx — АТС уже набирає запасну лінію. Фінальний NOTIFY Binotel може
  // надіслати лише після відповіді запасної (так робить pjsua), тому після прийняття чекаємо довше — BYE
  // від АТС (onADown) або фінал до fallbackRingMs. Утримання не зупиняємо: якщо АТС ще тримає клієнта на
  // нашій нозі, краще музика, ніж тиша; якщо вже забрала — звук нікуди не йде.
  function onFallbackXfer(ev) {
    if (!ev.final) {
      if (!fbAccepted) {
        fbAccepted = true
        mark('fallbackAccepted')
        say('запасная линия: перевод принят АТС, жду ответа')
        if (config.fallbackRingMs > 0) later('fallbackXfer', config.fallbackRingMs, onFallbackTimeout)
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

  function onFallbackTimeout() {
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

  function onXferTimeout() {
    if (phase !== 'transferring') return
    err('xfer', xferAccepted ? 'no final NOTIFY' : 'timeout')
    if (!legA.down && bAlive()) {
      say('нет ответа на перевод — соединяю через себя')
      return bridgeOrRecover()
    }
    // REFER/Replaces принят, и АТС уже сняла одну из ног — так она завершает заменённый диалог после
    // успешного Replaces. Запасная линия здесь увела бы клиента от менеджера: просто выходим.
    if (xferAccepted) {
      outcome = 'connected_unconfirmed'
      say('перевод принят, итог не пришёл — считаю соединёнными, выхожу из звонка')
      if (!legA.down) hangup(A)
      if (bAlive()) hangup(legB.call)
      return finish()
    }
    if (!legA.down) return fallback('manager_hangup')
    if (bAlive()) return clientGone()
    outcome = 'connected_unconfirmed'
    finish()
  }

  function bridgeOrRecover() {
    if (!legA.down && bAlive()) {
      phase = 'bridged'
      outcome = 'bridged'
      holdOn = false
      send({ cmd: 'bridge', a: A, b: legB.call })
      mark('bridged')
      // Страховка від «вічного» моста: BYE міг загубитися (зник інтернет), а RTP рушій не стежить
      if (config.bridgeMaxMin > 0) {
        later('bridgeCap', config.bridgeMaxMin * 60000, () => {
          reason = 'bridge_cap'
          say(`разговор через шлюз дольше ${config.bridgeMaxMin} мин — кладу обе ноги`)
          clearLegs()
        })
      }
      return
    }
    if (legA.down) return clientGone()
    return fallback('manager_hangup')
  }

  // Запасна лінія: кладемо B (або відмовляємось від набору, що ще йде) і сліпо переводимо A.
  function fallback(why) {
    if (done) return
    if (legA.down) return clientGone()
    for (const k of ['dial', 'manager', 'graceB', 'tts', 'cardCap', 'afterCard', 'xfer', 'bothDown', 'bridgeCap']) cancel(k)
    phase = 'fallback'
    outcome = 'fallback'
    reason = why
    if (pendingRef) {
      abandoned.add(pendingRef)
      pendingRef = null
    }
    if (bAlive()) hangup(legB.call)
    send({ cmd: 'xfer', call: A, uri: config.fallbackUri })
    mark('fallback')
    say(`перевожу на запасную линию (${why})`)
    later('fallbackXfer', config.xferTimeoutMs, onFallbackTimeout) // ни 202, ни NOTIFY — АТС перевод не взяла
  }

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
        if (!bAlive()) later('bothDown', 1000, () => { outcome = 'connected_unconfirmed'; finish() })
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
      default:
    }
  }

  function onBDown(code) {
    legB.down = true
    legB.code = code ?? null
    switch (phase) {
      case 'dialing':
        return dialFailed(code, 'hangup')
      case 'card':
        mark('managerDown')
        say('менеджер положил трубку до перевода')
        return fallback('manager_hangup')
      case 'transferring':
        if (legA.down) later('bothDown', 1000, () => { outcome = 'connected_unconfirmed'; finish() })
        return
      case 'bridged':
        if (!legA.down) hangup(A)
        say('менеджер положил трубку')
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
        if (ev.call === A && greeting === 'playing') onGreetingDone()
        else if (legB && ev.call === legB.call && cardPlaying) onCardDone()
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
      default:
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
            if (!legA.media) later('graceA', config.mediaGraceMs, () => { legA.grace = true; maybeGreeting() })
            maybeGreeting()
          } else if (ev.state === 'DISCONNECTED' && !legA.down) onADown(ev.code)
        } else if (isB && !legB.down) {
          if (ev.state === 'EARLY') mark('managerRinging')
          else if (ev.state === 'CONFIRMED' && !legB.confirmed) onBConfirmed()
          else if (ev.state === 'DISCONNECTED') onBDown(ev.code)
        }
        return
      case 'media':
        if (isA && ev.active) {
          legA.media = true
          cancel('graceA')
          maybeGreeting()
        } else if (isB && ev.active) {
          legB.media = true // може прийти й у EARLY (183): картку граємо лише після CONFIRMED
          if (legB.confirmed) cancel('graceB')
          maybeCard()
        }
        return
      case 'play_done':
        if (isA && ev.tag === 'greeting') onGreetingDone()
        else if (isB && ev.tag === 'card') onCardDone()
        return
      case 'xfer':
        if (isA) onXfer(ev)
        return
      case 'error':
        return onError(ev)
      default:
    }
  }

  // Аварійне завершення без команд рушію (рушій упав, вихід шлюзу).
  function abort(why) {
    if (done) return
    if (phase !== 'connected') outcome = 'aborted' // переведення вже вдалося — лишаємо connected
    reason = why
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
      v: 1,
      startedAt: new Date(t0).toISOString(),
      endedAt: new Date(clock.now()).toISOString(),
      durationMs: clock.now() - t0,
      gcid: incoming.gcid ?? null,
      number: shownNumber,
      internal,
      outcome,
      reason,
      category,
      serviceRequestId,
      lookup: lookupState === 'pending' ? 'unfinished' : lookupState,
      cardSource,
      cardChars,
      dials: dials.map(({ attempt, at, code }) => ({ attempt, at, code })),
      retries,
      xferCode: xferFinalCode ?? xferCode,
      clientCode: legA.code,
      managerCode: legB?.code ?? null,
      t: { ...marks },
      errors,
    }
    say(`итог: ${outcome}${reason ? ` (${reason})` : ''}`)
    onDone(entry)
  }

  return {
    start,
    handle,
    abort,
    get done() { return done },
    get phase() { return phase },
    get callA() { return A },
    get callB() { return legB?.call ?? null },
  }
}

// ---------- диспетчер: події рушія → потрібний сценарій ----------
// Вхідний створює сценарій; 'dialing' прив'язує ногу B за ref; решта — за номером виклику (error без call — за ref).
// Подію для ще невідомого виклику тримаємо недовго: рушій міг повідомити стан B раніше за 'dialing'.
export function createDispatcher({ config, send, clock, lookup = null, buildCard, tts = null, log = () => {}, onDone = () => {} }) {
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
