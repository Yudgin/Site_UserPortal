// Типы для API 1С (HTTP-сервисы portal.runferry.com/api/hs/facebook).
// Ответы 1С приходят в нестрогом формате — работаем через unknown и нормализуем.
/** Ошибка вызова API 1С */
export class OnecApiError extends Error {
    status;
    endpoint;
    constructor(message, status, endpoint) {
        super(message);
        this.status = status;
        this.endpoint = endpoint;
        this.name = 'OnecApiError';
    }
}
/** Эндпоинт не настроен (нет переменной окружения с путём) */
export class OnecNotConfiguredError extends Error {
    constructor(feature) {
        super(`Эндпоинт 1С для «${feature}» ещё не настроен`);
        this.name = 'OnecNotConfiguredError';
    }
}
