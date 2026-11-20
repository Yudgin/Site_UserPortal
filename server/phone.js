// Канонічний телефон для заявок/профілів/оповіщень: +380XXXXXXXXX (один формат, щоб пошук за
// номером і картка клієнта не пропускали заявки). Телефон із 1С приходить ЧИСЛОМ (676181511 —
// втрачено ведучий нуль) або рядком у вільному форматі; сміття (склейка двох номерів тощо) → ''.
export const normPhone = (raw) => {
  const d = String(raw ?? '').replace(/\D/g, '')
  if (!d || d === '0') return ''
  if (d.length === 9) return '+380' + d
  if (d.length === 10 && d.startsWith('0')) return '+38' + d
  if (d.length === 11 && d.startsWith('80')) return '+3' + d
  if (d.length === 12 && d.startsWith('380')) return '+' + d
  if (d.length === 14 && d.startsWith('00380')) return '+' + d.slice(2)
  const m = d.match(/380\d{9}/)
  return m ? '+' + m[0] : ''
}

export default normPhone
