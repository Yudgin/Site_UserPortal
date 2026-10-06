/** Хранилище в памяти процесса — для локальной разработки и тестов. */
export class MemoryStore {
    chats = new Map();
    threads = new Map();
    callCards = new Map();
    callResults = [];
    reminders = new Map();
    prompts = new Map();
    consultations = [];
    clientLinks = new Map();
    userLanguages = new Map();
    users = new Map();
    tasks = new Map();
    linkTokens = new Map();
    cardKey(chatId, messageId) {
        return `${chatId}:${messageId}`;
    }
    threadKey(chatId, threadId) {
        return `${chatId}:${threadId}`;
    }
    async upsertChat(chat) {
        this.chats.set(chat.id, { ...chat });
    }
    async getChat(id) {
        const chat = this.chats.get(id);
        return chat ? { ...chat } : null;
    }
    async listChats() {
        return [...this.chats.values()].map((c) => ({ ...c }));
    }
    async updateChat(id, patch) {
        const chat = this.chats.get(id);
        if (!chat)
            return null;
        const updated = { ...chat, ...patch, updatedAt: new Date().toISOString() };
        this.chats.set(id, updated);
        return { ...updated };
    }
    async upsertThread(thread) {
        this.threads.set(this.threadKey(thread.chatId, thread.threadId), { ...thread });
    }
    async getThread(chatId, threadId) {
        const thread = this.threads.get(this.threadKey(chatId, threadId));
        return thread ? { ...thread } : null;
    }
    async listThreads(chatId) {
        const all = [...this.threads.values()].map((t) => ({ ...t }));
        return chatId === undefined ? all : all.filter((t) => t.chatId === chatId);
    }
    async updateThread(chatId, threadId, patch) {
        const key = this.threadKey(chatId, threadId);
        const thread = this.threads.get(key);
        if (!thread)
            return null;
        const updated = { ...thread, ...patch, updatedAt: new Date().toISOString() };
        this.threads.set(key, updated);
        return { ...updated };
    }
    async saveCallCard(ref) {
        this.callCards.set(this.cardKey(ref.chatId, ref.messageId), { ...ref });
    }
    async findCallCard(chatId, messageId) {
        const ref = this.callCards.get(this.cardKey(chatId, messageId));
        return ref ? { ...ref } : null;
    }
    async findCallCardsByCallId(callId) {
        return [...this.callCards.values()].filter((c) => c.callId === callId).map((c) => ({ ...c }));
    }
    async findCallCardsByPhone(phone) {
        return [...this.callCards.values()].filter((c) => c.phone === phone).map((c) => ({ ...c }));
    }
    async deleteCallCard(chatId, messageId) {
        this.callCards.delete(this.cardKey(chatId, messageId));
    }
    async saveCallResult(result) {
        this.callResults.push({ ...result });
    }
    async listCallResults(limit = 100) {
        return [...this.callResults]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, limit);
    }
    async hasCallResult(callId) {
        return this.callResults.some((r) => r.callId === callId);
    }
    async findCallResultsByCallId(callId) {
        return this.callResults.filter((r) => r.callId === callId).map((r) => ({ ...r }));
    }
    async getCallResult(id) {
        const found = this.callResults.find((r) => r.id === id);
        return found ? { ...found } : null;
    }
    async updateCallResult(id, patch) {
        const index = this.callResults.findIndex((r) => r.id === id);
        if (index === -1)
            return null;
        const updated = { ...this.callResults[index], ...patch };
        this.callResults[index] = updated;
        return { ...updated };
    }
    async saveReminder(reminder) {
        this.reminders.set(reminder.id, { ...reminder });
    }
    async listDueReminders(nowIso) {
        return [...this.reminders.values()]
            .filter((r) => !r.done && r.dueAt <= nowIso)
            .map((r) => ({ ...r }));
    }
    async markReminderDone(id) {
        const reminder = this.reminders.get(id);
        if (reminder) {
            this.reminders.set(id, { ...reminder, done: true });
        }
    }
    async listReminders(limit = 100) {
        return [...this.reminders.values()]
            .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
            .slice(0, limit);
    }
    /** Полный список карточек — нужен FileStore для сериализации. */
    async listCallCards() {
        return [...this.callCards.values()].map((c) => ({ ...c }));
    }
    /** Полный список ожиданий ответа — нужен FileStore для сериализации. */
    async listPrompts() {
        return [...this.prompts.values()].map((p) => ({ ...p }));
    }
    /** Полный список связок клиентов — нужен FileStore для сериализации. */
    async listClientLinks() {
        return [...this.clientLinks.values()].map((c) => ({ ...c }));
    }
    async savePrompt(prompt) {
        this.prompts.set(prompt.id, { ...prompt });
    }
    async findPromptByMessage(chatId, promptMessageId) {
        for (const prompt of this.prompts.values()) {
            if (prompt.chatId === chatId && prompt.promptMessageId === promptMessageId) {
                return { ...prompt };
            }
        }
        return null;
    }
    async deletePrompt(id) {
        this.prompts.delete(id);
    }
    async saveConsultation(c) {
        this.consultations.push({ ...c });
    }
    async listConsultations(limit = 100) {
        return [...this.consultations]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, limit);
    }
    async saveClientLink(link) {
        this.clientLinks.set(link.telegramUserId, { ...link });
    }
    async getClientByTelegramId(telegramUserId) {
        const link = this.clientLinks.get(telegramUserId);
        return link ? { ...link } : null;
    }
    async findClientLinksByPhone(phone) {
        return [...this.clientLinks.values()].filter((c) => c.phone === phone).map((c) => ({ ...c }));
    }
    async setUserLanguage(telegramUserId, lang) {
        this.userLanguages.set(telegramUserId, lang);
    }
    async getUserLanguage(telegramUserId) {
        return this.userLanguages.get(telegramUserId) ?? null;
    }
    /** Полный список языков пользователей — нужен FileStore для сериализации. */
    async listUserLanguages() {
        return [...this.userLanguages.entries()];
    }
    async saveUser(user) {
        this.users.set(user.id, { ...user });
    }
    async getUser(id) {
        const user = this.users.get(id);
        return user ? { ...user } : null;
    }
    async getUserByEmail(email) {
        const target = email.trim().toLowerCase();
        for (const user of this.users.values()) {
            if (user.email && user.email.toLowerCase() === target)
                return { ...user };
        }
        return null;
    }
    async listUsers() {
        return [...this.users.values()].map((u) => ({ ...u }));
    }
    async getUserByTelegramId(telegramUserId) {
        for (const user of this.users.values()) {
            if (user.telegramUserId === telegramUserId)
                return { ...user };
        }
        return null;
    }
    async updateUser(id, patch) {
        const user = this.users.get(id);
        if (!user)
            return null;
        const updated = { ...user, ...patch, updatedAt: new Date().toISOString() };
        this.users.set(id, updated);
        return { ...updated };
    }
    async saveTask(task) {
        this.tasks.set(task.id, { ...task });
    }
    async getTask(id) {
        const task = this.tasks.get(id);
        return task ? { ...task } : null;
    }
    async listTasks() {
        return [...this.tasks.values()].map((t) => ({ ...t }));
    }
    async listTasksByAssignee(userId) {
        return [...this.tasks.values()].filter((t) => t.assigneeUserId === userId).map((t) => ({ ...t }));
    }
    async listDueTaskReminders(nowIso) {
        return [...this.tasks.values()]
            .filter((t) => t.kind === 'reminder' &&
            t.status === 'open' &&
            !t.notifiedAt &&
            t.dueAt !== undefined &&
            t.dueAt <= nowIso)
            .map((t) => ({ ...t }));
    }
    async updateTask(id, patch) {
        const task = this.tasks.get(id);
        if (!task)
            return null;
        const updated = { ...task, ...patch, updatedAt: new Date().toISOString() };
        this.tasks.set(id, updated);
        return { ...updated };
    }
    async saveLinkToken(token) {
        this.linkTokens.set(token.token, { ...token });
    }
    async getLinkToken(token) {
        const found = this.linkTokens.get(token);
        return found ? { ...found } : null;
    }
    async deleteLinkToken(token) {
        this.linkTokens.delete(token);
    }
    /** Полный список токенов привязки — нужен FileStore для сериализации. */
    async listLinkTokens() {
        return [...this.linkTokens.values()].map((t) => ({ ...t }));
    }
}
