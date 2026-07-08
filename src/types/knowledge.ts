// Единая база знаний сервиса.
//
// Одна коллекция статей с признаками использования: консультации по эксплуатации
// и/или «самопомощь» (как сделать сервисную работу самостоятельно). ИИ по контексту
// подбирает материалы: эксплуатационный вопрос → консультация; описание поломки →
// сначала предложить самопомощь (сэкономить), затем платный ремонт.

import type { LocalizedText } from '@/types/pricing'

export interface KnowledgeVideo {
  title: string
  url: string
}

// Иллюстрация статьи: URL загруженного в Firebase Storage файла + путь (для удаления) + подпись.
export interface KnowledgeImage {
  url: string // download URL из Firebase Storage
  path: string // путь в Storage (knowledge/{articleId}/…) — нужен для удаления
  caption?: string // подпись под картинкой (украинский)
}

export interface KnowledgeArticle {
  id: string
  title: LocalizedText
  body: LocalizedText // текст инструкции (украинский основной)
  forConsultation: boolean // эксплуатация: как зарядить АКБ, настроить и т.д.
  forSelfService: boolean // как сделать самому — альтернатива платному ремонту
  forMasters?: boolean // статья ТОЛЬКО для мастеров сервиса — клиентам не показывать и не предлагать ИИ
  tags: string[]
  relatedWorkCodes: string[] // связь с работами прайса (какой проблеме соответствует)
  images?: KnowledgeImage[] // иллюстрации (схемы, экраны меню, фото) — загружаются в Storage
  videos: KnowledgeVideo[] // ссылки на видео
  links: string[] // ссылки на статьи
  active: boolean
  updatedAt: string
  updatedBy: string | null
}
