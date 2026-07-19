// Разбор пользовательского ввода времени напоминания.
// Поддерживаемые формы в начале строки: «30м», «30 мин», «45 минут», «2ч», «2 часа»,
// «завтра», «завтра HH:MM», «сегодня HH:MM», «HH:MM», «DD.MM HH:MM».

const MINUTES_RE = /^(\d{1,4})\s*(?:минут[ыау]?|мин|м)(?=[\s.,!]|$)/i;
const HOURS_RE = /^(\d{1,3})\s*(?:час(?:а|ов)?|ч)(?=[\s.,!]|$)/i;
const TOMORROW_RE = /^завтра(?:\s+(\d{1,2}):(\d{2}))?(?=\s|$)/i;
const TODAY_RE = /^сегодня\s+(\d{1,2}):(\d{2})(?=\s|$)/i;
const DATE_TIME_RE = /^(\d{1,2})\.(\d{1,2})\s+(\d{1,2}):(\d{2})(?=\s|$)/;
const TIME_RE = /^(\d{1,2}):(\d{2})(?=\s|$)/;

function isValidTime(hours: number, minutes: number): boolean {
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

function restAsText(input: string, matchedLength: number): string {
  const rest = input.slice(matchedLength).trim();
  return rest !== '' ? rest : 'Напоминание';
}

export function parseReminderInput(
  input: string,
  now: Date,
): { dueAt: Date; text: string } | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;

  let m = MINUTES_RE.exec(trimmed);
  if (m) {
    const minutes = Number(m[1]);
    if (minutes <= 0) return null;
    return {
      dueAt: new Date(now.getTime() + minutes * 60_000),
      text: restAsText(trimmed, m[0].length),
    };
  }

  m = HOURS_RE.exec(trimmed);
  if (m) {
    const hours = Number(m[1]);
    if (hours <= 0) return null;
    return {
      dueAt: new Date(now.getTime() + hours * 3_600_000),
      text: restAsText(trimmed, m[0].length),
    };
  }

  m = TOMORROW_RE.exec(trimmed);
  if (m) {
    const hours = m[1] !== undefined ? Number(m[1]) : 9;
    const minutes = m[2] !== undefined ? Number(m[2]) : 0;
    if (!isValidTime(hours, minutes)) return null;
    const dueAt = new Date(now);
    dueAt.setDate(dueAt.getDate() + 1);
    dueAt.setHours(hours, minutes, 0, 0);
    return { dueAt, text: restAsText(trimmed, m[0].length) };
  }

  m = TODAY_RE.exec(trimmed);
  if (m) {
    const hours = Number(m[1]);
    const minutes = Number(m[2]);
    if (!isValidTime(hours, minutes)) return null;
    const dueAt = new Date(now);
    dueAt.setHours(hours, minutes, 0, 0);
    return { dueAt, text: restAsText(trimmed, m[0].length) };
  }

  m = DATE_TIME_RE.exec(trimmed);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    const hours = Number(m[3]);
    const minutes = Number(m[4]);
    if (month < 1 || month > 12 || !isValidTime(hours, minutes)) return null;
    let dueAt = new Date(now.getFullYear(), month - 1, day, hours, minutes, 0, 0);
    // Date нормализует переполнение дней (31.02 -> 03.03) — отвергаем такой ввод.
    if (dueAt.getDate() !== day || dueAt.getMonth() !== month - 1) return null;
    if (dueAt.getTime() <= now.getTime()) {
      dueAt = new Date(now.getFullYear() + 1, month - 1, day, hours, minutes, 0, 0);
      if (dueAt.getDate() !== day || dueAt.getMonth() !== month - 1) return null;
    }
    return { dueAt, text: restAsText(trimmed, m[0].length) };
  }

  m = TIME_RE.exec(trimmed);
  if (m) {
    const hours = Number(m[1]);
    const minutes = Number(m[2]);
    if (!isValidTime(hours, minutes)) return null;
    const dueAt = new Date(now);
    dueAt.setHours(hours, minutes, 0, 0);
    if (dueAt.getTime() <= now.getTime()) {
      dueAt.setDate(dueAt.getDate() + 1);
    }
    return { dueAt, text: restAsText(trimmed, m[0].length) };
  }

  return null;
}
