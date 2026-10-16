// Час подій статусу заявки serviceRequests. Читач — lastActivityMs у binotelWebhook.js: правило doneGraceDays
// (виконаний ремонт ще 14 днів веде дзвінок клієнта у сценарій «Відкрита заявка» — «де мій кораблик»).
// updatedAt для цього не годиться — його освіжають масові синхронізації 1С і бекфіли.
//   statusChangedAt — при справжній зміні статусу (той самий статус повторно нічого не ставить);
//   doneAt          — при переході в 'done';
//   paidAt          — коли гроші прийшли (лише payments.js), окремо від статусу.
// Імпорт (синк 1С, BoatImportPage) часу не ставить: статус там виведений, а не змінений людиною чи оплатою.
export const statusTimes = (prevStatus, nextStatus, now = new Date().toISOString()) => {
  if (!nextStatus || nextStatus === prevStatus) return {}
  return nextStatus === 'done' ? { statusChangedAt: now, doneAt: now } : { statusChangedAt: now }
}

// Патч заявки, коли оплата по її кошторису пройшла (payments.markEstimatePaid). Статус → 'done', але
// скасовану НЕ «воскрешаємо». paidAt — час першого підтвердження: повторний виклик (помилка Checkbox,
// потім reconcile) його не зсуває. cur — поточні дані заявки ({} якщо документа немає).
export const paidRequestPatch = (cur, orderId, now = new Date().toISOString()) => {
  const c = cur || {}
  const p = { paymentId: orderId, updatedAt: now }
  if (!c.paidAt) p.paidAt = now
  if (c.status !== 'cancelled') Object.assign(p, { status: 'done' }, statusTimes(c.status, 'done', now))
  return p
}

export default statusTimes
