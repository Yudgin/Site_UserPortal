import type { MasterLineRef } from './pricing'
// Заявка на обслуживание — НАША локальная сущность-хаб (система-источник на сайте).
// Формируется из обращения (ChatSession) и связывает предварительные калькуляции (предложение
// с вариантами), фактическую калькуляцию и оплату. Ссылка на 1С — через externalRequestId
// (выгрузка позже). Хранится в Firestore-коллекции `serviceRequests` (доступ — админ).

export type ServiceRequestStatus =
  | 'new' // создана из обращения
  | 'diagnostics' // на диагностике
  | 'offered' // выставлено предложение (варианты) клиенту
  | 'approved' // клиент выбрал вариант / согласовал
  | 'in_work' // в работе
  | 'done' // выполнено/оплачено
  | 'cancelled'

export const SERVICE_REQUEST_STATUS_LABELS: Record<ServiceRequestStatus, string> = {
  new: 'Нова',
  diagnostics: 'Діагностика',
  offered: 'Запропоновано',
  approved: 'Погоджено',
  in_work: 'В роботі',
  done: 'Виконано',
  cancelled: 'Скасовано',
}

// Фізичний етап ремонту (рішення власника 2026-10-08): окремо від комерційного статусу, який
// рухає система (offered/approved/in_work/done). Етап ставить людина (хаб, мобільний додаток)
// або синхронізація 1С за ТТН (fill-only). Порядок — фізичний шлях кораблика через майстерню.
// 'handed_over' — кораблик у клієнта (рішення власника 2026-10-18): самовивіз або підтверджене отримання посилки.
// Від цієї відмітки рахуються 14 днів, поки заявка ще «відкрита» (правило власника 2026-10-17; isOpen у
// server/binotelWebhook.js).
export type RepairStage = 'received' | 'diagnosed' | 'waiting_parts' | 'repaired' | 'packed' | 'shipped' | 'handed_over'

export const REPAIR_STAGE_ORDER: RepairStage[] = ['received', 'diagnosed', 'waiting_parts', 'repaired', 'packed', 'shipped', 'handed_over']

export const REPAIR_STAGE_LABELS: Record<RepairStage, string> = {
  received: 'Отримано',
  diagnosed: 'Діагностовано',
  waiting_parts: 'Чекаємо запчастини',
  repaired: 'Відремонтовано',
  packed: 'Запаковано',
  shipped: 'Відправлено',
  handed_over: 'Видано клієнту',
}

// Наступний «звичайний» етап для кнопки «Наступний етап». waiting_parts — бічна гілка: з неї
// далі — repaired; після shipped — handed_over (клієнт отримав); після handed_over наступного немає. Самовивіз —
// окрема кнопка «Видано клієнту» з repaired/packed.
export const nextRepairStage = (stage?: RepairStage | null): RepairStage | null => {
  switch (stage) {
    case undefined:
    case null: return 'received'
    case 'received': return 'diagnosed'
    case 'diagnosed': return 'repaired'
    case 'waiting_parts': return 'repaired'
    case 'repaired': return 'packed'
    case 'packed': return 'shipped'
    case 'shipped': return 'handed_over'
    default: return null
  }
}

// Кораблик ще не в нас (власник 2026-10-18): заявка жива, етапу немає ні разу, вхідну посилку не отримано і клієнту
// нічого не відправляли. З ТТН чекаємо посилку, без ТТН клієнт привезе сам і це відмічають кнопкою «Отримано».
export const isAwaitingBoat = (r: Pick<ServiceRequest, 'status' | 'stage' | 'stageHistory' | 'incomingDelivery' | 'returnTtn' | 'returnDelivery'>): boolean =>
  !['done', 'cancelled'].includes(r.status) && !r.stage && !(r.stageHistory?.length) && !r.incomingDelivery?.arrivedAt
  && !String(r.returnTtn || '').replace(/\D/g, '').replace(/^0+$/, '') && !r.returnDelivery

// Запис історії етапів. at — ISO з клієнта (усередині arrayUnion серверний час неможливий);
// by — email/uid співробітника або технічний маркер ('1c-sync', 'np-ttn', 'backfill').
export interface StageHistoryItem {
  stage: RepairStage
  at: string
  by: string | null
  note?: string
}

// Специалист, назначенный на заявку (портальный пользователь центра). Снимок имени — чтобы
// показывать без загрузки users. При создании финальной калькуляции список подставляется в неё.
export interface RequestSpecialist {
  uid: string
  name: string
}

// Додаткова витрата поза прайсом (доставка, запчастина, послуга третьої сторони). Вноситься
// Telegram-ботом співробітників або редактором факту. Якщо є фактичний кошторис — рядок
// type='addon' refId 'extra:<id>' (extra=true) додається в нього і appliedToEstimateId вказує
// на кошторис; інакше витрата чекає складання факту (редактор підставить її автоматично).
export interface ExtraExpense {
  id: string
  title: string
  amount: number // грн
  note?: string
  at: string
  by: string | null // email співробітника
  byUid?: string
  source: 'telegram-bot' | 'portal' | 'app' | 'master' // бот / редактор факту / застосунок / калькуляція майстра
  masterRef?: MasterLineRef // для source='master': який рядок якої калькуляції майстра (зеркало EstimateLine.fromMaster)
  appliedToEstimateId?: string | null
  clientKey?: string // ключ ідемпотентності застосунку (повтор запиту не додає другий витрату)
}

export interface ServiceRequest {
  id: string
  createdAt: string
  updatedAt: string
  createdBy: string | null
  serviceCenterId?: string | null // сервисный центр (наш реестр) — для гейтинга/дефолтов ФОП
  specialists?: RequestSpecialist[] // назначенные специалисты (несколько на заявку)
  specialistUids?: string[] // денормалізація specialists[].uid — вибірка «Мої заявки» (array-contains)
  sessionId: string | null // обращение (ChatSession), из которого создана заявка
  externalRequestId: string | null // ссылка на заявку 1С (выгрузка/связь позже)
  clientName?: string
  clientPhone?: string // связь с clientProfiles (нормализованный телефон)
  // Адрес отправки клиента (Нова Пошта) — из формы /repair/new; подставляется при создании ТТН.
  clientCityRef?: string
  clientCityName?: string
  clientWarehouseRef?: string
  clientWarehouseName?: string
  boat?: string // модель/название кораблика (если известно)
  complaint: string // сводная жалоба/описание
  status: ServiceRequestStatus
  // Час подій статусу (правило входящих Binotel «виконаний ремонт ще 14 днів»; updatedAt освіжає синк 1С):
  statusChangedAt?: string | null // остання справжня зміна статусу
  doneAt?: string | null // перехід у «Виконано»
  paidAt?: string | null // оплата пройшла (пише лише backend)
  // Диагностика после получения кораблика: выявленные неисправности (текстом). Помогает уточнить
  // предварительную калькуляцию (мастер точнее определил неисправность).
  diagnostics?: { text: string; at: string; by: string | null } | null
  waybillNumber?: string | null // номер транспортной накладной (ТТН) — для оповещения об отправке
  returnTtn?: string | null // ТТН відправлення клієнту (з ремонту) — импорт 1С6 и исходящие ТТН
  npScenario?: 'incoming' | 'return' | 'purchase' | 'parts' | null // сценарій останньої ТТН, створеної порталом
  // Фізичний етап ремонту (окремо від status): поточний етап, з якого часу, історія переходів.
  stage?: RepairStage | null
  stageSince?: string | null
  stageHistory?: StageHistoryItem[]
  waitingParts?: { note?: string; since: string } | null // деталі етапу «Чекаємо запчастини»
  // Вхідна посилка (клієнт → ми): статус Нової Пошти, коли кораблик ще не в нас. Пише сервер — синхронізація 1С
  // (source '1c') або щоденне опитування НП (source 'np'); notFound — «Номер не знайдено», клієнт не відправив.
  incomingDelivery?: { ttn: string | null; status?: string | null; statusCode?: string | null; statusAt?: string | null; arrivedAt?: string | null; notFound?: boolean; source?: '1c' | 'np'; checkedAt?: string } | null
  // Зворотна посилка (ми → клієнт) з історії НП у 1С: дата відправки й отримання клієнтом (пише синхронізація 1С).
  returnDelivery?: { ttn: string | null; shippedAt: string | null; deliveredAt: string | null } | null
  // Telegram deep-link: стабильный токен ссылки t.me/<бот>?start=<токен> и привязанная
  // Telegram-сессия клиента (пишет бот при клике; оповещения идут в неё приоритетно).
  tgLinkToken?: string | null
  tgSessionId?: string | null
  extraExpenses?: ExtraExpense[] // додаткові витрати поза прайсом (бот/редактор факту)
  // Привязанные калькуляции и оплата:
  aiEstimateId?: string | null // материализованная предварительная оценка ИИ (stage='ai')
  offerId?: string | null // предложение с вариантами (предварительные калькуляции)
  actualEstimateId?: string | null // фактическая калькуляция
  paymentId?: string | null // оплата
  // Мета ремонта из 1С (пишет backend-синхронизация /api/onec/sync-repairs). Полный сырой
  // объект 1С лежит в поддокументе serviceRequests/{id}/onec/snapshot (список остаётся лёгким);
  // rawHash — сверка изменений без чтения снимка.
  onec?: { guid: string; number: string; listDate?: string; syncedAt: string; rawHash?: string; rawSize?: number } | null
}
