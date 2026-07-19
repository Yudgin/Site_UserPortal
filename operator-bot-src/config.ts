import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Не задана обязательная переменная окружения ${name} (см. .env.example)`);
  }
  return value;
}

export interface AppConfig {
  botToken: string;
  mode: 'polling' | 'webhook';
  publicUrl: string;
  telegramWebhookSecret: string;
  port: number;
  store: 'memory' | 'firestore' | 'file';
  /** Путь к JSON-файлу для STORE=file (локальная разработка) */
  fileStorePath: string;
  firestoreProjectId?: string;
  onec: {
    baseUrl: string;
    username?: string;
    password?: string;
    /** Путь эндпоинта фиксации результата звонка, напр. /repair/call_Result */
    callResultPath?: string;
    /** Путь эндпоинта проданных корабликов, плейсхолдер {phone}, напр. /{phone}/BoatList */
    boatsPath?: string;
    /** Путь создания консультации в bot-сервисе, плейсхолдер {phone},
     *  напр. /{phone}/consultation_NEW; тело { text } */
    consultationPath?: string;
    /** Отдельный «bot»-сервис 1С (другой базовый URL + своя авторизация),
     *  напр. https://portal.runferry.com/login/hs/bot/bot */
    botBaseUrl?: string;
    botUsername?: string;
    botPassword?: string;
  };
  eventsAuthToken: string;
  adminToken: string;
  cronAuthToken: string;
  /** OAuth Client ID для входа через Google (публичный, во фронтенде). */
  googleClientId?: string;
  /** Секрет для подписи сессионных cookie. */
  sessionSecret: string;
  /** E-mail, которые при старте засеваются как админы. */
  adminEmails: string[];
  defaults: {
    serviceCode: string;
    cityGuid: string;
    warehouseGuid: string;
  };
  timezone: string;
}

export function loadConfig(): AppConfig {
  const eventsAuthToken = required('EVENTS_AUTH_TOKEN');
  return {
    botToken: required('BOT_TOKEN'),
    mode: process.env.MODE === 'webhook' ? 'webhook' : 'polling',
    publicUrl: (process.env.PUBLIC_URL ?? '').replace(/\/+$/, ''),
    telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET ?? '',
    port: Number(process.env.PORT ?? 8080),
    store:
      process.env.STORE === 'firestore'
        ? 'firestore'
        : process.env.STORE === 'file'
          ? 'file'
          : 'memory',
    fileStorePath: process.env.FILE_STORE_PATH || './data/store.json',
    firestoreProjectId: process.env.FIRESTORE_PROJECT_ID || undefined,
    onec: {
      baseUrl: (process.env.ONEC_BASE_URL ?? 'https://portal.runferry.com/api/hs/facebook').replace(/\/+$/, ''),
      username: process.env.ONEC_USERNAME || undefined,
      password: process.env.ONEC_PASSWORD || undefined,
      callResultPath: process.env.ONEC_CALL_RESULT_PATH || undefined,
      boatsPath: process.env.ONEC_BOATS_PATH || undefined,
      consultationPath: process.env.ONEC_CONSULTATION_PATH || undefined,
      botBaseUrl: process.env.ONEC_BOT_BASE_URL
        ? process.env.ONEC_BOT_BASE_URL.replace(/\/+$/, '')
        : undefined,
      botUsername: process.env.ONEC_BOT_USERNAME || undefined,
      botPassword: process.env.ONEC_BOT_PASSWORD || undefined,
    },
    eventsAuthToken,
    adminToken: required('ADMIN_TOKEN'),
    cronAuthToken: process.env.CRON_AUTH_TOKEN || eventsAuthToken,
    googleClientId: process.env.GOOGLE_CLIENT_ID || undefined,
    // По умолчанию подписываем сессии adminToken — но лучше задать отдельный SESSION_SECRET.
    sessionSecret: process.env.SESSION_SECRET || required('ADMIN_TOKEN'),
    adminEmails: (process.env.ADMIN_EMAILS ?? 'admin@runferry.de')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e !== ''),
    defaults: {
      serviceCode: process.env.DEFAULT_SERVICE_CODE ?? '000000001',
      cityGuid: process.env.DEFAULT_CITY_GUID ?? '',
      warehouseGuid: process.env.DEFAULT_WAREHOUSE_GUID ?? '',
    },
    timezone: process.env.TZ ?? 'Europe/Kyiv',
  };
}
