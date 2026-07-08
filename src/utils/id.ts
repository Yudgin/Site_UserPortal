// Криптостойкий идентификатор для непубличных ссылок (чат-сессии, сметы).
// Заменяет Math.random(): при доступе-по-знанию-id важна неугадываемость.
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

export const secureId = (len = 16): string => {
  const cryptoObj = typeof crypto !== 'undefined' ? crypto : undefined
  if (cryptoObj?.getRandomValues) {
    const arr = new Uint32Array(len)
    cryptoObj.getRandomValues(arr)
    let s = ''
    for (let i = 0; i < len; i++) s += CHARS[arr[i] % CHARS.length]
    return s
  }
  // Fallback (например, тесты в node без web crypto) — менее стойкий, но рабочий
  let s = ''
  for (let i = 0; i < len; i++) s += CHARS[Math.floor(Math.random() * CHARS.length)]
  return s
}
