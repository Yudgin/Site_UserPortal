import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MemoryStore } from './store.js';
/**
 * Файловое хранилище для локальной разработки: переживает перезапуски
 * tsx watch, чтобы не добавлять бота в группы заново после каждой правки.
 * Не для продакшена — там Firestore.
 */
export class FileStore {
    filePath;
    memory = new MemoryStore();
    constructor(filePath) {
        this.filePath = filePath;
        this.loadFromDisk();
    }
    loadFromDisk() {
        let raw;
        try {
            raw = readFileSync(this.filePath, 'utf8');
        }
        catch {
            return; // файла ещё нет — начинаем с пустого состояния
        }
        try {
            const state = JSON.parse(raw);
            void this.seed(state);
        }
        catch (err) {
            console.error(`Не удалось прочитать ${this.filePath} — начинаю с пустого состояния:`, err);
        }
    }
    async seed(state) {
        for (const chat of state.chats ?? [])
            await this.memory.upsertChat(chat);
        for (const thread of state.threads ?? [])
            await this.memory.upsertThread(thread);
        for (const card of state.callCards ?? [])
            await this.memory.saveCallCard(card);
        for (const result of state.callResults ?? [])
            await this.memory.saveCallResult(result);
        for (const reminder of state.reminders ?? [])
            await this.memory.saveReminder(reminder);
        for (const prompt of state.prompts ?? [])
            await this.memory.savePrompt(prompt);
        for (const c of state.consultations ?? [])
            await this.memory.saveConsultation(c);
        for (const link of state.clientLinks ?? [])
            await this.memory.saveClientLink(link);
        for (const [id, lang] of state.userLanguages ?? [])
            await this.memory.setUserLanguage(id, lang);
        for (const user of state.users ?? [])
            await this.memory.saveUser(user);
        for (const task of state.tasks ?? [])
            await this.memory.saveTask(task);
        for (const lt of state.linkTokens ?? [])
            await this.memory.saveLinkToken(lt);
    }
    async persist() {
        const state = {
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
    async upsertChat(chat) {
        await this.memory.upsertChat(chat);
        await this.persist();
    }
    async getChat(id) {
        return this.memory.getChat(id);
    }
    async listChats() {
        return this.memory.listChats();
    }
    async updateChat(id, patch) {
        const result = await this.memory.updateChat(id, patch);
        if (result)
            await this.persist();
        return result;
    }
    async upsertThread(thread) {
        await this.memory.upsertThread(thread);
        await this.persist();
    }
    async getThread(chatId, threadId) {
        return this.memory.getThread(chatId, threadId);
    }
    async listThreads(chatId) {
        return this.memory.listThreads(chatId);
    }
    async updateThread(chatId, threadId, patch) {
        const result = await this.memory.updateThread(chatId, threadId, patch);
        if (result)
            await this.persist();
        return result;
    }
    async saveCallCard(ref) {
        await this.memory.saveCallCard(ref);
        await this.persist();
    }
    async findCallCard(chatId, messageId) {
        return this.memory.findCallCard(chatId, messageId);
    }
    async findCallCardsByCallId(callId) {
        return this.memory.findCallCardsByCallId(callId);
    }
    async findCallCardsByPhone(phone) {
        return this.memory.findCallCardsByPhone(phone);
    }
    async deleteCallCard(chatId, messageId) {
        await this.memory.deleteCallCard(chatId, messageId);
        await this.persist();
    }
    async saveCallResult(result) {
        await this.memory.saveCallResult(result);
        await this.persist();
    }
    async listCallResults(limit) {
        return this.memory.listCallResults(limit);
    }
    async hasCallResult(callId) {
        return this.memory.hasCallResult(callId);
    }
    async findCallResultsByCallId(callId) {
        return this.memory.findCallResultsByCallId(callId);
    }
    async getCallResult(id) {
        return this.memory.getCallResult(id);
    }
    async updateCallResult(id, patch) {
        const result = await this.memory.updateCallResult(id, patch);
        if (result)
            await this.persist();
        return result;
    }
    async saveReminder(reminder) {
        await this.memory.saveReminder(reminder);
        await this.persist();
    }
    async listDueReminders(nowIso) {
        return this.memory.listDueReminders(nowIso);
    }
    async markReminderDone(id) {
        await this.memory.markReminderDone(id);
        await this.persist();
    }
    async listReminders(limit) {
        return this.memory.listReminders(limit);
    }
    async savePrompt(prompt) {
        await this.memory.savePrompt(prompt);
        await this.persist();
    }
    async findPromptByMessage(chatId, promptMessageId) {
        return this.memory.findPromptByMessage(chatId, promptMessageId);
    }
    async deletePrompt(id) {
        await this.memory.deletePrompt(id);
        await this.persist();
    }
    async saveConsultation(c) {
        await this.memory.saveConsultation(c);
        await this.persist();
    }
    async listConsultations(limit) {
        return this.memory.listConsultations(limit);
    }
    async saveClientLink(link) {
        await this.memory.saveClientLink(link);
        await this.persist();
    }
    async getClientByTelegramId(telegramUserId) {
        return this.memory.getClientByTelegramId(telegramUserId);
    }
    async findClientLinksByPhone(phone) {
        return this.memory.findClientLinksByPhone(phone);
    }
    async setUserLanguage(telegramUserId, lang) {
        await this.memory.setUserLanguage(telegramUserId, lang);
        await this.persist();
    }
    async getUserLanguage(telegramUserId) {
        return this.memory.getUserLanguage(telegramUserId);
    }
    async saveUser(user) {
        await this.memory.saveUser(user);
        await this.persist();
    }
    async getUser(id) {
        return this.memory.getUser(id);
    }
    async getUserByEmail(email) {
        return this.memory.getUserByEmail(email);
    }
    async listUsers() {
        return this.memory.listUsers();
    }
    async getUserByTelegramId(telegramUserId) {
        return this.memory.getUserByTelegramId(telegramUserId);
    }
    async updateUser(id, patch) {
        const result = await this.memory.updateUser(id, patch);
        if (result)
            await this.persist();
        return result;
    }
    async saveTask(task) {
        await this.memory.saveTask(task);
        await this.persist();
    }
    async getTask(id) {
        return this.memory.getTask(id);
    }
    async listTasks() {
        return this.memory.listTasks();
    }
    async listTasksByAssignee(userId) {
        return this.memory.listTasksByAssignee(userId);
    }
    async listDueTaskReminders(nowIso) {
        return this.memory.listDueTaskReminders(nowIso);
    }
    async updateTask(id, patch) {
        const result = await this.memory.updateTask(id, patch);
        if (result)
            await this.persist();
        return result;
    }
    async saveLinkToken(token) {
        await this.memory.saveLinkToken(token);
        await this.persist();
    }
    async getLinkToken(token) {
        return this.memory.getLinkToken(token);
    }
    async deleteLinkToken(token) {
        await this.memory.deleteLinkToken(token);
        await this.persist();
    }
}
