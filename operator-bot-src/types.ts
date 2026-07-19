// Доменные типы — общий контракт между всеми модулями приложения.

export type EventType = 'call.incoming' | 'call.completed' | 'test';

export const ALL_EVENT_TYPES: EventType[] = ['call.incoming', 'call.completed', 'test'];

/** Событие звонка, которое 1С присылает на POST /api/events/call */
export interface IncomingCallEvent {
  type: EventType;
  /**
   * Внутренний УНИКАЛЬНЫЙ идентификатор звонка — генерируем сами на каждое событие.
   * По нему карточка группируется/закрывается во всех чатах. НЕ полагаемся на id
   * из 1С: оно может быть неуникальным (1С шлёт константу) — тогда закрытие одного
   * звонка стирало бы все. Оригинал из 1С хранится в sourceCallId.
   */
  callId: string;
  /** Идентификатор звонка как его прислала 1С/Binotel (может быть неуникальным). */
  sourceCallId?: string;
  /** Телефон клиента в любом формате — нормализуем сами */
  phone: string;
  clientName?: string;
  clientId?: string;
  /** Линия/отдел — что 1С сочтёт полезным передать */
  line?: string;
  /** Имя сотрудника — для отображения на карточке */
  employee?: string;
  /** Внутренний номер сотрудника, на которого адресован клиент — для маршрутизации по каналам */
  employeeId?: string;
  timestamp?: string;
  /** Прочие поля от 1С, пропускаются как есть */
  extra?: Record<string, unknown>;
}

/**
 * Связка клиента: Telegram-пользователь, подтвердивший свой номер кнопкой
 * «Поделиться номером». По ней клиент видит свои ремонты и получает уведомления.
 */
export interface ClientLink {
  telegramUserId: number;
  /** Личный чат с клиентом (для отправки уведомлений) */
  chatId: number;
  /** Телефон, нормализованный (380XXXXXXXXX) */
  phone: string;
  name?: string;
  linkedAt: string;
}

/** Событие изменения статуса ремонта, которое 1С шлёт на POST /api/events/repair-status */
export interface RepairStatusEvent {
  /** Телефон клиента — по нему находим связанных Telegram-клиентов */
  phone: string;
  /** Номер ремонта (для ссылки на детали) */
  repairNumber?: string;
  /** Новый статус ремонта */
  status: string;
  /** Произвольный текст уведомления от 1С (если есть) */
  message?: string;
  timestamp?: string;
}

export type TaskKind = 'reminder' | 'task';
export type TaskStatus = 'open' | 'done';

/**
 * Задача: напоминание (kind=reminder, просто «выполнено») или задание
 * (kind=task, при выполнении нужен результат). Назначается на пользователя.
 */
export interface Task {
  id: string;
  kind: TaskKind;
  title: string;
  /** Кому назначено (User.id). */
  assigneeUserId: string;
  /** Кто создал (User.id; пусто для входа по токену). */
  creatorUserId?: string;
  creatorName: string;
  /** Когда напомнить/срок (ISO). Для напоминаний — момент отправки в Telegram. */
  dueAt?: string;
  status: TaskStatus;
  /** Результат выполнения (для заданий). */
  result?: string;
  doneAt?: string;
  doneByName?: string;
  /** Когда отправлено напоминание/уведомление в Telegram (чтобы не слать повторно). */
  notifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Токен привязки Telegram к пользователю портала (одноразовая короткая ссылка). */
export interface TelegramLinkToken {
  token: string;
  userId: string;
  expiresAt: string;
}

export type UserRole = 'admin' | 'member';

/**
 * Пользователь портала. Может быть «самостоятельным» (создан админом, цель для
 * назначения задач) или связанным с Google-аккаунтом (входит в портал).
 */
export interface User {
  id: string;
  name: string;
  /** E-mail (по нему сопоставляется вход через Google). */
  email?: string;
  /** Google sub (заполняется при первом входе через Google). */
  googleId?: string;
  role: UserRole;
  /** Привязанный Telegram (для доставки задач в бота; этап C). */
  telegramUserId?: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChatInfo {
  /** Telegram chat id */
  id: number;
  title: string;
  type: 'group' | 'supergroup' | 'channel' | 'private';
  /** Бот сейчас состоит в чате */
  present: boolean;
  /** Включена ли отправка в этот чат (базовая цель = General/весь чат) */
  active: boolean;
  /** Какие типы событий отправлять в базовую цель чата */
  events: EventType[];
  /**
   * Внутренние номера сотрудников, для которых предназначен канал. Пусто/не задано —
   * канал ОБЩИЙ (получает все звонки). Если заданы — канал получает только звонки,
   * адресованные одному из этих сотрудников (event.employeeId).
   */
  employeeIds?: string[];
  /** Чат — форум с темами (topics) */
  isForum?: boolean;
  /** Сюда публиковать выполненные задачи/напоминания (журнал-архив) */
  isArchive?: boolean;
  /** Сюда публиковать результаты разговоров (резюме операторов) на проверку руководителю */
  isResults?: boolean;
  addedAt: string;
  updatedAt: string;
}

/**
 * Ветка (тема, topic) внутри форум-чата как отдельная цель маршрутизации.
 * Сообщения в неё отправляются с message_thread_id = threadId.
 */
export interface ThreadInfo {
  chatId: number;
  /** message_thread_id темы Telegram */
  threadId: number;
  name: string;
  /** Включена ли отправка в эту ветку */
  active: boolean;
  /** Какие типы событий слать в эту ветку */
  events: EventType[];
  /** Внутренние номера сотрудников канала (пусто — общая ветка, см. ChatInfo.employeeIds) */
  employeeIds?: string[];
  /** Сюда публиковать выполненные задачи/напоминания (журнал-архив) */
  isArchive?: boolean;
  /** Сюда публиковать результаты разговоров (резюме операторов) на проверку руководителю */
  isResults?: boolean;
  addedAt: string;
  updatedAt: string;
}

/** Ссылка на отправленную в чат карточку звонка — для обработки reply */
export interface CallCardRef {
  chatId: number;
  messageId: number;
  /** Тема (topic), куда отправлена карточка, если это форум */
  threadId?: number;
  /** Внутренний уникальный id события (см. IncomingCallEvent.callId). */
  callId: string;
  /** Оригинальный id звонка из 1С — нужен, чтобы вернуть его в 1С при фиксации результата. */
  sourceCallId?: string;
  phone: string;
  clientName?: string;
  createdAt: string;
}

/** Результат разговора, зафиксированный оператором через reply на карточку */
export interface CallResultRecord {
  id: string;
  callId: string;
  phone: string;
  chatId: number;
  /** id карточки звонка, на которую оператор ответил резюме */
  messageId: number;
  /** id сообщения-ответа оператора (резюме) — чтобы удалить его при закрытии */
  operatorMessageId?: number;
  /** id ответа бота («✅ Результат разговора зафиксирован…») — тоже убираем при закрытии */
  botReplyMessageId?: number;
  /** Имя клиента с карточки звонка — для карточки результата */
  clientName?: string;
  resultText: string;
  operatorId: number;
  operatorName: string;
  createdAt: string;
  sentTo1C: boolean;
  /** Куда опубликована карточка результата (каналы «Результаты») — для синхронной пометки */
  resultMessages?: { chatId: number; messageId: number }[];
  /** Когда руководитель принял (просмотрел) результат */
  reviewedAt?: string;
  /** Кто принял результат */
  reviewedByName?: string;
}

export interface Reminder {
  id: string;
  chatId: number;
  text: string;
  phone?: string;
  callId?: string;
  /** ISO-время срабатывания */
  dueAt: string;
  createdById: number;
  createdByName: string;
  done: boolean;
  createdAt: string;
}

export type PromptKind =
  | 'repair.description'
  | 'consultation.text'
  | 'reminder.custom'
  | 'task.result'
  | 'task.title';

/** Ожидание ответа оператора (force reply) на служебный вопрос бота */
export interface PendingPrompt {
  id: string;
  kind: PromptKind;
  chatId: number;
  promptMessageId: number;
  payload: {
    phone?: string;
    callId?: string;
    clientName?: string;
    [key: string]: unknown;
  };
  createdAt: string;
}

export interface ConsultationRequest {
  id: string;
  phone: string;
  clientName?: string;
  text: string;
  chatId: number;
  createdById: number;
  createdByName: string;
  createdAt: string;
  sentTo1C: boolean;
}

/** Нормализация телефона к виду 380XXXXXXXXX (только цифры) */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D+/g, '');
  if (digits.length === 10 && digits.startsWith('0')) return '38' + digits;
  return digits;
}
