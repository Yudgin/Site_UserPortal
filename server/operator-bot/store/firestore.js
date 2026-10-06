import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
/** Firestore не принимает undefined в полях — вычищаем рекурсивно перед записью. */
function stripUndefined(value) {
    if (Array.isArray(value))
        return value.map(stripUndefined);
    if (value !== null && typeof value === 'object') {
        const result = {};
        for (const [key, val] of Object.entries(value)) {
            if (val !== undefined)
                result[key] = stripUndefined(val);
        }
        return result;
    }
    return value;
}
function toDoc(value) {
    return stripUndefined(value);
}
const DEFAULT_LIMIT = 100;
/**
 * Продакшен-хранилище в Firestore. Документы — плоские JSON-объекты,
 * даты — строки ISO. Composite-индексы: см. firestore.indexes.json.
 */
export class FirestoreStore {
    db;
    // RunFerry-портал: имена коллекций переопределяются (префикс + явная карта), чтобы бот,
    // живущий в одном Firestore с порталом, не пересекался с его коллекциями (users, callResults…).
    names;
    constructor(projectId, opts = {}) {
        if (getApps().length === 0) {
            initializeApp({ credential: applicationDefault(), projectId });
        }
        this.db = getFirestore();
        const prefix = opts.collectionPrefix ?? '';
        const base = ['chats', 'threads', 'callCards', 'callResults', 'reminders', 'prompts', 'consultations', 'clientLinks', 'userLanguages', 'users', 'tasks', 'telegramLinkTokens'];
        this.names = Object.fromEntries(base.map((n) => [n, opts.collectionNames?.[n] ?? `${prefix}${n}`]));
    }
    get chats() {
        return this.db.collection(this.names['chats']);
    }
    get threads() {
        return this.db.collection(this.names['threads']);
    }
    get callCards() {
        return this.db.collection(this.names['callCards']);
    }
    get callResults() {
        return this.db.collection(this.names['callResults']);
    }
    get reminders() {
        return this.db.collection(this.names['reminders']);
    }
    get prompts() {
        return this.db.collection(this.names['prompts']);
    }
    get consultations() {
        return this.db.collection(this.names['consultations']);
    }
    get clientLinks() {
        return this.db.collection(this.names['clientLinks']);
    }
    get userLanguages() {
        return this.db.collection(this.names['userLanguages']);
    }
    get users() {
        return this.db.collection(this.names['users']);
    }
    get tasks() {
        return this.db.collection(this.names['tasks']);
    }
    get linkTokens() {
        return this.db.collection(this.names['telegramLinkTokens']);
    }
    cardDocId(chatId, messageId) {
        return `${chatId}_${messageId}`;
    }
    threadDocId(chatId, threadId) {
        return `${chatId}_${threadId}`;
    }
    async upsertChat(chat) {
        await this.chats.doc(String(chat.id)).set(toDoc(chat));
    }
    async getChat(id) {
        const snap = await this.chats.doc(String(id)).get();
        return snap.exists ? snap.data() : null;
    }
    async listChats() {
        const snap = await this.chats.get();
        return snap.docs.map((doc) => doc.data());
    }
    async updateChat(id, patch) {
        const ref = this.chats.doc(String(id));
        const snap = await ref.get();
        if (!snap.exists)
            return null;
        const current = snap.data();
        const cleanPatch = stripUndefined(patch);
        const updated = {
            ...current,
            ...cleanPatch,
            updatedAt: new Date().toISOString(),
        };
        await ref.set(toDoc(updated));
        return updated;
    }
    async upsertThread(thread) {
        await this.threads.doc(this.threadDocId(thread.chatId, thread.threadId)).set(toDoc(thread));
    }
    async getThread(chatId, threadId) {
        const snap = await this.threads.doc(this.threadDocId(chatId, threadId)).get();
        return snap.exists ? snap.data() : null;
    }
    async listThreads(chatId) {
        const query = chatId === undefined ? this.threads : this.threads.where('chatId', '==', chatId);
        const snap = await query.get();
        return snap.docs.map((doc) => doc.data());
    }
    async updateThread(chatId, threadId, patch) {
        const ref = this.threads.doc(this.threadDocId(chatId, threadId));
        const snap = await ref.get();
        if (!snap.exists)
            return null;
        const current = snap.data();
        const updated = {
            ...current,
            ...stripUndefined(patch),
            updatedAt: new Date().toISOString(),
        };
        await ref.set(toDoc(updated));
        return updated;
    }
    async saveCallCard(ref) {
        await this.callCards.doc(this.cardDocId(ref.chatId, ref.messageId)).set(toDoc(ref));
    }
    async findCallCard(chatId, messageId) {
        const snap = await this.callCards.doc(this.cardDocId(chatId, messageId)).get();
        return snap.exists ? snap.data() : null;
    }
    async findCallCardsByCallId(callId) {
        const snap = await this.callCards.where('callId', '==', callId).get();
        return snap.docs.map((doc) => doc.data());
    }
    async findCallCardsByPhone(phone) {
        const snap = await this.callCards.where('phone', '==', phone).get();
        return snap.docs.map((doc) => doc.data());
    }
    async deleteCallCard(chatId, messageId) {
        await this.callCards.doc(this.cardDocId(chatId, messageId)).delete();
    }
    async saveCallResult(result) {
        await this.callResults.doc(result.id).set(toDoc(result));
    }
    async listCallResults(limit = DEFAULT_LIMIT) {
        const snap = await this.callResults.orderBy('createdAt', 'desc').limit(limit).get();
        return snap.docs.map((doc) => doc.data());
    }
    async hasCallResult(callId) {
        const snap = await this.callResults.where('callId', '==', callId).limit(1).get();
        return !snap.empty;
    }
    async findCallResultsByCallId(callId) {
        const snap = await this.callResults.where('callId', '==', callId).get();
        return snap.docs.map((doc) => doc.data());
    }
    async getCallResult(id) {
        const snap = await this.callResults.doc(id).get();
        return snap.exists ? snap.data() : null;
    }
    async updateCallResult(id, patch) {
        const ref = this.callResults.doc(id);
        const snap = await ref.get();
        if (!snap.exists)
            return null;
        // Точечный update() вместо set() всего документа: параллельные патчи разных
        // полей (resultMessages из публикации и reviewedAt из «Принято») не затирают
        // друг друга.
        const clean = toDoc(patch);
        if (Object.keys(clean).length > 0)
            await ref.update(clean);
        const after = await ref.get();
        return after.exists ? after.data() : null;
    }
    async saveReminder(reminder) {
        await this.reminders.doc(reminder.id).set(toDoc(reminder));
    }
    async listDueReminders(nowIso) {
        const snap = await this.reminders
            .where('done', '==', false)
            .where('dueAt', '<=', nowIso)
            .get();
        return snap.docs.map((doc) => doc.data());
    }
    async markReminderDone(id) {
        const ref = this.reminders.doc(id);
        const snap = await ref.get();
        if (snap.exists) {
            await ref.update({ done: true });
        }
    }
    async listReminders(limit = DEFAULT_LIMIT) {
        const snap = await this.reminders.orderBy('dueAt', 'asc').limit(limit).get();
        return snap.docs.map((doc) => doc.data());
    }
    async savePrompt(prompt) {
        await this.prompts.doc(prompt.id).set(toDoc(prompt));
    }
    async findPromptByMessage(chatId, promptMessageId) {
        const snap = await this.prompts
            .where('chatId', '==', chatId)
            .where('promptMessageId', '==', promptMessageId)
            .limit(1)
            .get();
        if (snap.empty)
            return null;
        return snap.docs[0].data();
    }
    async deletePrompt(id) {
        await this.prompts.doc(id).delete();
    }
    async saveConsultation(c) {
        await this.consultations.doc(c.id).set(toDoc(c));
    }
    async listConsultations(limit = DEFAULT_LIMIT) {
        const snap = await this.consultations.orderBy('createdAt', 'desc').limit(limit).get();
        return snap.docs.map((doc) => doc.data());
    }
    async saveClientLink(link) {
        await this.clientLinks.doc(String(link.telegramUserId)).set(toDoc(link));
    }
    async getClientByTelegramId(telegramUserId) {
        const snap = await this.clientLinks.doc(String(telegramUserId)).get();
        return snap.exists ? snap.data() : null;
    }
    async findClientLinksByPhone(phone) {
        const snap = await this.clientLinks.where('phone', '==', phone).get();
        return snap.docs.map((doc) => doc.data());
    }
    async setUserLanguage(telegramUserId, lang) {
        await this.userLanguages.doc(String(telegramUserId)).set({ lang });
    }
    async getUserLanguage(telegramUserId) {
        const snap = await this.userLanguages.doc(String(telegramUserId)).get();
        const data = snap.data();
        return data && typeof data.lang === 'string' ? data.lang : null;
    }
    async saveUser(user) {
        await this.users.doc(user.id).set(toDoc(user));
    }
    async getUser(id) {
        const snap = await this.users.doc(id).get();
        return snap.exists ? snap.data() : null;
    }
    async getUserByEmail(email) {
        const snap = await this.users.where('email', '==', email.trim().toLowerCase()).limit(1).get();
        return snap.empty ? null : snap.docs[0].data();
    }
    async listUsers() {
        const snap = await this.users.get();
        return snap.docs.map((doc) => doc.data());
    }
    async getUserByTelegramId(telegramUserId) {
        const snap = await this.users.where('telegramUserId', '==', telegramUserId).limit(1).get();
        return snap.empty ? null : snap.docs[0].data();
    }
    async updateUser(id, patch) {
        const ref = this.users.doc(id);
        const snap = await ref.get();
        if (!snap.exists)
            return null;
        const current = snap.data();
        const updated = {
            ...current,
            ...stripUndefined(patch),
            updatedAt: new Date().toISOString(),
        };
        await ref.set(toDoc(updated));
        return updated;
    }
    async saveTask(task) {
        await this.tasks.doc(task.id).set(toDoc(task));
    }
    async getTask(id) {
        const snap = await this.tasks.doc(id).get();
        return snap.exists ? snap.data() : null;
    }
    async listTasks() {
        const snap = await this.tasks.get();
        return snap.docs.map((doc) => doc.data());
    }
    async listTasksByAssignee(userId) {
        const snap = await this.tasks.where('assigneeUserId', '==', userId).get();
        return snap.docs.map((doc) => doc.data());
    }
    async listDueTaskReminders(nowIso) {
        // Композитный индекс: kind + status + dueAt (см. firestore.indexes.json).
        const snap = await this.tasks
            .where('kind', '==', 'reminder')
            .where('status', '==', 'open')
            .where('dueAt', '<=', nowIso)
            .get();
        return snap.docs.map((doc) => doc.data()).filter((t) => !t.notifiedAt);
    }
    async updateTask(id, patch) {
        const ref = this.tasks.doc(id);
        const snap = await ref.get();
        if (!snap.exists)
            return null;
        const current = snap.data();
        const updated = {
            ...current,
            ...stripUndefined(patch),
            updatedAt: new Date().toISOString(),
        };
        await ref.set(toDoc(updated));
        return updated;
    }
    async saveLinkToken(token) {
        await this.linkTokens.doc(token.token).set(toDoc(token));
    }
    async getLinkToken(token) {
        const snap = await this.linkTokens.doc(token).get();
        return snap.exists ? snap.data() : null;
    }
    async deleteLinkToken(token) {
        await this.linkTokens.doc(token).delete();
    }
}
