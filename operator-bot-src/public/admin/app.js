// RunFerry-портал: админка может быть смонтирована под префиксом (напр. /operator-bot/admin/),
// поэтому API-пути строим относительно страницы, а не от корня домена.
const API_ROOT = location.pathname.replace(/\/admin\/?.*$/, '');
'use strict';

// Панель администратора RunFerry. Чистый JS без зависимостей.
// Безопасность: данные из API вставляются только через textContent/createElement.

const TOKEN_KEY = 'admin_token';

const EVENT_TYPES = [
  { value: 'call.incoming', label: 'Входящие звонки' },
  { value: 'call.completed', label: 'Завершённые звонки' },
  { value: 'test', label: 'Тестовые' },
];

const CHAT_TYPE_LABELS = {
  group: 'Группа',
  supergroup: 'Супергруппа',
  channel: 'Канал',
  private: 'Личный',
};

// ---------- DOM-помощники ----------

function $(id) {
  return document.getElementById(id);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function badge(text, kind) {
  return el('span', 'badge badge-' + kind, text);
}

function setTableMessage(tbody, colSpan, text) {
  tbody.replaceChildren();
  const tr = document.createElement('tr');
  const td = el('td', 'cell-empty', text);
  td.colSpan = colSpan;
  tr.appendChild(td);
  tbody.appendChild(tr);
}

function formatDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function plural(n, forms) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

// ---------- Тосты ----------

function showToast(message, kind) {
  const container = $('toast-container');
  const toast = el('div', 'toast toast-' + (kind || 'error'), message);
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast-hide');
    setTimeout(() => toast.remove(), 400);
  }, 4000);
}

// ---------- API ----------

class AuthError extends Error {}

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

async function api(path, options) {
  const opts = options || {};
  const headers = {};
  // Bearer-токен — только если задан (аварийный вход). Иначе работает сессия-cookie.
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;
  const init = { method: opts.method || 'GET', headers, credentials: 'same-origin' };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch (_networkErr) {
    throw new Error('Сеть недоступна — проверьте соединение с сервером');
  }
  if (response.status === 401) {
    handleUnauthorized();
    throw new AuthError('Требуется вход');
  }
  if (!response.ok) {
    let message = 'Ошибка сервера (' + response.status + ')';
    try {
      const data = await response.json();
      if (data && typeof data.error === 'string') message = data.error;
      else if (data && typeof data.message === 'string') message = data.message;
    } catch (_notJson) {
      // тело не JSON — оставляем сообщение по статусу
    }
    throw new Error(message);
  }
  return response.json();
}

// Показывает тост для любых ошибок, кроме AuthError (по 401 уже показан экран входа).
function reportError(err) {
  if (err instanceof AuthError) return;
  showToast(err instanceof Error ? err.message : 'Неизвестная ошибка');
}

// ---------- Вход / выход ----------

let currentUser = null;

function showLogin(message) {
  stopResultsAutoRefresh();
  currentUser = null;
  $('app-screen').classList.add('hidden');
  $('login-screen').classList.remove('hidden');
  const errorNode = $('login-error');
  errorNode.textContent = message || '';
  errorNode.classList.toggle('hidden', !message);
  $('token-input').value = '';
}

function handleUnauthorized() {
  localStorage.removeItem(TOKEN_KEY);
  if (!$('login-screen').classList.contains('hidden')) return;
  showLogin('Сессия истекла. Войдите снова.');
}

function isAdmin() {
  return Boolean(currentUser && currentUser.role === 'admin');
}

function applyRoleVisibility() {
  const admin = isAdmin();
  document.querySelectorAll('[data-admin-only], .admin-only').forEach((node) => {
    node.classList.toggle('hidden', !admin);
  });
}

function showApp() {
  $('login-screen').classList.add('hidden');
  $('app-screen').classList.remove('hidden');
  applyRoleVisibility();
  // Если текущая вкладка недоступна сотруднику — открываем «Задачи».
  const tabBtn = document.querySelector('.tab-btn[data-tab="' + currentTab + '"]');
  if (!isAdmin() && tabBtn && tabBtn.hasAttribute('data-admin-only')) currentTab = 'tasks';
  switchTab(currentTab);
}

/** Успешный вход (через Google или сессию). Админ — всё; сотрудник — только «Задачи». */
function onAuthenticated(user) {
  if (!user) {
    showLogin('Не удалось войти');
    return;
  }
  currentUser = user;
  showApp();
}

// --- Вход через Google (GIS) ---

/** Скрипт GIS подключён как async и может ещё не загрузиться к моменту старта.
 *  Ждём готовности google.accounts.id, иначе кнопка Google не отрисуется. */
function waitForGoogle(timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    (function check() {
      if (typeof google !== 'undefined' && google.accounts && google.accounts.id) {
        resolve(true);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(check, 50);
    })();
  });
}

async function initGoogleSignIn() {
  let clientId = null;
  try {
    const res = await fetch(API_ROOT + '/api/auth/config', { credentials: 'same-origin' });
    const data = await res.json();
    clientId = data && data.googleClientId;
  } catch (_e) {
    // конфиг недоступен — покажем подсказку
  }
  const unavailable = $('google-unavailable');
  const ready = await waitForGoogle(8000);
  if (!clientId || !ready) {
    unavailable.classList.remove('hidden');
    return;
  }
  unavailable.classList.add('hidden');
  google.accounts.id.initialize({ client_id: clientId, callback: onGoogleCredential });
  google.accounts.id.renderButton($('g-signin'), { theme: 'filled_blue', size: 'large', text: 'signin_with', width: 280 });
}

async function onGoogleCredential(response) {
  try {
    const res = await fetch(API_ROOT + '/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ credential: response.credential }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showLogin(data && data.error ? data.error : 'Не удалось войти через Google');
      return;
    }
    onAuthenticated(data.user);
  } catch (_e) {
    showLogin('Сеть недоступна — попробуйте ещё раз');
  }
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  const token = $('token-input').value.trim();
  if (!token) return;
  localStorage.setItem(TOKEN_KEY, token);
  const submit = $('login-submit');
  submit.disabled = true;
  try {
    await api(API_ROOT + '/api/admin/chats');
    // Токен-вход = аварийный администратор.
    currentUser = { role: 'admin', name: 'admin (токен)' };
    showApp();
  } catch (err) {
    if (err instanceof AuthError) {
      localStorage.removeItem(TOKEN_KEY);
      showLogin('Неверный токен администратора');
    } else {
      reportError(err);
    }
  } finally {
    submit.disabled = false;
  }
}

async function logout() {
  try {
    await fetch(API_ROOT + '/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (_e) {
    // не критично
  }
  localStorage.removeItem(TOKEN_KEY);
  if (typeof google !== 'undefined' && google.accounts) google.accounts.id.disableAutoSelect();
  showLogin('');
}

// ---------- Вкладки ----------

let currentTab = 'chats';

const TAB_LOADERS = {
  chats: () => loadChats(),
  results: () => loadResults(false),
  reminders: () => loadReminders(),
  consultations: () => loadConsultations(),
  users: () => loadUsers(),
  tasks: () => loadTasks(),
};

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== 'tab-' + tab);
  });
  if (tab === 'results') startResultsAutoRefresh();
  else stopResultsAutoRefresh();
  TAB_LOADERS[tab]();
}

// ---------- Чаты ----------

async function loadChats() {
  const tbody = $('chats-tbody');
  setTableMessage(tbody, 8, 'Загрузка…');
  try {
    const data = await api(API_ROOT + '/api/admin/chats');
    renderChats(
      Array.isArray(data.chats) ? data.chats : [],
      Array.isArray(data.threads) ? data.threads : [],
    );
  } catch (err) {
    setTableMessage(tbody, 8, 'Не удалось загрузить список чатов');
    reportError(err);
  }
}

function renderChats(chats, threads) {
  const tbody = $('chats-tbody');
  tbody.replaceChildren();
  if (chats.length === 0) {
    setTableMessage(tbody, 8, 'Бот ещё не добавлен ни в один чат');
    return;
  }
  for (const chat of chats) {
    tbody.appendChild(buildChatRow(chat));
    const chatThreads = threads
      .filter((t) => t.chatId === chat.id)
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'));
    for (const thread of chatThreads) {
      tbody.appendChild(buildThreadRow(thread));
    }
  }
}

async function patchChat(chatId, patch, controls) {
  controls.forEach((c) => { c.disabled = true; });
  try {
    const data = await api(API_ROOT + '/api/admin/chats/' + encodeURIComponent(String(chatId)), {
      method: 'PATCH',
      body: patch,
    });
    showToast('Сохранено', 'success');
    return data && data.chat;
  } finally {
    controls.forEach((c) => { c.disabled = false; });
  }
}

async function patchThread(chatId, threadId, patch, controls) {
  controls.forEach((c) => { c.disabled = true; });
  try {
    const data = await api(
      API_ROOT + '/api/admin/threads/' +
        encodeURIComponent(String(chatId)) + '/' +
        encodeURIComponent(String(threadId)),
      { method: 'PATCH', body: patch },
    );
    showToast('Сохранено', 'success');
    return data && data.thread;
  } finally {
    controls.forEach((c) => { c.disabled = false; });
  }
}

/** Строит ячейки «Активен» + «События» и навешивает обработчики, вызывающие onPatch. */
function appendRouteCells(tr, route, onPatch) {
  const controls = [];

  const activeTd = el('td', 'cell-center');
  const activeLabel = el('label', 'switch');
  const activeCheckbox = document.createElement('input');
  activeCheckbox.type = 'checkbox';
  activeCheckbox.checked = Boolean(route.active);
  activeLabel.appendChild(activeCheckbox);
  activeLabel.appendChild(el('span', 'switch-slider'));
  activeTd.appendChild(activeLabel);
  tr.appendChild(activeTd);

  const eventsTd = el('td', 'cell-events');
  const eventCheckboxes = [];
  const routeEvents = Array.isArray(route.events) ? route.events : [];
  for (const type of EVENT_TYPES) {
    const label = el('label', 'event-check');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = type.value;
    checkbox.checked = routeEvents.includes(type.value);
    label.appendChild(checkbox);
    label.appendChild(el('span', '', type.label));
    eventsTd.appendChild(label);
    eventCheckboxes.push(checkbox);
  }
  tr.appendChild(eventsTd);

  const empTd = el('td', 'cell-employees');
  const empInput = document.createElement('input');
  empInput.type = 'text';
  empInput.className = 'emp-input';
  empInput.placeholder = 'все';
  empInput.value = Array.isArray(route.employeeIds) ? route.employeeIds.join(', ') : '';
  empInput.title =
    'Внутренние номера сотрудников через запятую — канал получит только их звонки. Пусто — общий канал (все звонки).';
  empTd.appendChild(empInput);
  tr.appendChild(empTd);

  const resultsTd = el('td', 'cell-center');
  const resultsLabel = el('label', 'switch');
  const resultsCheckbox = document.createElement('input');
  resultsCheckbox.type = 'checkbox';
  resultsCheckbox.checked = Boolean(route.isResults);
  resultsCheckbox.title = 'Публиковать сюда результаты разговоров (резюме операторов) с кнопкой «Принять»';
  resultsLabel.appendChild(resultsCheckbox);
  resultsLabel.appendChild(el('span', 'switch-slider'));
  resultsTd.appendChild(resultsLabel);
  tr.appendChild(resultsTd);

  const archiveTd = el('td', 'cell-center');
  const archiveLabel = el('label', 'switch');
  const archiveCheckbox = document.createElement('input');
  archiveCheckbox.type = 'checkbox';
  archiveCheckbox.checked = Boolean(route.isArchive);
  archiveCheckbox.title = 'Публиковать сюда выполненные задачи и напоминания';
  archiveLabel.appendChild(archiveCheckbox);
  archiveLabel.appendChild(el('span', 'switch-slider'));
  archiveTd.appendChild(archiveLabel);
  tr.appendChild(archiveTd);

  controls.push(activeCheckbox, ...eventCheckboxes, empInput, resultsCheckbox, archiveCheckbox);

  resultsCheckbox.addEventListener('change', async () => {
    const next = resultsCheckbox.checked;
    try {
      await onPatch({ isResults: next }, controls);
    } catch (err) {
      resultsCheckbox.checked = !next;
      reportError(err);
    }
  });

  // Сохраняем номера сотрудников при потере фокуса/Enter (событие change).
  empInput.addEventListener('change', async () => {
    try {
      const updated = await onPatch({ employeeIds: empInput.value }, controls);
      // Отражаем нормализованный сервером список (trim/дедуп), если вернулся.
      const ids = updated && updated.employeeIds;
      if (Array.isArray(ids)) empInput.value = ids.join(', ');
    } catch (err) {
      reportError(err);
    }
  });

  activeCheckbox.addEventListener('change', async () => {
    const next = activeCheckbox.checked;
    try {
      await onPatch({ active: next }, controls);
    } catch (err) {
      activeCheckbox.checked = !next;
      reportError(err);
    }
  });

  for (const checkbox of eventCheckboxes) {
    checkbox.addEventListener('change', async () => {
      const events = eventCheckboxes.filter((c) => c.checked).map((c) => c.value);
      try {
        await onPatch({ events }, controls);
      } catch (err) {
        checkbox.checked = !checkbox.checked;
        reportError(err);
      }
    });
  }

  archiveCheckbox.addEventListener('change', async () => {
    const next = archiveCheckbox.checked;
    try {
      await onPatch({ isArchive: next }, controls);
    } catch (err) {
      archiveCheckbox.checked = !next;
      reportError(err);
    }
  });
}

function buildChatRow(chat) {
  const tr = document.createElement('tr');
  tr.appendChild(el('td', 'cell-title', chat.title || String(chat.id)));
  const typeLabel = (CHAT_TYPE_LABELS[chat.type] || String(chat.type)) + (chat.isForum ? ' · форум' : '');
  tr.appendChild(el('td', '', typeLabel));
  const presentTd = el('td', 'cell-center');
  presentTd.appendChild(chat.present ? badge('✅ да', 'ok') : badge('❌ нет', 'no'));
  tr.appendChild(presentTd);
  appendRouteCells(tr, chat, (patch, controls) => patchChat(chat.id, patch, controls));
  return tr;
}

function buildThreadRow(thread) {
  const tr = document.createElement('tr');
  tr.className = 'thread-row';
  tr.appendChild(el('td', 'cell-title cell-thread', '↳ ' + (thread.name || ('Тема ' + thread.threadId))));
  tr.appendChild(el('td', '', 'ветка'));
  tr.appendChild(el('td', 'cell-center', ''));
  appendRouteCells(tr, thread, (patch, controls) =>
    patchThread(thread.chatId, thread.threadId, patch, controls),
  );
  return tr;
}

// ---------- Тестовый звонок ----------

async function handleTestCallSubmit(event) {
  event.preventDefault();
  const phone = $('test-phone').value.trim();
  if (!phone) return;
  const clientName = $('test-name').value.trim();
  const submit = $('test-call-submit');
  const result = $('test-call-result');
  submit.disabled = true;
  result.className = 'test-result';
  result.textContent = 'Отправка…';
  try {
    const body = { phone };
    if (clientName) body.clientName = clientName;
    const data = await api(API_ROOT + '/api/admin/test-call', { method: 'POST', body });
    const delivered = Number(data.delivered) || 0;
    if (delivered > 0) {
      result.className = 'test-result test-result-ok';
      result.textContent =
        'Опубликовано в ' + delivered + ' ' + plural(delivered, ['чате', 'чатах', 'чатах']);
    } else {
      result.className = 'test-result test-result-fail';
      result.textContent =
        'Не опубликовано ни в одном чате. Проверьте, что есть активный чат с типом «Тестовые».';
    }
  } catch (err) {
    result.className = 'test-result test-result-fail';
    result.textContent = err instanceof AuthError ? '' : 'Ошибка: ' + err.message;
    reportError(err);
  } finally {
    submit.disabled = false;
  }
}

// ---------- Результаты звонков ----------

let resultsTimer = null;

function startResultsAutoRefresh() {
  stopResultsAutoRefresh();
  resultsTimer = setInterval(() => {
    if (!document.hidden) loadResults(true);
  }, 30000);
}

function stopResultsAutoRefresh() {
  if (resultsTimer !== null) {
    clearInterval(resultsTimer);
    resultsTimer = null;
  }
}

async function loadResults(silent) {
  const tbody = $('results-tbody');
  if (!silent) setTableMessage(tbody, 5, 'Загрузка…');
  try {
    const data = await api(API_ROOT + '/api/admin/call-results?limit=50');
    renderResults(Array.isArray(data.results) ? data.results : []);
    $('results-updated').textContent =
      'Обновлено: ' + new Date().toLocaleTimeString('ru-RU');
  } catch (err) {
    if (!silent) {
      setTableMessage(tbody, 5, 'Не удалось загрузить результаты');
      reportError(err);
    }
  }
}

function renderResults(results) {
  const tbody = $('results-tbody');
  tbody.replaceChildren();
  if (results.length === 0) {
    setTableMessage(tbody, 5, 'Результатов пока нет');
    return;
  }
  for (const item of results) {
    const tr = document.createElement('tr');
    tr.appendChild(el('td', 'cell-nowrap', formatDate(item.createdAt)));
    tr.appendChild(el('td', 'cell-nowrap', item.phone || '—'));
    tr.appendChild(el('td', '', item.operatorName || '—'));
    tr.appendChild(el('td', 'cell-text', item.resultText || '—'));
    const sentTd = el('td', 'cell-center');
    if (item.sentTo1C) sentTd.appendChild(badge('✅', 'ok'));
    else sentTd.appendChild(el('span', 'muted', '—'));
    tr.appendChild(sentTd);
    tbody.appendChild(tr);
  }
}

// ---------- Напоминания ----------

async function loadReminders() {
  const tbody = $('reminders-tbody');
  setTableMessage(tbody, 4, 'Загрузка…');
  try {
    const data = await api(API_ROOT + '/api/admin/reminders');
    renderReminders(Array.isArray(data.reminders) ? data.reminders : []);
  } catch (err) {
    setTableMessage(tbody, 4, 'Не удалось загрузить напоминания');
    reportError(err);
  }
}

function renderReminders(reminders) {
  const tbody = $('reminders-tbody');
  tbody.replaceChildren();
  if (reminders.length === 0) {
    setTableMessage(tbody, 4, 'Напоминаний пока нет');
    return;
  }
  for (const item of reminders) {
    const tr = document.createElement('tr');
    tr.appendChild(el('td', 'cell-nowrap', formatDate(item.dueAt)));
    tr.appendChild(el('td', 'cell-text', item.text || '—'));
    tr.appendChild(el('td', '', item.createdByName || '—'));
    const statusTd = el('td', 'cell-center');
    statusTd.appendChild(
      item.done ? badge('Выполнено', 'ok') : badge('Ожидает', 'wait'),
    );
    tr.appendChild(statusTd);
    tbody.appendChild(tr);
  }
}

// ---------- Консультации ----------

async function loadConsultations() {
  const tbody = $('consultations-tbody');
  setTableMessage(tbody, 5, 'Загрузка…');
  try {
    const data = await api(API_ROOT + '/api/admin/consultations');
    renderConsultations(Array.isArray(data.consultations) ? data.consultations : []);
  } catch (err) {
    setTableMessage(tbody, 5, 'Не удалось загрузить консультации');
    reportError(err);
  }
}

function renderConsultations(consultations) {
  const tbody = $('consultations-tbody');
  tbody.replaceChildren();
  if (consultations.length === 0) {
    setTableMessage(tbody, 5, 'Заявок на консультацию пока нет');
    return;
  }
  for (const item of consultations) {
    const tr = document.createElement('tr');
    tr.appendChild(el('td', 'cell-nowrap', formatDate(item.createdAt)));
    tr.appendChild(el('td', 'cell-nowrap', item.phone || '—'));
    tr.appendChild(el('td', '', item.clientName || '—'));
    tr.appendChild(el('td', 'cell-text', item.text || '—'));
    tr.appendChild(el('td', '', item.createdByName || '—'));
    tbody.appendChild(tr);
  }
}

// ---------- Пользователи ----------

const USER_ROLE_LABELS = { admin: 'Администратор', member: 'Сотрудник' };

async function loadUsers() {
  const tbody = $('users-tbody');
  setTableMessage(tbody, 5, 'Загрузка…');
  try {
    const data = await api(API_ROOT + '/api/admin/users');
    renderUsers(Array.isArray(data.users) ? data.users : []);
  } catch (err) {
    setTableMessage(tbody, 5, 'Не удалось загрузить пользователей');
    reportError(err);
  }
}

function renderUsers(users) {
  const tbody = $('users-tbody');
  tbody.replaceChildren();
  if (users.length === 0) {
    setTableMessage(tbody, 6, 'Пользователей пока нет');
    return;
  }
  users.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'));
  for (const user of users) {
    tbody.appendChild(buildUserRow(user));
  }
}

async function patchUser(id, patch, controls) {
  controls.forEach((c) => { c.disabled = true; });
  try {
    await api(API_ROOT + '/api/admin/users/' + encodeURIComponent(id), { method: 'PATCH', body: patch });
    showToast('Сохранено', 'success');
  } finally {
    controls.forEach((c) => { c.disabled = false; });
  }
}

function buildUserRow(user) {
  const tr = document.createElement('tr');
  tr.appendChild(el('td', 'cell-title', user.name || '—'));
  tr.appendChild(el('td', '', user.email || '—'));

  const controls = [];

  const roleTd = el('td', '');
  const roleSelect = document.createElement('select');
  for (const value of ['member', 'admin']) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = USER_ROLE_LABELS[value];
    if (user.role === value) opt.selected = true;
    roleSelect.appendChild(opt);
  }
  roleTd.appendChild(roleSelect);
  tr.appendChild(roleTd);

  const googleTd = el('td', 'cell-center');
  googleTd.appendChild(user.googleId ? badge('✅ да', 'ok') : badge('—', 'no'));
  tr.appendChild(googleTd);

  const activeTd = el('td', 'cell-center');
  const activeLabel = el('label', 'switch');
  const activeCheckbox = document.createElement('input');
  activeCheckbox.type = 'checkbox';
  activeCheckbox.checked = Boolean(user.active);
  activeLabel.appendChild(activeCheckbox);
  activeLabel.appendChild(el('span', 'switch-slider'));
  activeTd.appendChild(activeLabel);
  tr.appendChild(activeTd);

  controls.push(roleSelect, activeCheckbox);

  roleSelect.addEventListener('change', async () => {
    const next = roleSelect.value;
    try {
      await patchUser(user.id, { role: next }, controls);
      user.role = next;
    } catch (err) {
      roleSelect.value = user.role;
      reportError(err);
    }
  });

  activeCheckbox.addEventListener('change', async () => {
    const next = activeCheckbox.checked;
    try {
      await patchUser(user.id, { active: next }, controls);
      user.active = next;
    } catch (err) {
      activeCheckbox.checked = !next;
      reportError(err);
    }
  });

  // RunFerry-портал: Google-входа нет, поэтому ссылку привязки Telegram сотруднику выдаёт админ.
  const linkTd = document.createElement('td');
  const linkBtn = document.createElement('button');
  linkBtn.type = 'button';
  linkBtn.className = 'btn btn-secondary btn-small';
  linkBtn.textContent = user.telegramUserId ? 'Telegram ✓ (перепривязать)' : 'Привязать Telegram';
  linkBtn.addEventListener('click', async () => {
    linkBtn.disabled = true;
    try {
      const data = await api(API_ROOT + '/api/admin/users/' + encodeURIComponent(user.id) + '/telegram-link', { method: 'POST', body: {} });
      const text = data.url ? data.url : ('/start link_' + (data.token || ''));
      try { await navigator.clipboard.writeText(text); showToast('Ссылка скопирована — отправьте её сотруднику (действует 15 минут)', 'success'); }
      catch (_) { window.prompt('Отправьте сотруднику ссылку (15 минут):', text); }
    } catch (err) { reportError(err); } finally { linkBtn.disabled = false; }
  });
  linkTd.appendChild(linkBtn);
  tr.appendChild(linkTd);
  return tr;
}

async function handleAddUserSubmit(event) {
  event.preventDefault();
  const name = $('user-name').value.trim();
  const email = $('user-email').value.trim();
  const role = $('user-role').value;
  if (!name && !email) {
    showToast('Укажите имя или e-mail');
    return;
  }
  const body = { role };
  if (name) body.name = name;
  if (email) body.email = email;
  try {
    await api(API_ROOT + '/api/admin/users', { method: 'POST', body });
    $('user-name').value = '';
    $('user-email').value = '';
    showToast('Пользователь добавлен', 'success');
    loadUsers();
  } catch (err) {
    reportError(err);
  }
}

// ---------- Задачи ----------

const TASK_KIND_LABELS = { reminder: 'Напоминание', task: 'Задание' };
let taskUsers = [];

function userNameById(id) {
  const user = taskUsers.find((u) => u.id === id);
  return user ? user.name : '—';
}

function fillAssigneeSelect() {
  const select = $('task-assignee');
  if (!select) return;
  select.replaceChildren();
  for (const user of taskUsers.filter((u) => u.active)) {
    const opt = document.createElement('option');
    opt.value = user.id;
    opt.textContent = user.name + (user.telegramUserId ? ' · TG' : '');
    select.appendChild(opt);
  }
}

async function loadTasks() {
  const tbody = $('tasks-tbody');
  setTableMessage(tbody, 6, 'Загрузка…');
  try {
    if (isAdmin()) {
      const data = await api(API_ROOT + '/api/admin/tasks');
      taskUsers = Array.isArray(data.users) ? data.users : [];
      fillAssigneeSelect();
      renderTasks(Array.isArray(data.tasks) ? data.tasks : []);
    } else {
      const data = await api(API_ROOT + '/api/me/tasks');
      taskUsers = currentUser ? [currentUser] : [];
      renderTasks(Array.isArray(data.tasks) ? data.tasks : []);
    }
  } catch (err) {
    setTableMessage(tbody, 6, 'Не удалось загрузить задачи');
    reportError(err);
  }
}

function renderTasks(tasks) {
  const tbody = $('tasks-tbody');
  tbody.replaceChildren();
  if (tasks.length === 0) {
    setTableMessage(tbody, 6, 'Задач пока нет');
    return;
  }
  tasks.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });
  for (const task of tasks) {
    tbody.appendChild(buildTaskRow(task));
  }
}

function buildTaskRow(task) {
  const tr = document.createElement('tr');
  if (task.status === 'done') tr.className = 'task-done';
  tr.appendChild(el('td', 'cell-nowrap', TASK_KIND_LABELS[task.kind] || task.kind));

  const titleTd = el('td', 'cell-text', task.title || '—');
  if (task.result) {
    const res = el('div', 'task-result', '↳ ' + task.result);
    titleTd.appendChild(res);
  }
  tr.appendChild(titleTd);

  tr.appendChild(el('td', '', userNameById(task.assigneeUserId)));
  tr.appendChild(el('td', 'cell-nowrap', task.dueAt ? formatDate(task.dueAt) : '—'));

  const statusTd = el('td', 'cell-center');
  statusTd.appendChild(
    task.status === 'done' ? badge('✅ выполнено', 'ok') : badge('открыто', 'no'),
  );
  tr.appendChild(statusTd);

  const actionTd = el('td', 'cell-center');
  if (task.status === 'open') {
    const btn = el('button', 'btn btn-small', 'Выполнить');
    btn.addEventListener('click', () => completeTask(task, btn));
    actionTd.appendChild(btn);
  }
  tr.appendChild(actionTd);
  return tr;
}

async function completeTask(task, btn) {
  let result;
  if (task.kind === 'task') {
    result = window.prompt('Результат выполнения задания:');
    if (result === null) return;
    if (!result.trim()) {
      showToast('Нужно указать результат');
      return;
    }
  }
  btn.disabled = true;
  try {
    if (isAdmin()) {
      const body = { status: 'done' };
      if (result) body.result = result;
      await api(API_ROOT + '/api/admin/tasks/' + encodeURIComponent(task.id), { method: 'PATCH', body });
    } else {
      await api(API_ROOT + '/api/me/tasks/' + encodeURIComponent(task.id) + '/done', {
        method: 'POST',
        body: result ? { result } : {},
      });
    }
    showToast('Выполнено', 'success');
    loadTasks();
  } catch (err) {
    btn.disabled = false;
    reportError(err);
  }
}

async function handleAddTaskSubmit(event) {
  event.preventDefault();
  const kind = $('task-kind').value;
  const title = $('task-title').value.trim();
  const assigneeUserId = $('task-assignee').value;
  const dueLocal = $('task-due').value;
  if (!title) {
    showToast('Укажите текст задачи');
    return;
  }
  if (!assigneeUserId) {
    showToast('Выберите исполнителя');
    return;
  }
  if (kind === 'reminder' && !dueLocal) {
    showToast('Для напоминания укажите время');
    return;
  }
  const body = { kind, title, assigneeUserId };
  if (dueLocal) body.dueAt = new Date(dueLocal).toISOString();
  try {
    await api(API_ROOT + '/api/admin/tasks', { method: 'POST', body });
    $('task-title').value = '';
    $('task-due').value = '';
    showToast('Задача создана', 'success');
    loadTasks();
  } catch (err) {
    reportError(err);
  }
}

async function handleLinkTelegram() {
  const info = $('tasks-link-info');
  try {
    const data = await api(API_ROOT + '/api/me/telegram-link', { method: 'POST', body: {} });
    info.classList.remove('hidden');
    info.replaceChildren();
    if (data.url) {
      info.appendChild(document.createTextNode('Откройте ссылку в Telegram для привязки: '));
      const a = document.createElement('a');
      a.href = data.url;
      a.textContent = data.url;
      a.target = '_blank';
      a.rel = 'noopener';
      info.appendChild(a);
    } else {
      info.textContent = 'Откройте бота и отправьте /start с кодом: ' + (data.token || '');
    }
  } catch (err) {
    reportError(err);
  }
}

// ---------- Инициализация ----------

function init() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  $('login-form').addEventListener('submit', handleLoginSubmit);
  $('logout-btn').addEventListener('click', () => { void logout(); });

  $('refresh-chats').addEventListener('click', () => loadChats());
  $('refresh-results').addEventListener('click', () => loadResults(false));
  $('refresh-reminders').addEventListener('click', () => loadReminders());
  $('refresh-consultations').addEventListener('click', () => loadConsultations());
  $('refresh-users').addEventListener('click', () => loadUsers());
  $('add-user-form').addEventListener('submit', handleAddUserSubmit);
  $('refresh-tasks').addEventListener('click', () => loadTasks());
  $('add-task-form').addEventListener('submit', handleAddTaskSubmit);
  $('link-telegram').addEventListener('click', handleLinkTelegram);

  $('test-call-form').addEventListener('submit', handleTestCallSubmit);

  void bootstrap();
}

/** Определяем, вошёл ли уже пользователь (сессия или токен), иначе экран входа. */
async function bootstrap() {
  // Активная сессия? Проверяем ПЕРВОЙ — вошедшего пользователя не задерживаем
  // ожиданием загрузки скрипта Google.
  try {
    const res = await fetch(API_ROOT + '/api/auth/me', { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json();
      onAuthenticated(data.user);
      return;
    }
  } catch (_e) {
    // нет сессии — пробуем токен ниже
  }
  // Сохранённый аварийный токен?
  if (getToken()) {
    try {
      await api(API_ROOT + '/api/admin/chats');
      currentUser = { role: 'admin', name: 'admin (токен)' };
      showApp();
      return;
    } catch (_e) {
      localStorage.removeItem(TOKEN_KEY);
    }
  }
  // Не вошли — показываем экран входа и готовим кнопку Google.
  showLogin('');
  await initGoogleSignIn();
}

document.addEventListener('DOMContentLoaded', init);
