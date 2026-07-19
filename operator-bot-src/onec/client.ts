// Клиент HTTP-сервисов 1С (portal.runferry.com/api/hs/facebook).
// Ответы 1С нестрогие: могут прийти массивом, JSON-строкой или объектом-обёрткой.

import axios, { type AxiosInstance } from 'axios';
import { normalizePhone } from '../types.js';
import type { AppConfig } from '../config.js';
import {
  OnecApiError,
  OnecNotConfiguredError,
  type CallResultPayload,
  type ClientInformationUpdate,
  type NewRepairRequest,
  type OnecListItem,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 15_000;

// «List» — реальный ключ-обёртка ответов portal.runferry.com (проверено вживую)
const LIST_WRAPPER_KEYS = ['List', 'data', 'list', 'items', 'result'] as const;

/** Приводит нестрогий ответ 1С к массиву элементов. */
export function normalizeList(data: unknown): OnecListItem[] {
  if (data === null || data === undefined) return [];
  if (Array.isArray(data)) return data as OnecListItem[];
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed) return [];
    try {
      return normalizeList(JSON.parse(trimmed));
    } catch {
      return [];
    }
  }
  if (typeof data === 'object') {
    const record = data as Record<string, unknown>;
    for (const key of LIST_WRAPPER_KEYS) {
      const value = record[key];
      if (Array.isArray(value)) return value as OnecListItem[];
    }
    return [record];
  }
  return [];
}

function normalizeItem(data: unknown): OnecListItem {
  return normalizeList(data)[0] ?? {};
}

// 1С отдаёт ошибки обработчика текстом с HTTP 200 (например
// «{HTTPСервис.ad.Модуль(2369)}: Поле об'єкту не виявлено (MiddleName)»).
// Для операций записи такой ответ — это отказ, а не успех.
function strictItem(data: unknown, endpoint: string): OnecListItem {
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (trimmed === '') return {};
    try {
      return normalizeItem(JSON.parse(trimmed));
    } catch {
      throw new OnecApiError(`1С вернула ошибку: ${trimmed}`, undefined, endpoint);
    }
  }
  return normalizeItem(data);
}

function toOnecApiError(error: unknown, endpoint: string): OnecApiError {
  if (error instanceof OnecApiError) return error;
  if (typeof error === 'object' && error !== null) {
    const err = error as { response?: { status?: number }; code?: string; message?: string };
    const status = err.response?.status;
    if (typeof status === 'number') {
      return new OnecApiError(`1С вернула ошибку HTTP ${status} (${endpoint})`, status, endpoint);
    }
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      return new OnecApiError(`1С не ответила вовремя (${endpoint})`, undefined, endpoint);
    }
    return new OnecApiError(
      `Не удалось обратиться к 1С (${endpoint}): ${err.message ?? 'неизвестная ошибка'}`,
      undefined,
      endpoint,
    );
  }
  return new OnecApiError(`Не удалось обратиться к 1С (${endpoint})`, undefined, endpoint);
}

export interface OnecClientOptions {
  baseUrl: string;
  username?: string;
  password?: string;
  callResultPath?: string;
  boatsPath?: string;
  consultationPath?: string;
  /** Отдельный «bot»-сервис 1С (своя база и авторизация), для проданных корабликов. */
  botBaseUrl?: string;
  botUsername?: string;
  botPassword?: string;
  timeoutMs?: number;
}

export class OnecClient {
  private readonly http: AxiosInstance;
  /** Отдельный контур к «bot»-сервису 1С (другая база + Basic Auth). */
  private readonly botHttp?: AxiosInstance;
  private readonly callResultPath?: string;
  private readonly boatsPath?: string;
  private readonly consultationPath?: string;

  constructor(options: OnecClientOptions) {
    this.callResultPath = options.callResultPath;
    this.boatsPath = options.boatsPath;
    this.consultationPath = options.consultationPath;
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.http = axios.create({
      baseURL: options.baseUrl,
      timeout,
      headers: { 'Content-Type': 'application/json' },
      ...(options.username
        ? { auth: { username: options.username, password: options.password ?? '' } }
        : {}),
    });
    if (options.botBaseUrl) {
      this.botHttp = axios.create({
        baseURL: options.botBaseUrl,
        timeout,
        headers: { 'Content-Type': 'application/json' },
        ...(options.botUsername
          ? { auth: { username: options.botUsername, password: options.botPassword ?? '' } }
          : {}),
      });
    }
  }

  private async get(endpoint: string): Promise<unknown> {
    try {
      const response = await this.http.get(endpoint);
      return response.data;
    } catch (error) {
      throw toOnecApiError(error, endpoint);
    }
  }

  private async post(endpoint: string, body: unknown): Promise<unknown> {
    try {
      const response = await this.http.post(endpoint, body);
      return response.data;
    } catch (error) {
      throw toOnecApiError(error, endpoint);
    }
  }

  async getCallHistory(phone: string): Promise<OnecListItem[]> {
    // 1С принимает эти запросы только методом POST (GET -> 405), тело пустое
    const data = await this.post(`/repair/${normalizePhone(phone)}/repair_History`, '');
    return normalizeList(data);
  }

  async getRepairs(phone: string): Promise<OnecListItem[]> {
    const data = await this.post(`/repair/${normalizePhone(phone)}/List`, '');
    return normalizeList(data);
  }

  async getSoldBoats(phone: string): Promise<OnecListItem[]> {
    if (!this.botHttp || !this.boatsPath) {
      throw new OnecNotConfiguredError('проданные кораблики');
    }
    const endpoint = this.boatsPath.replaceAll('{phone}', normalizePhone(phone));
    // «bot»-сервис принимает только POST с пустым телом и требует Basic Auth.
    try {
      const response = await this.botHttp.post(endpoint, '');
      return normalizeList(response.data);
    } catch (error) {
      throw toOnecApiError(error, endpoint);
    }
  }

  async createRepair(req: NewRepairRequest): Promise<OnecListItem> {
    // Обработчик 1С строго читает все поля — отсутствие любого из них даёт
    // ошибку «Поле об'єкту не виявлено», поэтому пустые поля шлём явно.
    const body: NewRepairRequest = {
      LastName: '',
      FirstName: '',
      MiddleName: '',
      ...req,
    };
    const data = await this.post('/repair/repair_NEW', body);
    return strictItem(data, '/repair/repair_NEW');
  }

  async updateClientInformation(
    repairNumber: string,
    data: ClientInformationUpdate,
  ): Promise<OnecListItem> {
    const endpoint = `/repair/${encodeURIComponent(repairNumber)}/ClientInformation`;
    const result = await this.post(endpoint, data);
    return strictItem(result, endpoint);
  }

  /** Детали одного ремонта: GET /repair/{Number} (одиночный объект, не List). */
  async getRepairDetail(repairNumber: string): Promise<OnecListItem> {
    const endpoint = `/repair/${encodeURIComponent(repairNumber)}`;
    const data = await this.get(endpoint);
    if (typeof data === 'string') {
      const trimmed = data.trim();
      if (trimmed === '') return {};
      try {
        return JSON.parse(trimmed) as OnecListItem;
      } catch {
        throw new OnecApiError('1С вернула некорректный ответ', undefined, endpoint);
      }
    }
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      return data as OnecListItem;
    }
    return {};
  }

  async getServiceCenters(): Promise<OnecListItem[]> {
    // «Servoce» — опечатка на стороне 1С, исправлять нельзя.
    const data = await this.get('/repair/repair_ServoceList');
    return normalizeList(data);
  }

  async getServiceTypes(): Promise<OnecListItem[]> {
    const data = await this.get('/repair/repair_ServoceTypeList');
    return normalizeList(data);
  }

  async addComment(requestId: string, text: string): Promise<OnecListItem> {
    const endpoint = `/repair/${encodeURIComponent(requestId)}/comment`;
    const data = await this.post(endpoint, { text });
    return strictItem(data, endpoint);
  }

  /** Резюме разговора в bot-сервис 1С (POST {phone}/FastComment, тело — payload).
   *  Не настроено -> { sent: false } без ошибки; HTTP-ошибка -> OnecApiError. */
  async sendCallResult(payload: CallResultPayload): Promise<{ sent: boolean }> {
    if (!this.botHttp || !this.callResultPath) {
      return { sent: false };
    }
    const endpoint = this.callResultPath.replaceAll('{phone}', normalizePhone(payload.phone));
    try {
      await this.botHttp.post(endpoint, payload);
      return { sent: true };
    } catch (error) {
      throw toOnecApiError(error, endpoint);
    }
  }

  /** Создать консультацию в bot-сервисе 1С (POST {phone}/consultation_NEW, тело { text }).
   *  Не настроено -> { sent: false } без ошибки; HTTP-ошибка -> OnecApiError. */
  async createConsultation(phone: string, text: string): Promise<{ sent: boolean }> {
    if (!this.botHttp || !this.consultationPath) {
      return { sent: false };
    }
    const endpoint = this.consultationPath.replaceAll('{phone}', normalizePhone(phone));
    try {
      await this.botHttp.post(endpoint, { text });
      return { sent: true };
    } catch (error) {
      throw toOnecApiError(error, endpoint);
    }
  }
}

export function createOnecClient(config: AppConfig): OnecClient {
  return new OnecClient({
    baseUrl: config.onec.baseUrl,
    username: config.onec.username,
    password: config.onec.password,
    callResultPath: config.onec.callResultPath,
    boatsPath: config.onec.boatsPath,
    consultationPath: config.onec.consultationPath,
    botBaseUrl: config.onec.botBaseUrl,
    botUsername: config.onec.botUsername,
    botPassword: config.onec.botPassword,
  });
}
