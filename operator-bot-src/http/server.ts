import { randomUUID } from 'node:crypto';
import express from 'express';
import type { AppConfig } from '../config.js';
import type { Store } from '../store/store.js';
import type { Dispatcher } from '../bot/dispatcher.js';
import { ALL_EVENT_TYPES, normalizePhone } from '../types.js';
import type {
  EventType,
  IncomingCallEvent,
  RepairStatusEvent,
  Task,
  TaskKind,
  User,
  UserRole,
} from '../types.js';
import {
  SESSION_COOKIE,
  readCookie,
  signSession,
  verifyGoogleIdToken,
  verifySession,
} from './auth.js';

export interface ServerDeps {
  config: AppConfig;
  store: Store;
  dispatcher: Dispatcher;
  webhookCallback?: express.RequestHandler;
  /** Username бота (для ссылки привязки Telegram), напр. RunferryAssistanceBot. */
  botUsername?: string;
}

// Известные поля тела /api/events/call; всё остальное складываем в extra.
const CALL_EVENT_FIELDS = new Set([
  'type',
  'callId',
  'phone',
  'clientName',
  'clientId',
  'line',
  'employee',
  'employeeId',
  'timestamp',
  'extra',
]);

// Express 4 не ловит ошибки async-обработчиков сам — пробрасываем в next().
function asyncRoute(
  handler: (req: express.Request, res: express.Response) => Promise<void>,
): express.RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

function headerTokenAuth(headerName: string, expectedToken: string): express.RequestHandler {
  return (req, res, next) => {
    if (!expectedToken || req.get(headerName) !== expectedToken) {
      res
        .status(401)
        .json({ ok: false, error: `Неверный или отсутствующий токен в заголовке ${headerName}` });
      return;
    }
    next();
  };
}

function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && (ALL_EVENT_TYPES as readonly string[]).includes(value);
}

function isUserRole(value: unknown): value is UserRole {
  return value === 'admin' || value === 'member';
}

function isTaskKind(value: unknown): value is TaskKind {
  return value === 'reminder' || value === 'task';
}

/** Разбор тела создания задачи. */
function parseTaskCreate(
  body: unknown,
): { fields: { kind: TaskKind; title: string; assigneeUserId: string; dueAt?: string } } | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'Тело запроса должно быть JSON-объектом' };
  }
  const r = body as Record<string, unknown>;
  if (!isTaskKind(r.kind)) return { error: 'Поле kind должно быть reminder или task' };
  if (typeof r.title !== 'string' || r.title.trim() === '') {
    return { error: 'Поле title должно быть непустой строкой' };
  }
  if (typeof r.assigneeUserId !== 'string' || r.assigneeUserId.trim() === '') {
    return { error: 'Поле assigneeUserId обязательно' };
  }
  let dueAt: string | undefined;
  if (r.dueAt !== undefined && r.dueAt !== null && r.dueAt !== '') {
    if (typeof r.dueAt !== 'string' || Number.isNaN(Date.parse(r.dueAt))) {
      return { error: 'Поле dueAt должно быть датой ISO 8601' };
    }
    dueAt = new Date(r.dueAt).toISOString();
  }
  if (r.kind === 'reminder' && dueAt === undefined) {
    return { error: 'Для напоминания нужно указать время (dueAt)' };
  }
  return { fields: { kind: r.kind, title: r.title.trim(), assigneeUserId: r.assigneeUserId, dueAt } };
}

/** Разбор тела создания/обновления пользователя. */
function parseUserBody(
  body: unknown,
  isCreate: boolean,
): { fields: { name?: string; email?: string; role?: UserRole; active?: boolean } } | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'Тело запроса должно быть JSON-объектом' };
  }
  const record = body as Record<string, unknown>;
  const fields: { name?: string; email?: string; role?: UserRole; active?: boolean } = {};

  if (record.name !== undefined) {
    if (typeof record.name !== 'string' || record.name.trim() === '') {
      return { error: 'Поле name должно быть непустой строкой' };
    }
    fields.name = record.name.trim();
  }
  if (record.email !== undefined && record.email !== null && record.email !== '') {
    if (typeof record.email !== 'string' || !record.email.includes('@')) {
      return { error: 'Поле email указано некорректно' };
    }
    fields.email = record.email.trim().toLowerCase();
  }
  if (record.role !== undefined) {
    if (!isUserRole(record.role)) {
      return { error: 'Поле role должно быть admin или member' };
    }
    fields.role = record.role;
  }
  if (record.active !== undefined) {
    if (typeof record.active !== 'boolean') {
      return { error: 'Поле active должно быть булевым (true/false)' };
    }
    fields.active = record.active;
  }
  if (isCreate && fields.name === undefined && fields.email === undefined) {
    return { error: 'Укажите имя или e-mail пользователя' };
  }
  return { fields };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Как optionalString, но принимает и число (номер сотрудника 1С может прийти числом). */
function optionalIdString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() !== '' ? value.trim() : undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Разбор тела PATCH для цели маршрутизации (чат или ветка): active + events + isArchive. */
function parseRoutePatch(
  body: unknown,
):
  | {
      patch: {
        active?: boolean;
        events?: EventType[];
        isArchive?: boolean;
        isResults?: boolean;
        employeeIds?: string[];
      };
    }
  | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'Тело запроса должно быть JSON-объектом' };
  }
  const record = body as Record<string, unknown>;
  const patch: {
    active?: boolean;
    events?: EventType[];
    isArchive?: boolean;
    isResults?: boolean;
    employeeIds?: string[];
  } = {};

  if (record.active !== undefined) {
    if (typeof record.active !== 'boolean') {
      return { error: 'Поле active должно быть булевым (true/false)' };
    }
    patch.active = record.active;
  }

  if (record.isArchive !== undefined) {
    if (typeof record.isArchive !== 'boolean') {
      return { error: 'Поле isArchive должно быть булевым (true/false)' };
    }
    patch.isArchive = record.isArchive;
  }

  if (record.isResults !== undefined) {
    if (typeof record.isResults !== 'boolean') {
      return { error: 'Поле isResults должно быть булевым (true/false)' };
    }
    patch.isResults = record.isResults;
  }

  if (record.events !== undefined) {
    if (!Array.isArray(record.events)) {
      return { error: `Поле events должно быть массивом из значений: ${ALL_EVENT_TYPES.join(', ')}` };
    }
    const valid = record.events.filter(isEventType);
    if (valid.length !== record.events.length) {
      return {
        error: `Поле events содержит недопустимые значения. Допустимые: ${ALL_EVENT_TYPES.join(', ')}`,
      };
    }
    patch.events = [...new Set(valid)];
  }

  // employeeIds: массив строк/чисел ИЛИ строка с номерами через запятую.
  // Пустой результат = канал общий (фильтра по сотруднику нет).
  if (record.employeeIds !== undefined) {
    let raw: unknown[];
    if (Array.isArray(record.employeeIds)) {
      raw = record.employeeIds;
    } else if (typeof record.employeeIds === 'string') {
      raw = record.employeeIds.split(',');
    } else {
      return { error: 'Поле employeeIds должно быть массивом номеров или строкой через запятую' };
    }
    const ids: string[] = [];
    for (const item of raw) {
      const id = optionalIdString(item);
      if (id && !ids.includes(id)) ids.push(id);
    }
    patch.employeeIds = ids;
  }

  return { patch };
}

function parseLimit(raw: unknown, fallback: number): number {
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.min(Math.floor(n), 500);
  }
  return fallback;
}

function parsePhone(raw: unknown): { phone: string } | { error: string } {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { error: 'Не указан телефон клиента: поле phone обязательно' };
  }
  const phone = normalizePhone(String(raw));
  if (!phone) {
    return { error: 'Поле phone не содержит цифр — телефон невозможно распознать' };
  }
  return { phone };
}

type ParseCallEventResult = { ok: true; event: IncomingCallEvent } | { ok: false; error: string };

function parseCallEvent(body: unknown): ParseCallEventResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Тело запроса должно быть JSON-объектом' };
  }
  const record = body as Record<string, unknown>;

  const phoneResult = parsePhone(record.phone);
  if ('error' in phoneResult) return { ok: false, error: phoneResult.error };

  let type: EventType = 'call.incoming';
  if (record.type !== undefined) {
    if (!isEventType(record.type)) {
      return {
        ok: false,
        error: `Недопустимый тип события «${String(record.type)}». Допустимые: ${ALL_EVENT_TYPES.join(', ')}`,
      };
    }
    type = record.type;
  }

  // Внутренний id события ВСЕГДА уникальный — не доверяем значению из 1С (оно
  // бывает константным), иначе закрытие одного звонка стирает все одноимённые.
  // Оригинал из 1С сохраняем отдельно (sourceCallId) и вернём его в 1С при фиксации.
  const callId = randomUUID();
  let sourceCallId: string | undefined;
  if (typeof record.callId === 'string' && record.callId.trim() !== '') {
    sourceCallId = record.callId;
  } else if (typeof record.callId === 'number' && Number.isFinite(record.callId)) {
    sourceCallId = String(record.callId);
  }

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!CALL_EVENT_FIELDS.has(key)) extra[key] = value;
  }
  if (typeof record.extra === 'object' && record.extra !== null && !Array.isArray(record.extra)) {
    Object.assign(extra, record.extra as Record<string, unknown>);
  }

  const event: IncomingCallEvent = { type, callId, phone: phoneResult.phone };
  if (sourceCallId) event.sourceCallId = sourceCallId;
  const clientName = optionalString(record.clientName);
  if (clientName) event.clientName = clientName;
  const clientId = optionalString(record.clientId);
  if (clientId) event.clientId = clientId;
  const line = optionalString(record.line);
  if (line) event.line = line;
  const employee = optionalString(record.employee);
  if (employee) event.employee = employee;
  const employeeId = optionalIdString(record.employeeId);
  if (employeeId) event.employeeId = employeeId;
  const timestamp = optionalString(record.timestamp);
  if (timestamp) event.timestamp = timestamp;
  if (Object.keys(extra).length > 0) event.extra = extra;

  return { ok: true, event };
}

export function createServer(deps: ServerDeps): express.Express {
  const { config, store, dispatcher } = deps;
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  if (deps.webhookCallback) {
    app.use('/api/telegram/webhook', deps.webhookCallback);
  }

  // Путь /healthz перехватывается инфраструктурой Google Cloud (отдаёт свой 404),
  // поэтому health-check живёт на /health.
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.post(
    '/api/events/call',
    headerTokenAuth('X-Auth-Token', config.eventsAuthToken),
    asyncRoute(async (req, res) => {
      const parsed = parseCallEvent(req.body);
      if (!parsed.ok) {
        res.status(400).json({ ok: false, error: parsed.error });
        return;
      }
      const { delivered } = await dispatcher.dispatchIncomingCall(parsed.event);
      res.json({ ok: true, delivered });
    }),
  );

  app.post(
    '/api/cron/reminders',
    headerTokenAuth('X-Auth-Token', config.cronAuthToken),
    asyncRoute(async (_req, res) => {
      // Сбой одного вида напоминаний не должен валить весь cron.
      const [reminders, tasks] = await Promise.allSettled([
        dispatcher.processDueReminders(),
        dispatcher.processDueTaskReminders(),
      ]);
      if (reminders.status === 'rejected') {
        console.error('Ошибка обработки напоминаний:', reminders.reason);
      }
      if (tasks.status === 'rejected') {
        console.error('Ошибка обработки напоминаний-задач:', tasks.reason);
      }
      res.json({
        ok: true,
        sent: reminders.status === 'fulfilled' ? reminders.value : 0,
        tasksSent: tasks.status === 'fulfilled' ? tasks.value : 0,
      });
    }),
  );

  // Событие от 1С: статус ремонта изменился -> уведомляем связанных клиентов.
  app.post(
    '/api/events/repair-status',
    headerTokenAuth('X-Auth-Token', config.eventsAuthToken),
    asyncRoute(async (req, res) => {
      const body: unknown = req.body;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        res.status(400).json({ ok: false, error: 'Тело запроса должно быть JSON-объектом' });
        return;
      }
      const record = body as Record<string, unknown>;
      const phoneResult = parsePhone(record.phone);
      if ('error' in phoneResult) {
        res.status(400).json({ ok: false, error: phoneResult.error });
        return;
      }
      const status = optionalString(record.status);
      if (!status) {
        res.status(400).json({ ok: false, error: 'Поле status обязательно' });
        return;
      }
      const event: RepairStatusEvent = { phone: phoneResult.phone, status };
      const repairNumber = optionalString(record.repairNumber);
      if (repairNumber) event.repairNumber = repairNumber;
      const message = optionalString(record.message);
      if (message) event.message = message;
      const timestamp = optionalString(record.timestamp);
      if (timestamp) event.timestamp = timestamp;

      const { delivered } = await dispatcher.notifyRepairStatus(event);
      res.json({ ok: true, delivered });
    }),
  );

  // --- Аутентификация портала ---

  type AuthedRequest = express.Request & { user?: User };
  const cookieSecure = config.mode === 'webhook';

  function setSessionCookie(res: express.Response, userId: string): void {
    res.cookie(SESSION_COOKIE, signSession(userId, config.sessionSecret), {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60_000,
    });
  }

  async function sessionUser(req: express.Request): Promise<User | null> {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (!token) return null;
    const session = verifySession(token, config.sessionSecret);
    if (!session) return null;
    const user = await store.getUser(session.uid);
    return user && user.active ? user : null;
  }

  // Доступ к админ-API: сессия админа ИЛИ аварийный токен ADMIN_TOKEN.
  const adminAuth: express.RequestHandler = (req, res, next) => {
    void (async () => {
      if (req.get('Authorization') === `Bearer ${config.adminToken}`) {
        next();
        return;
      }
      const user = await sessionUser(req);
      if (user && user.role === 'admin') {
        (req as AuthedRequest).user = user;
        next();
        return;
      }
      res
        .status(401)
        .json({ ok: false, error: 'Требуется вход через Google или токен администратора' });
    })().catch(next);
  };

  // Публичная конфигурация для фронтенда (нужен Client ID, чтобы показать кнопку Google).
  app.get('/api/auth/config', (_req, res) => {
    res.json({ googleClientId: config.googleClientId ?? null });
  });

  // Текущий пользователь по сессии.
  app.get(
    '/api/auth/me',
    asyncRoute(async (req, res) => {
      const user = await sessionUser(req);
      if (!user) {
        res.status(401).json({ ok: false });
        return;
      }
      res.json({ user });
    }),
  );

  // Вход через Google: фронт присылает ID-token, ищем пользователя по e-mail.
  app.post(
    '/api/auth/google',
    asyncRoute(async (req, res) => {
      if (!config.googleClientId) {
        res.status(503).json({ ok: false, error: 'Вход через Google не настроен' });
        return;
      }
      const credential =
        typeof req.body === 'object' && req.body !== null
          ? (req.body as Record<string, unknown>).credential
          : undefined;
      if (typeof credential !== 'string' || credential === '') {
        res.status(400).json({ ok: false, error: 'Не передан Google credential' });
        return;
      }
      const identity = await verifyGoogleIdToken(credential, config.googleClientId);
      if (!identity || !identity.emailVerified) {
        res.status(401).json({ ok: false, error: 'Не удалось проверить аккаунт Google' });
        return;
      }
      const user = await store.getUserByEmail(identity.email);
      if (!user || !user.active) {
        res.status(403).json({
          ok: false,
          error: 'Доступ не предоставлен. Обратитесь к администратору, чтобы он добавил ваш e-mail.',
        });
        return;
      }
      // Досвязываем Google и обновляем имя при первом входе.
      const patch: Partial<User> = {};
      if (!user.googleId) patch.googleId = identity.googleId;
      if (identity.name && user.name !== identity.name && user.name === user.email) {
        patch.name = identity.name;
      }
      const finalUser = Object.keys(patch).length > 0 ? await store.updateUser(user.id, patch) : user;
      setSessionCookie(res, user.id);
      res.json({ user: finalUser ?? user });
    }),
  );

  app.post('/api/auth/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // --- Управление пользователями (только админ) ---

  app.get(
    '/api/admin/users',
    adminAuth,
    asyncRoute(async (_req, res) => {
      res.json({ users: await store.listUsers() });
    }),
  );

  app.post(
    '/api/admin/users',
    adminAuth,
    asyncRoute(async (req, res) => {
      const parsed = parseUserBody(req.body, true);
      if ('error' in parsed) {
        res.status(400).json({ ok: false, error: parsed.error });
        return;
      }
      const nowIso = new Date().toISOString();
      const user: User = {
        id: randomUUID(),
        name: parsed.fields.name ?? parsed.fields.email ?? 'Пользователь',
        email: parsed.fields.email,
        role: parsed.fields.role ?? 'member',
        active: parsed.fields.active ?? true,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      if (user.email) {
        const existing = await store.getUserByEmail(user.email);
        if (existing) {
          res.status(409).json({ ok: false, error: 'Пользователь с таким e-mail уже есть' });
          return;
        }
      }
      await store.saveUser(user);
      res.json({ user });
    }),
  );

  app.patch(
    '/api/admin/users/:id',
    adminAuth,
    asyncRoute(async (req, res) => {
      const parsed = parseUserBody(req.body, false);
      if ('error' in parsed) {
        res.status(400).json({ ok: false, error: parsed.error });
        return;
      }
      const updated = await store.updateUser(req.params.id, parsed.fields);
      if (!updated) {
        res.status(404).json({ ok: false, error: 'Пользователь не найден' });
        return;
      }
      res.json({ user: updated });
    }),
  );

  // --- Задачи (напоминания/задания) ---

  // Любой вошедший пользователь (для личных эндпоинтов /api/me/*).
  const requireUser: express.RequestHandler = (req, res, next) => {
    void (async () => {
      const user = await sessionUser(req);
      if (user) {
        (req as AuthedRequest).user = user;
        next();
        return;
      }
      res.status(401).json({ ok: false, error: 'Требуется вход в портал' });
    })().catch(next);
  };

  async function createTask(
    fields: { kind: TaskKind; title: string; assigneeUserId: string; dueAt?: string },
    creator: User | undefined,
  ): Promise<Task> {
    const nowIso = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      kind: fields.kind,
      title: fields.title,
      assigneeUserId: fields.assigneeUserId,
      creatorUserId: creator?.id,
      creatorName: creator?.name ?? 'Администратор',
      dueAt: fields.dueAt,
      status: 'open',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    // Задание доставляем исполнителю сразу; напоминание — по сроку через cron.
    if (task.kind === 'task') {
      const delivered = await dispatcher.deliverTask(task);
      if (delivered) task.notifiedAt = nowIso;
    }
    await store.saveTask(task);
    return task;
  }

  app.get(
    '/api/admin/tasks',
    adminAuth,
    asyncRoute(async (_req, res) => {
      res.json({ tasks: await store.listTasks(), users: await store.listUsers() });
    }),
  );

  app.post(
    '/api/admin/tasks',
    adminAuth,
    asyncRoute(async (req, res) => {
      const parsed = parseTaskCreate(req.body);
      if ('error' in parsed) {
        res.status(400).json({ ok: false, error: parsed.error });
        return;
      }
      const assignee = await store.getUser(parsed.fields.assigneeUserId);
      if (!assignee) {
        res.status(400).json({ ok: false, error: 'Исполнитель не найден' });
        return;
      }
      const task = await createTask(parsed.fields, (req as AuthedRequest).user);
      res.json({ task });
    }),
  );

  app.patch(
    '/api/admin/tasks/:id',
    adminAuth,
    asyncRoute(async (req, res) => {
      const task = await store.getTask(req.params.id);
      if (!task) {
        res.status(404).json({ ok: false, error: 'Задача не найдена' });
        return;
      }
      const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<
        string,
        unknown
      >;
      const patch: Parameters<Store['updateTask']>[1] = {};
      if (typeof body.title === 'string' && body.title.trim() !== '') patch.title = body.title.trim();
      if (body.status === 'done' && task.status !== 'done') {
        const result = optionalString(body.result);
        if (task.kind === 'task' && !result) {
          res.status(400).json({ ok: false, error: 'Для задания нужен результат выполнения' });
          return;
        }
        patch.status = 'done';
        patch.doneAt = new Date().toISOString();
        patch.doneByName = (req as AuthedRequest).user?.name ?? 'Администратор';
        if (result) patch.result = result;
      }
      const updated = await store.updateTask(req.params.id, patch);
      if (updated && patch.status === 'done') {
        void dispatcher.archiveCompletedTask(updated).catch((err) => {
          console.error('Ошибка архивации задачи:', err);
        });
      }
      res.json({ task: updated });
    }),
  );

  // Личные задачи вошедшего пользователя.
  app.get(
    '/api/me/tasks',
    requireUser,
    asyncRoute(async (req, res) => {
      const user = (req as AuthedRequest).user as User;
      res.json({ tasks: await store.listTasksByAssignee(user.id) });
    }),
  );

  app.post(
    '/api/me/tasks/:id/done',
    requireUser,
    asyncRoute(async (req, res) => {
      const user = (req as AuthedRequest).user as User;
      const task = await store.getTask(req.params.id);
      if (!task || task.assigneeUserId !== user.id) {
        res.status(404).json({ ok: false, error: 'Задача не найдена' });
        return;
      }
      const result = optionalString(
        typeof req.body === 'object' && req.body !== null
          ? (req.body as Record<string, unknown>).result
          : undefined,
      );
      if (task.kind === 'task' && !result) {
        res.status(400).json({ ok: false, error: 'Для задания нужен результат выполнения' });
        return;
      }
      const updated = await store.updateTask(task.id, {
        status: 'done',
        doneAt: new Date().toISOString(),
        doneByName: user.name,
        ...(result ? { result } : {}),
      });
      if (updated) {
        void dispatcher.archiveCompletedTask(updated).catch((err) => {
          console.error('Ошибка архивации задачи:', err);
        });
      }
      res.json({ task: updated });
    }),
  );

  // Ссылка привязки Telegram к своему аккаунту.
  app.post(
    '/api/me/telegram-link',
    requireUser,
    asyncRoute(async (req, res) => {
      const user = (req as AuthedRequest).user as User;
      const token = randomUUID().replace(/-/g, '').slice(0, 20);
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      await store.saveLinkToken({ token, userId: user.id, expiresAt });
      const url = deps.botUsername
        ? `https://t.me/${deps.botUsername}?start=link_${token}`
        : null;
      res.json({ token, url, expiresAt });
    }),
  );

  app.get(
    '/api/admin/chats',
    adminAuth,
    asyncRoute(async (_req, res) => {
      const [chats, threads] = await Promise.all([store.listChats(), store.listThreads()]);
      res.json({ chats, threads });
    }),
  );

  app.patch(
    '/api/admin/chats/:id',
    adminAuth,
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        res.status(400).json({ ok: false, error: 'Некорректный идентификатор чата' });
        return;
      }
      const parsed = parseRoutePatch(req.body);
      if ('error' in parsed) {
        res.status(400).json({ ok: false, error: parsed.error });
        return;
      }
      const chat = await store.updateChat(id, parsed.patch);
      if (!chat) {
        res.status(404).json({ ok: false, error: 'Чат не найден' });
        return;
      }
      res.json({ chat });
    }),
  );

  app.patch(
    '/api/admin/threads/:chatId/:threadId',
    adminAuth,
    asyncRoute(async (req, res) => {
      const chatId = Number(req.params.chatId);
      const threadId = Number(req.params.threadId);
      if (!Number.isInteger(chatId) || !Number.isInteger(threadId)) {
        res.status(400).json({ ok: false, error: 'Некорректный идентификатор чата или ветки' });
        return;
      }
      const parsed = parseRoutePatch(req.body);
      if ('error' in parsed) {
        res.status(400).json({ ok: false, error: parsed.error });
        return;
      }
      const thread = await store.updateThread(chatId, threadId, parsed.patch);
      if (!thread) {
        res.status(404).json({ ok: false, error: 'Ветка не найдена' });
        return;
      }
      res.json({ thread });
    }),
  );

  app.get(
    '/api/admin/call-results',
    adminAuth,
    asyncRoute(async (req, res) => {
      const limit = parseLimit(req.query.limit, 50);
      res.json({ results: await store.listCallResults(limit) });
    }),
  );

  app.get(
    '/api/admin/reminders',
    adminAuth,
    asyncRoute(async (_req, res) => {
      res.json({ reminders: await store.listReminders() });
    }),
  );

  app.get(
    '/api/admin/consultations',
    adminAuth,
    asyncRoute(async (_req, res) => {
      res.json({ consultations: await store.listConsultations() });
    }),
  );

  app.post(
    '/api/admin/test-call',
    adminAuth,
    asyncRoute(async (req, res) => {
      const body: unknown = req.body;
      const record = (
        typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}
      ) as Record<string, unknown>;

      const phoneResult = parsePhone(record.phone);
      if ('error' in phoneResult) {
        res.status(400).json({ ok: false, error: phoneResult.error });
        return;
      }

      const event: IncomingCallEvent = {
        type: 'call.incoming',
        callId: `test-${randomUUID()}`,
        phone: phoneResult.phone,
      };
      const clientName = optionalString(record.clientName);
      if (clientName) event.clientName = clientName;

      const { delivered } = await dispatcher.dispatchIncomingCall(event);
      res.json({ ok: true, delivered });
    }),
  );

  app.get('/', (_req, res) => {
    res.redirect('/admin/');
  });
  app.use(
    '/admin',
    express.static('public/admin', {
      // Заставляем браузер каждый раз сверяться с сервером (ETag), чтобы после
      // деплоя не залипала старая версия app.js/index.html (как было в Safari).
      setHeaders: (res, filePath) => {
        if (/\.(html|js|css)$/.test(filePath)) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );

  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      console.error('Ошибка при обработке HTTP-запроса:', err);
      if (res.headersSent) return;
      const isParseError =
        typeof err === 'object' && err !== null && (err as { type?: unknown }).type === 'entity.parse.failed';
      if (isParseError) {
        res.status(400).json({ ok: false, error: 'Некорректный JSON в теле запроса' });
        return;
      }
      // Детали исключения остаются в логах — клиенту только общий текст.
      res.status(500).json({ ok: false, error: 'Внутренняя ошибка сервера' });
    },
  );

  return app;
}
