// Нормализация телефона к каноническому виду (цифры, украинский формат).
// Нужна как ключ профиля клиента: разные записи одного номера дают один ключ →
// профили сливаются автоматически.
//   0671234567  → 380671234567
//   671234567   → 380671234567
//   +380 67 123 45 67 → 380671234567
export const normalizePhone = (raw: string | null | undefined): string => {
  let d = (raw || '').replace(/\D/g, '')
  if (!d) return ''
  if (d.length === 10 && d.startsWith('0')) d = '38' + d
  else if (d.length === 9) d = '380' + d
  return d
}

// Для отображения: +380 67 123 45 67
export const formatPhone = (raw: string | null | undefined): string => {
  const d = normalizePhone(raw)
  if (d.length === 12 && d.startsWith('380')) {
    return `+380 ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8, 10)} ${d.slice(10)}`
  }
  return raw?.trim() || ''
}
