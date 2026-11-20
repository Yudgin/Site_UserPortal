// Режими ШІ-помічника /api/ai/improve-text.
//   default — редактор тексту, як і був: claude-opus-4-8, effort low (публічні форми сайту + чипи застосунку
//             «Структурувати / Коротко для клієнта / Виправити помилки / Свій запит»).
//   expand  — «Розгорнути для клієнта» (рішення власника 2026-10-15): майстер надиктував 1–2 речення, модель
//             пише повний текст діагностики для картки заявки. Поточний Opus із глибшим мисленням
//             (claude-opus-5-5: мислення завжди увімкнене, глибина — output_config.effort; $4/$20 за млн).
// Моделі/глибину можна перевизначити env AI_EXPAND_MODEL / AI_EXPAND_EFFORT без правки коду.
export const DEFAULT_MODEL = 'claude-opus-4-8'
export const EXPAND_MODEL = process.env.AI_EXPAND_MODEL || 'claude-opus-5-5'
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
export const EXPAND_EFFORT = EFFORTS.has(process.env.AI_EXPAND_EFFORT) ? process.env.AI_EXPAND_EFFORT : 'high'

// Тарифи $/млн токенів (Claude API, 2026-10): для обліку вартості у відповіді.
export const MODEL_PRICES = {
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
}

export const AI_MODES = {
  default: { model: DEFAULT_MODEL, effort: 'low', maxTokens: 4096 },
  expand: { model: EXPAND_MODEL, effort: EXPAND_EFFORT, maxTokens: 8192 },
}

export const resolveAiMode = (body = {}) => {
  const name = AI_MODES[String(body?.mode || '')] ? String(body.mode) : 'default'
  return { name, ...AI_MODES[name] }
}

// Системна інструкція режиму expand. contextNote — опис типу тексту (AI_CONTEXTS[context]).
export const expandSystem = (contextNote) => [
  'Ти — майстер-консультант сервісного центру RunFerry (ремонт прикормочних рибальських корабликів).',
  contextNote,
  'Майстер надиктував короткі нотатки. Напиши на їх основі повний, зрозумілий текст для клієнта, який побачить його у картці заявки.',
  'Пиши завжди УКРАЇНСЬКОЮ мовою, навіть якщо нотатки російською або суржиком (вимога законодавства України).',
  'Для кожної несправності поясни простими словами: що саме виявлено, як це впливає на роботу кораблика, що потрібно зробити для усунення.',
  'Справні вузли, якщо вони згадані, коротко підтверди. Додай доречні рекомендації з експлуатації, якщо вони логічно випливають.',
  'Тон — діловий і доброзичливий, для людини без технічної освіти. Обсяг — 4–10 речень або короткий нумерований список.',
  'Не вигадуй несправностей, цифр, цін і строків, яких немає в нотатках; те, чого майстер не перевіряв, не додавай.',
  'Без звертання, привітання, підпису і без markdown — лише готовий текст, який піде в поле «Діагностика».',
].join('\n')

export const expandUserContent = ({ currentText = '', userPrompt = '', reference = '' }) => [
  reference ? `Довідка по заявці (скарга клієнта, кораблик) — спирайся, але не копіюй дослівно:\n"""\n${reference}\n"""\n` : '',
  `Нотатки майстра:\n"""\n${currentText}\n"""\n`,
  userPrompt && userPrompt.trim() ? `Побажання майстра до тексту: ${userPrompt.trim()}` : '',
].filter(Boolean).join('\n')

export default resolveAiMode
