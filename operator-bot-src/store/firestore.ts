import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { CollectionReference, DocumentData, Firestore } from 'firebase-admin/firestore';
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
import type { Store } from './store.js';

/** Firestore не принимает undefined в полях — вычищаем рекурсивно перед записью. */
function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (val !== undefined) result[key] = stripUndefined(val);
    }
    return result;
  }
  return value;
}

function toDoc(value: object): DocumentData {
  return stripUndefined(value) as DocumentData;
}

const DEFAULT_LIMIT = 100;

/**
 * Продакшен-хранилище в Firestore. Документы — плоские JSON-объекты,
 * даты — строки ISO. Composite-индексы: см. firestore.indexes.json.
 */
export class FirestoreStore implements Store {
  private readonly db: Firestore;

  constructor(projectId?: string) {
    if (getApps().length === 0) {
      initializeApp({ credential: applicationDefault(), projectId });
    }
    this.db = getFirestore();
  }

  private get chats(): CollectionReference {
    return this.db.collection('chats');
  }

  private get threads(): CollectionReference {
    return this.db.collection('threads');
  }

  private get callCards(): CollectionReference {
    return this.db.collection('callCards');
  }

  private get callResults(): CollectionReference {
    return this.db.collection('callResults');
  }

  private get reminders(): CollectionReference {
    return this.db.collection('reminders');
  }

  private get prompts(): CollectionReference {
    return this.db.collection('prompts');
  }

  private get consultations(): CollectionReference {
    return this.db.collection('consultations');
  }

  private get clientLinks(): CollectionReference {
    return this.db.collection('clientLinks');
  }

  private get userLanguages(): CollectionReference {
    return this.db.collection('userLanguages');
  }

  private get users(): CollectionReference {
    return this.db.collection('users');
  }

  private get tasks(): CollectionReference {
    return this.db.collection('tasks');
  }

  private get linkTokens(): CollectionReference {
    return this.db.collection('telegramLinkTokens');
  }

  private cardDocId(chatId: number, messageId: number): string {
    return `${chatId}_${messageId}`;
  }

  private threadDocId(chatId: number, threadId: number): string {
    return `${chatId}_${threadId}`;
  }

  async upsertChat(chat: ChatInfo): Promise<void> {
    await this.chats.doc(String(chat.id)).set(toDoc(chat));
  }

  async getChat(id: number): Promise<ChatInfo | null> {
    const snap = await this.chats.doc(String(id)).get();
    return snap.exists ? (snap.data() as ChatInfo) : null;
  }

  async listChats(): Promise<ChatInfo[]> {
    const snap = await this.chats.get();
    return snap.docs.map((doc) => doc.data() as ChatInfo);
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
    const ref = this.chats.doc(String(id));
    const snap = await ref.get();
    if (!snap.exists) return null;
    const current = snap.data() as ChatInfo;
    const cleanPatch = stripUndefined(patch) as Partial<ChatInfo>;
    const updated: ChatInfo = {
      ...current,
      ...cleanPatch,
      updatedAt: new Date().toISOString(),
    };
    await ref.set(toDoc(updated));
    return updated;
  }

  async upsertThread(thread: ThreadInfo): Promise<void> {
    await this.threads.doc(this.threadDocId(thread.chatId, thread.threadId)).set(toDoc(thread));
  }

  async getThread(chatId: number, threadId: number): Promise<ThreadInfo | null> {
    const snap = await this.threads.doc(this.threadDocId(chatId, threadId)).get();
    return snap.exists ? (snap.data() as ThreadInfo) : null;
  }

  async listThreads(chatId?: number): Promise<ThreadInfo[]> {
    const query = chatId === undefined ? this.threads : this.threads.where('chatId', '==', chatId);
    const snap = await query.get();
    return snap.docs.map((doc) => doc.data() as ThreadInfo);
  }

  async updateThread(
    chatId: number,
    threadId: number,
    patch: Partial<
      Pick<ThreadInfo, 'active' | 'events' | 'name' | 'isArchive' | 'isResults' | 'employeeIds'>
    >,
  ): Promise<ThreadInfo | null> {
    const ref = this.threads.doc(this.threadDocId(chatId, threadId));
    const snap = await ref.get();
    if (!snap.exists) return null;
    const current = snap.data() as ThreadInfo;
    const updated: ThreadInfo = {
      ...current,
      ...(stripUndefined(patch) as Partial<ThreadInfo>),
      updatedAt: new Date().toISOString(),
    };
    await ref.set(toDoc(updated));
    return updated;
  }

  async saveCallCard(ref: CallCardRef): Promise<void> {
    await this.callCards.doc(this.cardDocId(ref.chatId, ref.messageId)).set(toDoc(ref));
  }

  async findCallCard(chatId: number, messageId: number): Promise<CallCardRef | null> {
    const snap = await this.callCards.doc(this.cardDocId(chatId, messageId)).get();
    return snap.exists ? (snap.data() as CallCardRef) : null;
  }

  async findCallCardsByCallId(callId: string): Promise<CallCardRef[]> {
    const snap = await this.callCards.where('callId', '==', callId).get();
    return snap.docs.map((doc) => doc.data() as CallCardRef);
  }

  async findCallCardsByPhone(phone: string): Promise<CallCardRef[]> {
    const snap = await this.callCards.where('phone', '==', phone).get();
    return snap.docs.map((doc) => doc.data() as CallCardRef);
  }

  async deleteCallCard(chatId: number, messageId: number): Promise<void> {
    await this.callCards.doc(this.cardDocId(chatId, messageId)).delete();
  }

  async saveCallResult(result: CallResultRecord): Promise<void> {
    await this.callResults.doc(result.id).set(toDoc(result));
  }

  async listCallResults(limit = DEFAULT_LIMIT): Promise<CallResultRecord[]> {
    const snap = await this.callResults.orderBy('createdAt', 'desc').limit(limit).get();
    return snap.docs.map((doc) => doc.data() as CallResultRecord);
  }

  async hasCallResult(callId: string): Promise<boolean> {
    const snap = await this.callResults.where('callId', '==', callId).limit(1).get();
    return !snap.empty;
  }

  async findCallResultsByCallId(callId: string): Promise<CallResultRecord[]> {
    const snap = await this.callResults.where('callId', '==', callId).get();
    return snap.docs.map((doc) => doc.data() as CallResultRecord);
  }

  async getCallResult(id: string): Promise<CallResultRecord | null> {
    const snap = await this.callResults.doc(id).get();
    return snap.exists ? (snap.data() as CallResultRecord) : null;
  }

  async updateCallResult(
    id: string,
    patch: Partial<Pick<CallResultRecord, 'resultMessages' | 'reviewedAt' | 'reviewedByName'>>,
  ): Promise<CallResultRecord | null> {
    const ref = this.callResults.doc(id);
    const snap = await ref.get();
    if (!snap.exists) return null;
    // Точечный update() вместо set() всего документа: параллельные патчи разных
    // полей (resultMessages из публикации и reviewedAt из «Принято») не затирают
    // друг друга.
    const clean = toDoc(patch);
    if (Object.keys(clean).length > 0) await ref.update(clean);
    const after = await ref.get();
    return after.exists ? (after.data() as CallResultRecord) : null;
  }

  async saveReminder(reminder: Reminder): Promise<void> {
    await this.reminders.doc(reminder.id).set(toDoc(reminder));
  }

  async listDueReminders(nowIso: string): Promise<Reminder[]> {
    const snap = await this.reminders
      .where('done', '==', false)
      .where('dueAt', '<=', nowIso)
      .get();
    return snap.docs.map((doc) => doc.data() as Reminder);
  }

  async markReminderDone(id: string): Promise<void> {
    const ref = this.reminders.doc(id);
    const snap = await ref.get();
    if (snap.exists) {
      await ref.update({ done: true });
    }
  }

  async listReminders(limit = DEFAULT_LIMIT): Promise<Reminder[]> {
    const snap = await this.reminders.orderBy('dueAt', 'asc').limit(limit).get();
    return snap.docs.map((doc) => doc.data() as Reminder);
  }

  async savePrompt(prompt: PendingPrompt): Promise<void> {
    await this.prompts.doc(prompt.id).set(toDoc(prompt));
  }

  async findPromptByMessage(chatId: number, promptMessageId: number): Promise<PendingPrompt | null> {
    const snap = await this.prompts
      .where('chatId', '==', chatId)
      .where('promptMessageId', '==', promptMessageId)
      .limit(1)
      .get();
    if (snap.empty) return null;
    return snap.docs[0].data() as PendingPrompt;
  }

  async deletePrompt(id: string): Promise<void> {
    await this.prompts.doc(id).delete();
  }

  async saveConsultation(c: ConsultationRequest): Promise<void> {
    await this.consultations.doc(c.id).set(toDoc(c));
  }

  async listConsultations(limit = DEFAULT_LIMIT): Promise<ConsultationRequest[]> {
    const snap = await this.consultations.orderBy('createdAt', 'desc').limit(limit).get();
    return snap.docs.map((doc) => doc.data() as ConsultationRequest);
  }

  async saveClientLink(link: ClientLink): Promise<void> {
    await this.clientLinks.doc(String(link.telegramUserId)).set(toDoc(link));
  }

  async getClientByTelegramId(telegramUserId: number): Promise<ClientLink | null> {
    const snap = await this.clientLinks.doc(String(telegramUserId)).get();
    return snap.exists ? (snap.data() as ClientLink) : null;
  }

  async findClientLinksByPhone(phone: string): Promise<ClientLink[]> {
    const snap = await this.clientLinks.where('phone', '==', phone).get();
    return snap.docs.map((doc) => doc.data() as ClientLink);
  }

  async setUserLanguage(telegramUserId: number, lang: string): Promise<void> {
    await this.userLanguages.doc(String(telegramUserId)).set({ lang });
  }

  async getUserLanguage(telegramUserId: number): Promise<string | null> {
    const snap = await this.userLanguages.doc(String(telegramUserId)).get();
    const data = snap.data();
    return data && typeof data.lang === 'string' ? data.lang : null;
  }

  async saveUser(user: User): Promise<void> {
    await this.users.doc(user.id).set(toDoc(user));
  }

  async getUser(id: string): Promise<User | null> {
    const snap = await this.users.doc(id).get();
    return snap.exists ? (snap.data() as User) : null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const snap = await this.users.where('email', '==', email.trim().toLowerCase()).limit(1).get();
    return snap.empty ? null : (snap.docs[0].data() as User);
  }

  async listUsers(): Promise<User[]> {
    const snap = await this.users.get();
    return snap.docs.map((doc) => doc.data() as User);
  }

  async getUserByTelegramId(telegramUserId: number): Promise<User | null> {
    const snap = await this.users.where('telegramUserId', '==', telegramUserId).limit(1).get();
    return snap.empty ? null : (snap.docs[0].data() as User);
  }

  async updateUser(
    id: string,
    patch: Partial<Pick<User, 'name' | 'email' | 'googleId' | 'role' | 'active' | 'telegramUserId'>>,
  ): Promise<User | null> {
    const ref = this.users.doc(id);
    const snap = await ref.get();
    if (!snap.exists) return null;
    const current = snap.data() as User;
    const updated: User = {
      ...current,
      ...(stripUndefined(patch) as Partial<User>),
      updatedAt: new Date().toISOString(),
    };
    await ref.set(toDoc(updated));
    return updated;
  }

  async saveTask(task: Task): Promise<void> {
    await this.tasks.doc(task.id).set(toDoc(task));
  }

  async getTask(id: string): Promise<Task | null> {
    const snap = await this.tasks.doc(id).get();
    return snap.exists ? (snap.data() as Task) : null;
  }

  async listTasks(): Promise<Task[]> {
    const snap = await this.tasks.get();
    return snap.docs.map((doc) => doc.data() as Task);
  }

  async listTasksByAssignee(userId: string): Promise<Task[]> {
    const snap = await this.tasks.where('assigneeUserId', '==', userId).get();
    return snap.docs.map((doc) => doc.data() as Task);
  }

  async listDueTaskReminders(nowIso: string): Promise<Task[]> {
    // Композитный индекс: kind + status + dueAt (см. firestore.indexes.json).
    const snap = await this.tasks
      .where('kind', '==', 'reminder')
      .where('status', '==', 'open')
      .where('dueAt', '<=', nowIso)
      .get();
    return snap.docs.map((doc) => doc.data() as Task).filter((t) => !t.notifiedAt);
  }

  async updateTask(
    id: string,
    patch: Partial<
      Pick<Task, 'title' | 'dueAt' | 'status' | 'result' | 'doneAt' | 'doneByName' | 'notifiedAt'>
    >,
  ): Promise<Task | null> {
    const ref = this.tasks.doc(id);
    const snap = await ref.get();
    if (!snap.exists) return null;
    const current = snap.data() as Task;
    const updated: Task = {
      ...current,
      ...(stripUndefined(patch) as Partial<Task>),
      updatedAt: new Date().toISOString(),
    };
    await ref.set(toDoc(updated));
    return updated;
  }

  async saveLinkToken(token: TelegramLinkToken): Promise<void> {
    await this.linkTokens.doc(token.token).set(toDoc(token));
  }

  async getLinkToken(token: string): Promise<TelegramLinkToken | null> {
    const snap = await this.linkTokens.doc(token).get();
    return snap.exists ? (snap.data() as TelegramLinkToken) : null;
  }

  async deleteLinkToken(token: string): Promise<void> {
    await this.linkTokens.doc(token).delete();
  }
}
