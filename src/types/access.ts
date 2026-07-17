// Модель доступа: роли сотрудников + сервисные центры (зоны) + права мастеров по центрам.
//
import type { PayMethodKey } from '@/types/pricing'
//
// Роли:
//  • owner      — владелец: полный доступ ко всему (по email admin@runferry.de ИЛИ role='owner').
//  • director   — директор сервиса: полный доступ (все права) в ПРЕДЕЛАХ своих центров, включая
//                 внутреннюю экономику центра (выплаты специалистам, наценка центра, ФОП/оплаты).
//  • accountant — бухгалтер: просмотр + «выставление на оплату» (выбор ФОП) по всем центрам.
//  • master     — мастер/специалист: права per-center из набора ниже (обычно 1+ центров).
//                 Как специалист видит в калькуляции только СВОЮ сумму (не экономику центра).
//
// Права мастера по конкретному центру (независимые флаги, не уровни):
//  • view        — видеть заявки центра;
//  • preliminary — формировать предварительные калькуляции (предложение с вариантами);
//  • actual      — формировать фактические калькуляции (что реально сделано);
//  • payment     — выставлять на оплату (выбор ФОП/способа). Обычно у бухгалтера/владельца.
// У директора в пределах его центров — все права независимо от набора флагов.
export type Role = 'owner' | 'director' | 'accountant' | 'master'

export type CenterPermission = 'view' | 'preliminary' | 'actual' | 'payment'

export const CENTER_PERMISSIONS: CenterPermission[] = ['view', 'preliminary', 'actual', 'payment']

export const CENTER_PERMISSION_LABELS: Record<CenterPermission, string> = {
  view: 'Перегляд заявок',
  preliminary: 'Попередні калькуляції',
  actual: 'Фактичні калькуляції',
  payment: 'Виставлення на оплату',
}

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Власник',
  director: 'Директор сервісу',
  accountant: 'Бухгалтер',
  master: 'Майстер (спеціаліст)',
}

// Доступ мастера к одному центру: набор прав.
export interface CenterAccess {
  centerId: string
  perms: CenterPermission[]
}

// ==== Видимость карточки заявки/калькуляции по ролям (для превью «Показати як…») ====
// Роли просмотра: сотрудники + клиент. Определяют, что видно в карточке.
export type ViewRole = Role | 'client'
export const VIEW_ROLES: ViewRole[] = ['owner', 'director', 'accountant', 'master', 'client']
export const VIEW_ROLE_LABELS: Record<ViewRole, string> = {
  owner: 'Власник',
  director: 'Директор сервісу',
  accountant: 'Бухгалтер',
  master: 'Спеціаліст',
  client: 'Клієнт',
}

// Флаги видимости секций карточки. economics — полное распределение по специалистам + наценка
// центра; ownPayoutOnly — специалист видит лишь свою сумму; payFop — привязка ФОП к способам;
// payMethods — список способов оплаты; planFactDiff — сравнение план/факт; internal — прочие
// служебные секции (диагностика, назначенные специалисты заявки).
export interface CardVisibility {
  economics: boolean
  ownPayoutOnly: boolean
  payFop: boolean
  payMethods: boolean
  planFactDiff: boolean
  internal: boolean
}
export const cardVisibility = (role: ViewRole): CardVisibility => {
  switch (role) {
    case 'owner':
    case 'director':
      return { economics: true, ownPayoutOnly: false, payFop: true, payMethods: true, planFactDiff: true, internal: true }
    case 'accountant':
      return { economics: false, ownPayoutOnly: false, payFop: true, payMethods: true, planFactDiff: true, internal: true }
    case 'master':
      return { economics: false, ownPayoutOnly: true, payFop: false, payMethods: true, planFactDiff: true, internal: true }
    case 'client':
      return { economics: false, ownPayoutOnly: false, payFop: false, payMethods: true, planFactDiff: false, internal: false }
  }
}

// Профиль сотрудника (роль-документ). Ключ документа = Firebase uid. Пишет только владелец.
export interface UserProfile {
  uid: string
  email: string
  displayName?: string
  role: Role
  centers?: CenterAccess[] // для master (и опционально для scoped-бухгалтера); owner — все центры
  active: boolean
  createdAt: string
  updatedAt: string
  createdBy?: string | null
}

// Сервисный центр (зона обслуживания). Наш реестр; externalId — маппинг к 1С ServiceCenter.ID.
// Поля отправителя НП и привязка шаблонов посылок добавятся в фазе ТТН.
export interface ServiceCenter {
  id: string
  name: string
  externalId?: string | null // ID сервисного центра в 1С (repair_ServoceList)
  zone?: string // регион/зона (метка), опционально
  // Дефолтный ФОП по каждому способу оплаты (для этого центра). Ключ — PayMethodKey (см. pricing.ts),
  // значение — fopId. Подставляется в фактическую калькуляцию как дефолт (мастер может переопределить).
  defaultFopByMethod?: Partial<Record<PayMethodKey, string>>
  // Шаблоны ТТН Новой Почты для этого центра по направлениям (id из npTemplates):
  incomingTtnTemplateId?: string | null // клиент → сервіс («на ремонт»)
  returnTtnTemplateId?: string | null // сервіс → клієнт («з ремонту»)
  active: boolean
  createdAt: string
  updatedAt: string
  createdBy?: string | null
}
