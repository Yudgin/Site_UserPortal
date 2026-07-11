// Модель доступа: роли сотрудников + сервисные центры (зоны) + права мастеров по центрам.
//
// Роли:
//  • owner      — владелец: полный доступ ко всему (по email admin@runferry.de ИЛИ role='owner').
//  • accountant — бухгалтер: просмотр + «выставление на оплату» (выбор ФОП) по всем центрам.
//  • master     — мастер: права per-center из набора ниже (обычно 1+ центров).
//
// Права мастера по конкретному центру (независимые флаги, не уровни):
//  • view        — видеть заявки центра;
//  • preliminary — формировать предварительные калькуляции (предложение с вариантами);
//  • actual      — формировать фактические калькуляции (что реально сделано);
//  • payment     — выставлять на оплату (выбор ФОП/способа). Обычно у бухгалтера/владельца.
export type Role = 'owner' | 'accountant' | 'master'

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
  accountant: 'Бухгалтер',
  master: 'Майстер',
}

// Доступ мастера к одному центру: набор прав.
export interface CenterAccess {
  centerId: string
  perms: CenterPermission[]
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
  active: boolean
  createdAt: string
  updatedAt: string
  createdBy?: string | null
}
