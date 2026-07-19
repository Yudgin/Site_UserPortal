import type {
  CallCardRef,
  CallResultRecord,
  ChatInfo,
  ClientLink,
  ConsultationRequest,
  PendingPrompt,
  Reminder,
  Task,
  TelegramLinkToken,
  ThreadInfo,
  User,
} from '../types.js';

/**
 * Контракт хранилища. Реализации: MemoryStore (локально/тесты)
 * и FirestoreStore (продакшен, src/store/firestore.ts).
 */
export interface Store {
  // Чаты, где состоит бот
  upsertChat(chat: ChatInfo): Promise<void>;
  getChat(id: number): Promise<ChatInfo | null>;
  listChats(): Promise<ChatInfo[]>;
  updateChat(
    id: number,
    patch: Partial<
      Pick<
        ChatInfo,
        'active' | 'events' | 'present' | 'title' | 'isForum' | 'isArchive' | 'isResults' | 'employeeIds'
      >
    >,
  ): Promise<ChatInfo | null>;

  // Ветки (темы форум-чатов)
  upsertThread(thread: ThreadInfo): Promise<void>;
  getThread(chatId: number, threadId: number): Promise<ThreadInfo | null>;
  listThreads(chatId?: number): Promise<ThreadInfo[]>;
  updateThread(
    chatId: number,
    threadId: number,
    patch: Partial<
      Pick<ThreadInfo, 'active' | 'events' | 'name' | 'isArchive' | 'isResults' | 'employeeIds'>
    >,
  ): Promise<ThreadInfo | null>;

  // Карточки звонков, отправленные в чаты
  saveCallCard(ref: CallCardRef): Promise<void>;
  findCallCard(chatId: number, messageId: number): Promise<CallCardRef | null>;
  /** Все карточки одного звонка во всех группах — для синхронного закрытия. */
  findCallCardsByCallId(callId: string): Promise<CallCardRef[]>;
  /** Все необработанные карточки по телефону клиента — для дедупа повторных звонков. */
  findCallCardsByPhone(phone: string): Promise<CallCardRef[]>;
  deleteCallCard(chatId: number, messageId: number): Promise<void>;

  // Результаты разговоров
  saveCallResult(result: CallResultRecord): Promise<void>;
  listCallResults(limit?: number): Promise<CallResultRecord[]>;
  /** Есть ли по звонку зафиксированное резюме (описание разговора). */
  hasCallResult(callId: string): Promise<boolean>;
  /** Все резюме по звонку — чтобы удалить сообщения операторов при закрытии. */
  findCallResultsByCallId(callId: string): Promise<CallResultRecord[]>;
  /** Результат по id — для пометки «принято» из канала результатов. */
  getCallResult(id: string): Promise<CallResultRecord | null>;
  /** Обновить статус просмотра/список опубликованных карточек результата. */
  updateCallResult(
    id: string,
    patch: Partial<Pick<CallResultRecord, 'resultMessages' | 'reviewedAt' | 'reviewedByName'>>,
  ): Promise<CallResultRecord | null>;

  // Напоминания
  saveReminder(reminder: Reminder): Promise<void>;
  listDueReminders(nowIso: string): Promise<Reminder[]>;
  markReminderDone(id: string): Promise<void>;
  listReminders(limit?: number): Promise<Reminder[]>;

  // Ожидания ответа оператора (force reply)
  savePrompt(prompt: PendingPrompt): Promise<void>;
  findPromptByMessage(chatId: number, promptMessageId: number): Promise<PendingPrompt | null>;
  deletePrompt(id: string): Promise<void>;

  // Заявки на консультацию
  saveConsultation(c: ConsultationRequest): Promise<void>;
  listConsultations(limit?: number): Promise<ConsultationRequest[]>;

  // Клиенты (Telegram ↔ телефон)
  saveClientLink(link: ClientLink): Promise<void>;
  getClientByTelegramId(telegramUserId: number): Promise<ClientLink | null>;
  findClientLinksByPhone(phone: string): Promise<ClientLink[]>;

  // Язык интерфейса пользователя (код языка, напр. "uk")
  setUserLanguage(telegramUserId: number, lang: string): Promise<void>;
  getUserLanguage(telegramUserId: number): Promise<string | null>;

  // Пользователи портала
  saveUser(user: User): Promise<void>;
  getUser(id: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;
  getUserByTelegramId(telegramUserId: number): Promise<User | null>;
  listUsers(): Promise<User[]>;
  updateUser(
    id: string,
    patch: Partial<Pick<User, 'name' | 'email' | 'googleId' | 'role' | 'active' | 'telegramUserId'>>,
  ): Promise<User | null>;

  // Задачи (напоминания/задания)
  saveTask(task: Task): Promise<void>;
  getTask(id: string): Promise<Task | null>;
  listTasks(): Promise<Task[]>;
  listTasksByAssignee(userId: string): Promise<Task[]>;
  /** Напоминания, у которых наступил срок и которые ещё не отправлены. */
  listDueTaskReminders(nowIso: string): Promise<Task[]>;
  updateTask(
    id: string,
    patch: Partial<
      Pick<Task, 'title' | 'dueAt' | 'status' | 'result' | 'doneAt' | 'doneByName' | 'notifiedAt'>
    >,
  ): Promise<Task | null>;

  // Токены привязки Telegram к пользователю
  saveLinkToken(token: TelegramLinkToken): Promise<void>;
  getLinkToken(token: string): Promise<TelegramLinkToken | null>;
  deleteLinkToken(token: string): Promise<void>;
}

/** Хранилище в памяти процесса — для локальной разработки и тестов. */
export class MemoryStore implements Store {
  private chats = new Map<number, ChatInfo>();
  private threads = new Map<string, ThreadInfo>();
  private callCards = new Map<string, CallCardRef>();
  private callResults: CallResultRecord[] = [];
  private reminders = new Map<string, Reminder>();
  private prompts = new Map<string, PendingPrompt>();
  private consultations: ConsultationRequest[] = [];
  private clientLinks = new Map<number, ClientLink>();
  private userLanguages = new Map<number, string>();
  private users = new Map<string, User>();
  private tasks = new Map<string, Task>();
  private linkTokens = new Map<string, TelegramLinkToken>();

  private cardKey(chatId: number, messageId: number): string {
    return `${chatId}:${messageId}`;
  }

  private threadKey(chatId: number, threadId: number): string {
    return `${chatId}:${threadId}`;
  }

  async upsertChat(chat: ChatInfo): Promise<void> {
    this.chats.set(chat.id, { ...chat });
  }

  async getChat(id: number): Promise<ChatInfo | null> {
    const chat = this.chats.get(id);
    return chat ? { ...chat } : null;
  }

  async listChats(): Promise<ChatInfo[]> {
    return [...this.chats.values()].map((c) => ({ ...c }));
  }

  async updateChat(
    id: number,
    patch: Partial<
      Pick<
        ChatInfo,
        'active' | 'events' | 'present' | 'title' | 'isForum' | 'isArchive' | 'isResults' | 'employeeIds'
      >
    >,
  ): Promise<ChatInfo | null> {
    const chat = this.chats.get(id);
    if (!chat) return null;
    const updated: ChatInfo = { ...chat, ...patch, updatedAt: new Date().toISOString() };
    this.chats.set(id, updated);
    return { ...updated };
  }

  async upsertThread(thread: ThreadInfo): Promise<void> {
    this.threads.set(this.threadKey(thread.chatId, thread.threadId), { ...thread });
  }

  async getThread(chatId: number, threadId: number): Promise<ThreadInfo | null> {
    const thread = this.threads.get(this.threadKey(chatId, threadId));
    return thread ? { ...thread } : null;
  }

  async listThreads(chatId?: number): Promise<ThreadInfo[]> {
    const all = [...this.threads.values()].map((t) => ({ ...t }));
    return chatId === undefined ? all : all.filter((t) => t.chatId === chatId);
  }

  async updateThread(
    chatId: number,
    threadId: number,
    patch: Partial<
      Pick<ThreadInfo, 'active' | 'events' | 'name' | 'isArchive' | 'isResults' | 'employeeIds'>
    >,
  ): Promise<ThreadInfo | null> {
    const key = this.threadKey(chatId, threadId);
    const thread = this.threads.get(key);
    if (!thread) return null;
    const updated: ThreadInfo = { ...thread, ...patch, updatedAt: new Date().toISOString() };
    this.threads.set(key, updated);
    return { ...updated };
  }

  async saveCallCard(ref: CallCardRef): Promise<void> {
    this.callCards.set(this.cardKey(ref.chatId, ref.messageId), { ...ref });
  }

  async findCallCard(chatId: number, messageId: number): Promise<CallCardRef | null> {
    const ref = this.callCards.get(this.cardKey(chatId, messageId));
    return ref ? { ...ref } : null;
  }

  async findCallCardsByCallId(callId: string): Promise<CallCardRef[]> {
    return [...this.callCards.values()].filter((c) => c.callId === callId).map((c) => ({ ...c }));
  }

  async findCallCardsByPhone(phone: string): Promise<CallCardRef[]> {
    return [...this.callCards.values()].filter((c) => c.phone === phone).map((c) => ({ ...c }));
  }

  async deleteCallCard(chatId: number, messageId: number): Promise<void> {
    this.callCards.delete(this.cardKey(chatId, messageId));
  }

  async saveCallResult(result: CallResultRecord): Promise<void> {
    this.callResults.push({ ...result });
  }

  async listCallResults(limit = 100): Promise<CallResultRecord[]> {
    return [...this.callResults]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async hasCallResult(callId: string): Promise<boolean> {
    return this.callResults.some((r) => r.callId === callId);
  }

  async findCallResultsByCallId(callId: string): Promise<CallResultRecord[]> {
    return this.callResults.filter((r) => r.callId === callId).map((r) => ({ ...r }));
  }

  async getCallResult(id: string): Promise<CallResultRecord | null> {
    const found = this.callResults.find((r) => r.id === id);
    return found ? { ...found } : null;
  }

  async updateCallResult(
    id: string,
    patch: Partial<Pick<CallResultRecord, 'resultMessages' | 'reviewedAt' | 'reviewedByName'>>,
  ): Promise<CallResultRecord | null> {
    const index = this.callResults.findIndex((r) => r.id === id);
    if (index === -1) return null;
    const updated: CallResultRecord = { ...this.callResults[index], ...patch };
    this.callResults[index] = updated;
    return { ...updated };
  }

  async saveReminder(reminder: Reminder): Promise<void> {
    this.reminders.set(reminder.id, { ...reminder });
  }

  async listDueReminders(nowIso: string): Promise<Reminder[]> {
    return [...this.reminders.values()]
      .filter((r) => !r.done && r.dueAt <= nowIso)
      .map((r) => ({ ...r }));
  }

  async markReminderDone(id: string): Promise<void> {
    const reminder = this.reminders.get(id);
    if (reminder) {
      this.reminders.set(id, { ...reminder, done: true });
    }
  }

  async listReminders(limit = 100): Promise<Reminder[]> {
    return [...this.reminders.values()]
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
      .slice(0, limit);
  }

  /** Полный список карточек — нужен FileStore для сериализации. */
  async listCallCards(): Promise<CallCardRef[]> {
    return [...this.callCards.values()].map((c) => ({ ...c }));
  }

  /** Полный список ожиданий ответа — нужен FileStore для сериализации. */
  async listPrompts(): Promise<PendingPrompt[]> {
    return [...this.prompts.values()].map((p) => ({ ...p }));
  }

  /** Полный список связок клиентов — нужен FileStore для сериализации. */
  async listClientLinks(): Promise<ClientLink[]> {
    return [...this.clientLinks.values()].map((c) => ({ ...c }));
  }

  async savePrompt(prompt: PendingPrompt): Promise<void> {
    this.prompts.set(prompt.id, { ...prompt });
  }

  async findPromptByMessage(chatId: number, promptMessageId: number): Promise<PendingPrompt | null> {
    for (const prompt of this.prompts.values()) {
      if (prompt.chatId === chatId && prompt.promptMessageId === promptMessageId) {
        return { ...prompt };
      }
    }
    return null;
  }

  async deletePrompt(id: string): Promise<void> {
    this.prompts.delete(id);
  }

  async saveConsultation(c: ConsultationRequest): Promise<void> {
    this.consultations.push({ ...c });
  }

  async listConsultations(limit = 100): Promise<ConsultationRequest[]> {
    return [...this.consultations]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async saveClientLink(link: ClientLink): Promise<void> {
    this.clientLinks.set(link.telegramUserId, { ...link });
  }

  async getClientByTelegramId(telegramUserId: number): Promise<ClientLink | null> {
    const link = this.clientLinks.get(telegramUserId);
    return link ? { ...link } : null;
  }

  async findClientLinksByPhone(phone: string): Promise<ClientLink[]> {
    return [...this.clientLinks.values()].filter((c) => c.phone === phone).map((c) => ({ ...c }));
  }

  async setUserLanguage(telegramUserId: number, lang: string): Promise<void> {
    this.userLanguages.set(telegramUserId, lang);
  }

  async getUserLanguage(telegramUserId: number): Promise<string | null> {
    return this.userLanguages.get(telegramUserId) ?? null;
  }

  /** Полный список языков пользователей — нужен FileStore для сериализации. */
  async listUserLanguages(): Promise<[number, string][]> {
    return [...this.userLanguages.entries()];
  }

  async saveUser(user: User): Promise<void> {
    this.users.set(user.id, { ...user });
  }

  async getUser(id: string): Promise<User | null> {
    const user = this.users.get(id);
    return user ? { ...user } : null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const target = email.trim().toLowerCase();
    for (const user of this.users.values()) {
      if (user.email && user.email.toLowerCase() === target) return { ...user };
    }
    return null;
  }

  async listUsers(): Promise<User[]> {
    return [...this.users.values()].map((u) => ({ ...u }));
  }

  async getUserByTelegramId(telegramUserId: number): Promise<User | null> {
    for (const user of this.users.values()) {
      if (user.telegramUserId === telegramUserId) return { ...user };
    }
    return null;
  }

  async updateUser(
    id: string,
    patch: Partial<Pick<User, 'name' | 'email' | 'googleId' | 'role' | 'active' | 'telegramUserId'>>,
  ): Promise<User | null> {
    const user = this.users.get(id);
    if (!user) return null;
    const updated: User = { ...user, ...patch, updatedAt: new Date().toISOString() };
    this.users.set(id, updated);
    return { ...updated };
  }

  async saveTask(task: Task): Promise<void> {
    this.tasks.set(task.id, { ...task });
  }

  async getTask(id: string): Promise<Task | null> {
    const task = this.tasks.get(id);
    return task ? { ...task } : null;
  }

  async listTasks(): Promise<Task[]> {
    return [...this.tasks.values()].map((t) => ({ ...t }));
  }

  async listTasksByAssignee(userId: string): Promise<Task[]> {
    return [...this.tasks.values()].filter((t) => t.assigneeUserId === userId).map((t) => ({ ...t }));
  }

  async listDueTaskReminders(nowIso: string): Promise<Task[]> {
    return [...this.tasks.values()]
      .filter(
        (t) =>
          t.kind === 'reminder' &&
          t.status === 'open' &&
          !t.notifiedAt &&
          t.dueAt !== undefined &&
          t.dueAt <= nowIso,
      )
      .map((t) => ({ ...t }));
  }

  async updateTask(
    id: string,
    patch: Partial<
      Pick<Task, 'title' | 'dueAt' | 'status' | 'result' | 'doneAt' | 'doneByName' | 'notifiedAt'>
    >,
  ): Promise<Task | null> {
    const task = this.tasks.get(id);
    if (!task) return null;
    const updated: Task = { ...task, ...patch, updatedAt: new Date().toISOString() };
    this.tasks.set(id, updated);
    return { ...updated };
  }

  async saveLinkToken(token: TelegramLinkToken): Promise<void> {
    this.linkTokens.set(token.token, { ...token });
  }

  async getLinkToken(token: string): Promise<TelegramLinkToken | null> {
    const found = this.linkTokens.get(token);
    return found ? { ...found } : null;
  }

  async deleteLinkToken(token: string): Promise<void> {
    this.linkTokens.delete(token);
  }

  /** Полный список токенов привязки — нужен FileStore для сериализации. */
  async listLinkTokens(): Promise<TelegramLinkToken[]> {
    return [...this.linkTokens.values()].map((t) => ({ ...t }));
  }
}
