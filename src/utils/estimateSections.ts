// Разрезы калькуляции ПО ТРЕБОВАНИЯМ клиента. Одна калькуляция может содержать несколько
// требований (напр. «Встановлення ехолота» — апгрейд, «Ремонт керма» — ремонт), у каждого свои
// работы/наборы и своё направление. Движок (buildMultiEstimate) собирает такие секции; здесь —
// маппинг для РЕДАКТОРА (загрузка секций из сметы, сборка в ComplaintSection) и ГРУППИРОВКА
// результата по секциям для показа мастеру и клиенту.
import { COMMON_SECTION_LABEL, type ComplaintSection, type PriceCatalog } from '@/utils/pricing'
import type { Estimate, ServiceKind } from '@/types/pricing'

export interface EditableWorkRow { key: string; workId: string; qty: number }
export interface EditableSection { key: string; complaint: string; serviceKind: ServiceKind; rows: EditableWorkRow[] }

let seq = 0
const nextKey = (p: string) => `${p}${(seq += 1)}`

export const newSection = (serviceKind: ServiceKind = 'repair'): EditableSection =>
  ({ key: nextKey('sec'), complaint: '', serviceKind, rows: [] })

// Загрузить редактируемые секции-требования из сметы. Мульти-сметы (sections[] + complaintIndex)
// раскладываем по секциям (кроме авто-секции общих работ). Старые плоские — одной секцией.
export function estimateToSections(est: Estimate, catalog: PriceCatalog): EditableSection[] {
  const refs = est.sections
  const laborInCi = (ci: number): EditableWorkRow[] =>
    (est.lines || [])
      .filter((l) => l.type === 'labor' && (l.complaintIndex ?? 0) === ci && catalog.works[l.refId])
      .map((l) => ({ key: nextKey('w'), workId: l.refId, qty: l.qty }))

  if (refs && refs.length) {
    const out: EditableSection[] = []
    refs.forEach((ref, i) => {
      if (ref.complaint === COMMON_SECTION_LABEL) return // авто-секция общих работ — не редактируем
      const rows = laborInCi(i)
      if (rows.length) out.push({ key: nextKey('sec'), complaint: ref.complaint || '', serviceKind: ref.serviceKind || 'repair', rows })
    })
    if (out.length) return out
  }
  // Старый плоский формат (или нет секций) — одна секция со всеми labor-работами.
  const rows = (est.lines || [])
    .filter((l) => l.type === 'labor' && catalog.works[l.refId])
    .map((l) => ({ key: nextKey('w'), workId: l.refId, qty: l.qty }))
  return rows.length
    ? [{ key: nextKey('sec'), complaint: est.complaint?.slice(0, 80) || 'Основні роботи', serviceKind: refs?.[0]?.serviceKind || 'repair', rows }]
    : []
}

// Собрать ComplaintSection[] для движка из редактируемых секций (пустые отбрасываем).
export function toComplaintSections(sections: EditableSection[], catalog: PriceCatalog): ComplaintSection[] {
  return sections
    .map((s) => ({
      complaint: s.complaint.trim() || 'Роботи',
      serviceKind: s.serviceKind,
      works: s.rows.filter((r) => r.workId && catalog.works[r.workId]).map((r) => ({ workId: r.workId, qty: r.qty })),
    }))
    .filter((s) => s.works.length)
}

// Группировка построенной сметы по секциям (для показа «разрезов» мастеру и клиенту). Дженерик:
// работает и с полной Estimate.lines, и с клиентским SafeEstimate.lines — нужны только
// complaintIndex + lineTotal у строк и sections(refs) с метками.
export interface SectionRef { complaint: string; serviceKind?: ServiceKind | null }
export interface SectionGroup<L> { label: string; serviceKind?: ServiceKind; lines: L[]; subtotal: number }
export function groupLinesBySection<L extends { complaintIndex?: number | null; lineTotal: number }>(
  lines: L[] | undefined,
  refs: SectionRef[] | undefined | null
): SectionGroup<L>[] {
  const ls = lines || []
  if (!refs || !refs.length) {
    return [{ label: '', serviceKind: undefined, lines: ls, subtotal: ls.reduce((s, l) => s + (l.lineTotal || 0), 0) }]
  }
  const groups: SectionGroup<L>[] = refs.map((ref) => ({ label: ref.complaint, serviceKind: ref.serviceKind || undefined, lines: [], subtotal: 0 }))
  const other: L[] = []
  for (const l of ls) {
    const ci = l.complaintIndex
    if (ci != null && groups[ci]) groups[ci].lines.push(l)
    else other.push(l)
  }
  if (other.length) groups.push({ label: 'Інше', serviceKind: undefined, lines: other, subtotal: 0 })
  for (const g of groups) g.subtotal = g.lines.reduce((s, l) => s + (l.lineTotal || 0), 0)
  return groups.filter((g) => g.lines.length)
}
