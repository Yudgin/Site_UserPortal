// Службові теги голосу — лише латиниця у квадратних дужках. Звичайний текст, цифри та кирилиця лишаються;
// слова клієнта ніколи не очищаємо. Чисті функції без I/O — захист на кожній межі збереження, без зміни вхідних даних.
const VOICE_TAG = /\[[A-Za-z][A-Za-z _-]{0,40}\]/
export function stripVoiceTags(value) {
  const text = String(value ?? '')
  if (!VOICE_TAG.test(text)) return text
  return text.replace(/\s*\[[A-Za-z][A-Za-z _-]{0,40}\]\s*/g, ' ')
    .replace(/\s+([.,!?;:…])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

export const cleanAiNote = (note) => note && typeof note === 'object'
  ? { ...note, ...(typeof note.question === 'string' ? { question: stripVoiceTags(note.question) } : {}) }
  : note

const aiTurn = (turn) => turn?.speaker === 'ai' || turn?.speaker === 'assistant' || turn?.role === 'assistant'
const cleanSummary = (summary) => typeof summary === 'string' ? stripVoiceTags(summary)
  : summary && typeof summary === 'object' ? { ...summary, ...(typeof summary.text === 'string' ? { text: stripVoiceTags(summary.text) } : {}) } : summary

export function cleanAiTranscript(record) {
  if (!record || typeof record !== 'object') return record
  return {
    ...record,
    ...(Array.isArray(record.turns) ? { turns: record.turns
      .map((turn) => aiTurn(turn) ? { ...turn, text: stripVoiceTags(turn.text) } : turn)
      .filter((turn) => !aiTurn(turn) || turn.text) } : {}),
    ...(record.note !== undefined ? { note: cleanAiNote(record.note) } : {}),
    ...(record.summary !== undefined ? { summary: cleanSummary(record.summary) } : {}),
    ...(Array.isArray(record.sessions) ? { sessions: record.sessions.map(cleanAiTranscript) } : {}),
  }
}

// Зазвичай журнал містить лише лічильники реплік. Якщо викликач передав і розшифровку/питання, очищаємо й їх;
// решту журналу не чіпаємо, зокрема текст клієнта й звичайні службові рядки.
export function cleanAiJournal(entry) {
  if (!entry || typeof entry !== 'object') return entry
  return {
    ...entry,
    ...(entry.aiTranscript !== undefined ? { aiTranscript: cleanAiTranscript(entry.aiTranscript) } : {}),
    ...(entry.ai !== undefined ? { ai: cleanAiTranscript(entry.ai) } : {}),
    ...(entry.kind === 'ai' && entry.transcript !== undefined ? { transcript: cleanAiTranscript(entry.transcript) } : {}),
    ...(entry.kind === 'ai' && entry.summary !== undefined ? { summary: cleanSummary(entry.summary) } : {}),
  }
}
