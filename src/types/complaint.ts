// Шаблоны жалоб (симптомов) и их связь с позициями прайса.
//
// Симптом клиента («после намотки не плывёт + посторонний звук мотора») → работы
// диагностики (нужны в любом случае) + варианты ремонта (лучший/вероятный/худший),
// каждый со своим набором работ и стоимостью. Питает ИИ-оценку: по описанию проблемы
// ИИ подбирает шаблон и показывает «возможно это, или это».

import type { LocalizedText } from './pricing'

export type VariantSeverity = 'best' | 'likely' | 'worst'

export const SEVERITY_LABELS: Record<VariantSeverity, string> = {
  best: 'Кращий випадок',
  likely: 'Ймовірний',
  worst: 'Гірший випадок',
}

export const SEVERITY_ORDER: VariantSeverity[] = ['best', 'likely', 'worst']

// Один вариант ремонта (сценарий поломки) со своим набором работ прайса.
export interface RepairVariant {
  id: string
  label: LocalizedText // «Чистка та калібрування» / «Заміна мотора»
  severity: VariantSeverity
  workCodes: string[] // коды работ прайса для этого варианта
  note?: LocalizedText // пояснение (когда применяется)
}

export interface ComplaintTemplate {
  id: string
  symptom: LocalizedText // «Після намотки кораблик не пливе, мотор видає сторонній звук»
  keywords: string[] // ключевые слова для сопоставления и контекста ИИ
  diagnosticWorkCodes: string[] // работы, нужные в любом случае (диагностика)
  variants: RepairVariant[] // возможные варианты ремонта (лучший/вероятный/худший)
  relatedModels: string[] // модели корабликов, к которым относится (пусто = все)
  active: boolean
  updatedAt: string
  updatedBy: string | null
}
