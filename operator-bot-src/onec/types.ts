// Типы для API 1С (HTTP-сервисы portal.runferry.com/api/hs/facebook).
// Ответы 1С приходят в нестрогом формате — работаем через unknown и нормализуем.

/** Запрос создания нового ремонта: POST /repair/repair_NEW */
export interface NewRepairRequest {
  phone_number: string;
  /** Код сервис-центра, напр. "000000001" */
  Service: string;
  /** Описание жалобы/проблемы */
  Disc: string;
  LastName?: string;
  FirstName?: string;
  MiddleName?: string;
  /** GUID города из справочника 1С */
  City?: string;
  /** GUID склада, куда отправить кораблик после ремонта */
  tWarehouse?: string;
  ServiceTypeList?: { ServiceType: string }[];
}

/** Запрос обновления данных клиента: POST /repair/{номер_ремонта}/ClientInformation */
export interface ClientInformationUpdate {
  phone_number: string;
  Service?: string;
  LastName?: string;
  FirstName?: string;
  MiddleName?: string;
  City?: string;
  tWarehouse?: string;
}

/**
 * Фиксация результата разговора — новый эндпоинт, который появится в 1С.
 * Спецификация: docs/integration-1c.md. Путь настраивается через ONEC_CALL_RESULT_PATH.
 */
export interface CallResultPayload {
  callId: string;
  phone: string;
  result: string;
  operatorId: number;
  operatorName: string;
  chatId: number;
  timestamp: string;
}

/** Элемент списка из 1С (звонок, ремонт, кораблик) — формат нестрогий */
export type OnecListItem = Record<string, unknown>;

/** Ошибка вызова API 1С */
export class OnecApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly endpoint?: string,
  ) {
    super(message);
    this.name = 'OnecApiError';
  }
}

/** Эндпоинт не настроен (нет переменной окружения с путём) */
export class OnecNotConfiguredError extends Error {
  constructor(feature: string) {
    super(`Эндпоинт 1С для «${feature}» ещё не настроен`);
    this.name = 'OnecNotConfiguredError';
  }
}
