// Парсер выгрузок 1С6 в формате MOXCEL (.mxl). Табличный документ хранит клетки потоком:
// заполненная — {16,N,{1,1,{"#","VALUE"}},0}, пустая — {16,N,{1,0},0}. Каждая строка содержит
// ровно ncols клеток (включая пустые), поэтому поток режется на строки по числу колонок,
// а число колонок определяем по известному заголовку (продажи 12, ремонты 10).

export type MxlKind = 'sales' | 'repairs'

export interface MxlTable {
  kind: MxlKind
  header: string[]
  rows: string[][]
}

// Ключевые заголовки для распознавания типа выгрузки.
const SALES_MARKERS = ['Модель', 'Сумка', 'Глубиномер']
const REPAIRS_MARKERS = ['ТТН к нам', 'Сервисный центр']

const CELL_RE = /\{16,\d+,\s*(?:\{1,1,\s*\{"#","((?:[^"]|"(?!\s*\}))*?)"\s*\}\s*\},0\}|\{1,0\},0\})/g

export const parseMxl = (text: string): MxlTable => {
  const cells: string[] = []
  let m: RegExpExecArray | null
  CELL_RE.lastIndex = 0
  while ((m = CELL_RE.exec(text)) !== null) cells.push(m[1] !== undefined ? m[1] : '')
  if (cells.length < 10) throw new Error('Не схоже на вигрузку 1С6 (.mxl): клітинки не знайдені')

  const head12 = cells.slice(0, 12)
  const head10 = cells.slice(0, 10)
  let kind: MxlKind
  let ncols: number
  if (SALES_MARKERS.every((h) => head12.includes(h))) {
    kind = 'sales'; ncols = 12
  } else if (REPAIRS_MARKERS.every((h) => head10.includes(h))) {
    kind = 'repairs'; ncols = 10
  } else {
    throw new Error(`Невідомий формат вигрузки. Перші колонки: ${head12.filter(Boolean).join(', ')}`)
  }
  if (cells.length % ncols !== 0) {
    throw new Error(`Кількість клітинок (${cells.length}) не ділиться на ${ncols} колонок — формат змінився?`)
  }
  const header = cells.slice(0, ncols)
  const rows: string[][] = []
  for (let i = ncols; i < cells.length; i += ncols) rows.push(cells.slice(i, i + ncols))
  return { kind, header, rows }
}

// «067 577 7105» / «+38(098)242-80-34» / «0939174462» → +380XXXXXXXXX ('' если не похоже).
export const mxlPhone = (s: string): string => {
  const d = String(s || '').replace(/\D/g, '')
  if (d.length === 9) return '+380' + d
  if (d.length === 10 && d.startsWith('0')) return '+38' + d
  if (d.length === 11 && d.startsWith('80')) return '+3' + d
  if (d.length === 12 && d.startsWith('380')) return '+' + d
  return ''
}

// ТТН «20 451 177 278 500» (с неразрывными пробелами) → «20451177278500».
export const mxlTtn = (s: string): string => String(s || '').replace(/\D/g, '')

// «05.06.2025 14:46:59» → ISO. Некорректная дата → null.
export const mxlDate = (s: string): string | null => {
  const m = String(s || '').match(/(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/)
  if (!m) return null
  const iso = `${m[3]}-${m[2]}-${m[1]}T${m[4] || '00'}:${m[5] || '00'}:${m[6] || '00'}`
  return Number.isNaN(Date.parse(iso)) ? null : new Date(iso).toISOString()
}

// Вычистить телефоны/цифры из freetext-имени («0675777105 Губін Владислав» → «Губін Владислав»).
export const mxlCleanName = (s: string): string =>
  String(s || '')
    .replace(/\+?\d[\d\s()\- ]{6,}\d/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
