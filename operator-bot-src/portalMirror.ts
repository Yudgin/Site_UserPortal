// Зеркалирование в портал RunFerry (my.runferry.com): события звонков и результаты
// разговоров дублируются в наш Cloud Run (журнал «Дзвінки» на портале), НЕ мешая
// основному потоку (fire-and-forget: ошибки только логируются). Включается двумя env:
//   PORTAL_BASE_URL   — напр. https://runferry-backend-98000160958.europe-west3.run.app
//   PORTAL_CALLS_TOKEN — общий секрет (тот же, что CALLS_INGEST_TOKEN на портале)
import axios from 'axios';
import type { CallResultRecord, IncomingCallEvent, Task } from './types.js';
import type { Store } from './store/store.js';

// env читаем лениво: при встраивании в портал адаптер выставляет их после импорта модуля.
const base = (): string => (process.env.PORTAL_BASE_URL || '').replace(/\/+$/, '');
const token = (): string => process.env.PORTAL_CALLS_TOKEN || '';

const enabled = (): boolean => Boolean(base() && token());

function post(path: string, body: unknown): void {
  if (!enabled()) return;
  axios
    .post(`${base()}${path}`, body, { headers: { 'X-Calls-Token': token() }, timeout: 8000 })
    .catch((err) => {
      console.error(`portalMirror ${path}:`, err?.response?.status || err?.message);
    });
}

/** Событие звонка (call.incoming / call.completed) — в журнал портала. */
export function mirrorCallEvent(event: IncomingCallEvent): void {
  post('/api/calls/event', {
    type: event.type,
    callId: event.callId,
    sourceCallId: event.sourceCallId,
    phone: event.phone,
    clientName: event.clientName,
    clientId: event.clientId,
    line: event.line,
    employee: event.employee,
    employeeId: event.employeeId,
    timestamp: event.timestamp,
  });
}

/** Результат разговора (и повторно — при «Принято» руководителем: reviewedAt заполнен). */
export function mirrorCallResult(result: CallResultRecord): void {
  post('/api/calls/result', {
    id: result.id,
    callId: result.callId,
    phone: result.phone,
    clientName: result.clientName,
    resultText: result.resultText,
    operatorId: result.operatorId,
    operatorName: result.operatorName,
    createdAt: result.createdAt,
    sentTo1C: result.sentTo1C,
    reviewedAt: result.reviewedAt,
    reviewedByName: result.reviewedByName,
  });
}

/** Задача/напоминание (создание, выполнение, правка) — в канбан портала. */
export function mirrorTask(store: Store, task: Task): void {
  if (!enabled()) return;
  void (async () => {
    let assigneeName: string | undefined;
    try {
      assigneeName = (await store.getUser(task.assigneeUserId))?.name;
    } catch {
      /* имя не критично */
    }
    post('/api/calls/task', {
      id: task.id,
      kind: task.kind,
      title: task.title,
      assigneeUserId: task.assigneeUserId,
      assigneeName,
      creatorName: task.creatorName,
      dueAt: task.dueAt,
      status: task.status,
      result: task.result,
      doneAt: task.doneAt,
      doneByName: task.doneByName,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    });
  })();
}
