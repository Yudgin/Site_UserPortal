import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
import { MemoryStore } from './store.js';
import type { Store } from './store.js';

interface FileState {
  chats: ChatInfo[];
  threads: ThreadInfo[];
  callCards: CallCardRef[];
  callResults: CallResultRecord[];
  reminders: Reminder[];
  prompts: PendingPrompt[];
  consultations: ConsultationRequest[];
  clientLinks: ClientLink[];
  userLanguages: [number, string][];
  users: User[];
  tasks: Task[];
  linkTokens: TelegramLinkToken[];
}

/**
 * Файловое хранилище для локальной разработки: переживает перезапуски
 * tsx watch, чтобы не добавлять бота в группы заново после каждой правки.
 * Не для продакшена — там Firestore.
 */
export class FileStore implements Store {
  private readonly memory = new MemoryStore();

  constructor(private readonly filePath: string) {
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      return; // файла ещё нет — начинаем с пустого состояния
    }
    try {
      const state = JSON.parse(raw) as Partial<FileState>;
      void this.seed(state);
    } catch (err) {
      console.error(`Не удалось прочитать ${this.filePath} — начинаю с пустого состояния:`, err);
    }
  }

  private async seed(state: Partial<FileState>): Promise<void> {
    for (const chat of state.chats ?? []) await this.memory.upsertChat(chat);
    for (const thread of state.threads ?? []) await this.memory.upsertThread(thread);
    for (const card of state.callCards ?? []) await this.memory.saveCallCard(card);
    for (const result of state.callResults ?? []) await this.memory.saveCallResult(result);
    for (const reminder of state.reminders ?? []) await this.memory.saveReminder(reminder);
    for (const prompt of state.prompts ?? []) await this.memory.savePrompt(prompt);
    for (const c of state.consultations ?? []) await this.memory.saveConsultation(c);
    for (const link of state.clientLinks ?? []) await this.memory.saveClientLink(link);
    for (const [id, lang] of state.userLanguages ?? []) await this.memory.setUserLanguage(id, lang);
    for (const user of state.users ?? []) await this.memory.saveUser(user);
    for (const task of state.tasks ?? []) await this.memory.saveTask(task);
    for (const lt of state.linkTokens ?? []) await this.memory.saveLinkToken(lt);
  }

  private async persist(): Promise<void> {
    const state: FileState = {
      chats: await this.memory.listChats(),
      threads: await this.memory.listThreads(),
      callCards: await this.memory.listCallCards(),
      callResults: await this.memory.listCallResults(Number.MAX_SAFE_INTEGER),
      reminders: await this.memory.listReminders(Number.MAX_SAFE_INTEGER),
      prompts: await this.memory.listPrompts(),
      consultations: await this.memory.listConsultations(Number.MAX_SAFE_INTEGER),
      clientLinks: await this.memory.listClientLinks(),
      userLanguages: await this.memory.listUserLanguages(),
      users: await this.memory.listUsers(),
      tasks: await this.memory.listTasks(),
      linkTokens: await this.memory.listLinkTokens(),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    // Запись через временный файл, чтобы не потерять данные при падении посреди записи
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(state, null, 1), 'utf8');
    renameSync(tmpPath, this.filePath);
  }

  async upsertChat(chat: ChatInfo): Promise<void> {
    await this.memory.upsertChat(chat);
    await this.persist();
  }

  async getChat(id: number): Promise<ChatInfo | null> {
    return this.memory.getChat(id);
  }

  async listChats(): Promise<ChatInfo[]> {
    return this.memory.listChats();
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
    const result = await this.memory.updateChat(id, patch);
    if (result) await this.persist();
    return result;
  }

  async upsertThread(thread: ThreadInfo): Promise<void> {
    await this.memory.upsertThread(thread);
    await this.persist();
  }

  async getThread(chatId: number, threadId: number): Promise<ThreadInfo | null> {
    return this.memory.getThread(chatId, threadId);
  }

  async listThreads(chatId?: number): Promise<ThreadInfo[]> {
    return this.memory.listThreads(chatId);
  }

  async updateThread(
    chatId: number,
    threadId: number,
    patch: Partial<
      Pick<ThreadInfo, 'active' | 'events' | 'name' | 'isArchive' | 'isResults' | 'employeeIds'>
    >,
  ): Promise<ThreadInfo | null> {
    const result = await this.memory.updateThread(chatId, threadId, patch);
    if (result) await this.persist();
    return result;
  }

  async saveCallCard(ref: CallCardRef): Promise<void> {
    await this.memory.saveCallCard(ref);
    await this.persist();
  }

  async findCallCard(chatId: number, messageId: number): Promise<CallCardRef | null> {
    return this.memory.findCallCard(chatId, messageId);
  }

  async findCallCardsByCallId(callId: string): Promise<CallCardRef[]> {
    return this.memory.findCallCardsByCallId(callId);
  }

  async findCallCardsByPhone(phone: string): Promise<CallCardRef[]> {
    return this.memory.findCallCardsByPhone(phone);
  }

  async deleteCallCard(chatId: number, messageId: number): Promise<void> {
    await this.memory.deleteCallCard(chatId, messageId);
    await this.persist();
  }

  async saveCallResult(result: CallResultRecord): Promise<void> {
    await this.memory.saveCallResult(result);
    await this.persist();
  }

  async listCallResults(limit?: number): Promise<CallResultRecord[]> {
    return this.memory.listCallResults(limit);
  }

  async hasCallResult(callId: string): Promise<boolean> {
    return this.memory.hasCallResult(callId);
  }

  async findCallResultsByCallId(callId: string): Promise<CallResultRecord[]> {
    return this.memory.findCallResultsByCallId(callId);
  }

  async getCallResult(id: string): Promise<CallResultRecord | null> {
    return this.memory.getCallResult(id);
  }

  async updateCallResult(
    id: string,
    patch: Partial<Pick<CallResultRecord, 'resultMessages' | 'reviewedAt' | 'reviewedByName'>>,
  ): Promise<CallResultRecord | null> {
    const result = await this.memory.updateCallResult(id, patch);
    if (result) await this.persist();
    return result;
  }

  async saveReminder(reminder: Reminder): Promise<void> {
    await this.memory.saveReminder(reminder);
    await this.persist();
  }

  async listDueReminders(nowIso: string): Promise<Reminder[]> {
    return this.memory.listDueReminders(nowIso);
  }

  async markReminderDone(id: string): Promise<void> {
    await this.memory.markReminderDone(id);
    await this.persist();
  }

  async listReminders(limit?: number): Promise<Reminder[]> {
    return this.memory.listReminders(limit);
  }

  async savePrompt(prompt: PendingPrompt): Promise<void> {
    await this.memory.savePrompt(prompt);
    await this.persist();
  }

  async findPromptByMessage(chatId: number, promptMessageId: number): Promise<PendingPrompt | null> {
    return this.memory.findPromptByMessage(chatId, promptMessageId);
  }

  async deletePrompt(id: string): Promise<void> {
    await this.memory.deletePrompt(id);
    await this.persist();
  }

  async saveConsultation(c: ConsultationRequest): Promise<void> {
    await this.memory.saveConsultation(c);
    await this.persist();
  }

  async listConsultations(limit?: number): Promise<ConsultationRequest[]> {
    return this.memory.listConsultations(limit);
  }

  async saveClientLink(link: ClientLink): Promise<void> {
    await this.memory.saveClientLink(link);
    await this.persist();
  }

  async getClientByTelegramId(telegramUserId: number): Promise<ClientLink | null> {
    return this.memory.getClientByTelegramId(telegramUserId);
  }

  async findClientLinksByPhone(phone: string): Promise<ClientLink[]> {
    return this.memory.findClientLinksByPhone(phone);
  }

  async setUserLanguage(telegramUserId: number, lang: string): Promise<void> {
    await this.memory.setUserLanguage(telegramUserId, lang);
    await this.persist();
  }

  async getUserLanguage(telegramUserId: number): Promise<string | null> {
    return this.memory.getUserLanguage(telegramUserId);
  }

  async saveUser(user: User): Promise<void> {
    await this.memory.saveUser(user);
    await this.persist();
  }

  async getUser(id: string): Promise<User | null> {
    return this.memory.getUser(id);
  }

  async getUserByEmail(email: string): Promise<User | null> {
    return this.memory.getUserByEmail(email);
  }

  async listUsers(): Promise<User[]> {
    return this.memory.listUsers();
  }

  async getUserByTelegramId(telegramUserId: number): Promise<User | null> {
    return this.memory.getUserByTelegramId(telegramUserId);
  }

  async updateUser(
    id: string,
    patch: Partial<Pick<User, 'name' | 'email' | 'googleId' | 'role' | 'active' | 'telegramUserId'>>,
  ): Promise<User | null> {
    const result = await this.memory.updateUser(id, patch);
    if (result) await this.persist();
    return result;
  }

  async saveTask(task: Task): Promise<void> {
    await this.memory.saveTask(task);
    await this.persist();
  }

  async getTask(id: string): Promise<Task | null> {
    return this.memory.getTask(id);
  }

  async listTasks(): Promise<Task[]> {
    return this.memory.listTasks();
  }

  async listTasksByAssignee(userId: string): Promise<Task[]> {
    return this.memory.listTasksByAssignee(userId);
  }

  async listDueTaskReminders(nowIso: string): Promise<Task[]> {
    return this.memory.listDueTaskReminders(nowIso);
  }

  async updateTask(
    id: string,
    patch: Partial<
      Pick<Task, 'title' | 'dueAt' | 'status' | 'result' | 'doneAt' | 'doneByName' | 'notifiedAt'>
    >,
  ): Promise<Task | null> {
    const result = await this.memory.updateTask(id, patch);
    if (result) await this.persist();
    return result;
  }

  async saveLinkToken(token: TelegramLinkToken): Promise<void> {
    await this.memory.saveLinkToken(token);
    await this.persist();
  }

  async getLinkToken(token: string): Promise<TelegramLinkToken | null> {
    return this.memory.getLinkToken(token);
  }

  async deleteLinkToken(token: string): Promise<void> {
    await this.memory.deleteLinkToken(token);
    await this.persist();
  }
}
