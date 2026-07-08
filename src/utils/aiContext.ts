// Сборка компактного контекста для ИИ-помощников (оценка стоимости, консультации).
//
// Контекст передаётся в системный промпт на сервере: прайс-лист для оценки,
// выжимка базы знаний для консультаций/самопомощи, активные правки поведения.

import { buildCatalog, tName, workTurnkeyPrice, formatMoney, resolveActiveSeason, currentMonth, expandKit } from '@/utils/pricing'
import type { PriceListDoc } from '@/api/pricingService'
import type { Lang } from '@/types/pricing'
import type { KnowledgeArticle } from '@/types/knowledge'
import type { BehaviorCorrection, BehaviorScope } from '@/types/feedback'
import type { ComplaintTemplate } from '@/types/complaint'
import { SEVERITY_LABELS, SEVERITY_ORDER } from '@/types/complaint'

// Прайс для контекста ИИ-оценки: публичные работы по категориям + готовые наборы.
export function buildPriceContext(doc: PriceListDoc, lang: Lang = 'uk'): string {
  const indexed = buildCatalog(doc)
  const season = resolveActiveSeason(doc.settings, currentMonth())
  const seasonNote = season.coefficient === 1
    ? 'Зараз звичайний сезон (без націнки).'
    : season.coefficient > 1
      ? `Зараз високий сезон, коефіцієнт ×${season.coefficient} діє ЛИШЕ на роботи (не на матеріали). Ціни нижче вже враховують поточний сезон.`
      : `Зараз міжсезоння, коефіцієнт ×${season.coefficient} (знижка на роботи). Ціни нижче вже враховують поточний сезон.`
  const lines: string[] = [
    'ПРАЙС-ЛИСТ (послуга [код] — вартість «під ключ» на ПОТОЧНИЙ сезон):',
    seasonNote,
    'Позначка [без націнки сезону] означає, що до цієї роботи націнка високого сезону не застосовується. Не вигадуй чисел поза цим прайсом.',
  ]
  const cats = [...doc.categories].sort((a, b) => a.order - b.order)
  for (const c of cats) {
    const works = doc.works.filter((w) => w.active && w.publicVisible && w.categoryId === c.id)
    if (!works.length) continue
    lines.push(`\n# ${tName(c.name, lang)}`)
    for (const w of works) {
      const exempt = w.waivesHighSeasonSurcharge || w.criticalNoSurcharge
      lines.push(`- ${tName(w.name, lang)} [${w.code}] — ${formatMoney(workTurnkeyPrice(w, indexed, doc.settings))}${exempt ? ' [без націнки сезону]' : ''}`)
    }
  }
  const kits = doc.kits.filter((k) => k.active)
  if (kits.length) {
    lines.push('\n# Готові набори (ЗАВЖДИ показуй клієнту розбивку по операціях, а не лише суму)')
    for (const k of kits) {
      const items = expandKit(k, indexed)
      const total = items.reduce((acc, { work, qty }) => acc + workTurnkeyPrice(work, indexed, doc.settings) * qty, 0)
      lines.push(`- ${tName(k.name, lang)} [${k.code}] — разом ${formatMoney(total)} (${k.serviceKind === 'upgrade' ? 'апгрейд' : 'ремонт'}). Складається з:`)
      for (const { work, qty } of items) {
        lines.push(`    • ${tName(work.name, lang)}${qty > 1 ? ` ×${qty}` : ''} — ${formatMoney(workTurnkeyPrice(work, indexed, doc.settings) * qty)}`)
      }
    }
  }

  // Общие работы, добавляемые к любой смете
  const commonCodes = doc.settings.commonWorkCodes ?? []
  const commonWorks = commonCodes.map((c) => doc.works.find((w) => w.code === c && w.active)).filter(Boolean)
  if (commonWorks.length) {
    lines.push('\n# Загальні роботи (додаються до КОЖНОЇ сметы, якщо ще не входять у набір — враховуй їх у підсумку):')
    for (const w of commonWorks) {
      lines.push(`- ${tName(w!.name, lang)} — ${formatMoney(workTurnkeyPrice(w!, indexed, doc.settings))}`)
    }
  }

  return lines.join('\n')
}

// База знаний для консультаций и самопомощи: заголовок, признаки, текст, видео/ссылки.
// Статьи «для мастеров» (forMasters) в клиентский контекст НЕ попадают.
export function buildKnowledgeContext(articles: KnowledgeArticle[], lang: Lang = 'uk'): string {
  const active = articles.filter((a) => a.active && !a.forMasters)
  if (!active.length) return ''
  const lines: string[] = []
  for (const a of active) {
    const flags = [a.forConsultation ? 'консультація' : '', a.forSelfService ? 'самодопомога' : '']
      .filter(Boolean)
      .join('/')
    lines.push(`### ${tName(a.title, lang)} (${flags})`)
    lines.push(tName(a.body, lang))
    if (a.videos.length) lines.push('Відео: ' + a.videos.map((v) => `${v.title} — ${v.url}`).join('; '))
    if (a.links.length) lines.push('Посилання: ' + a.links.join('; '))
    lines.push('')
  }
  return lines.join('\n')
}

// Типовые жалобы → диагностика + варианты ремонта (лучший/вероятный/худший) с ценами.
// Помогает ИИ по описанию проблемы показать «возможно это, или это».
export function buildComplaintContext(templates: ComplaintTemplate[], doc: PriceListDoc, lang: Lang = 'uk'): string {
  const active = templates.filter((t) => t.active)
  if (!active.length) return ''
  const indexed = buildCatalog(doc)
  // Только активные работы: неизвестные/неактивные коды НЕ выводим сырыми в контекст ИИ.
  const byCode = new Map(doc.works.filter((w) => w.active).map((w) => [w.code, w]))
  const workLines = (codes: string[]): string => {
    const parts = codes
      .map((code) => byCode.get(code))
      .filter((w): w is NonNullable<typeof w> => !!w)
      .map((w) => `${tName(w.name, lang)} — ${formatMoney(workTurnkeyPrice(w, indexed, doc.settings))}`)
    return parts.length ? parts.join('; ') : 'потрібне уточнення в майстра'
  }
  const lines: string[] = ['ТИПОВІ СКАРГИ ТА ВАРІАНТИ РЕМОНТУ (за описом проблеми показуй «можливо це, або це»):']
  for (const t of active) {
    lines.push(`\n### Симптом: ${tName(t.symptom, lang)}`)
    if (t.keywords.length) lines.push(`Ключові слова: ${t.keywords.join(', ')}`)
    if (t.diagnosticWorkCodes.length) lines.push('Діагностика (в будь-якому разі): ' + workLines(t.diagnosticWorkCodes))
    const variants = [...t.variants].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
    for (const v of variants) {
      lines.push(`— [${SEVERITY_LABELS[v.severity]}] ${tName(v.label, lang)}: ` + workLines(v.workCodes))
    }
  }
  return lines.join('\n')
}

// Активные правки поведения ИИ для нужной области (all + конкретная).
export function activeCorrections(list: BehaviorCorrection[], scope: Exclude<BehaviorScope, 'all'>): string[] {
  return list
    .filter((c) => c.active && (c.scope === 'all' || c.scope === scope))
    .map((c) => c.instruction)
}
