# Портал my.runferry.com — правила репозитория

Репозиторий **публичный** (`Yudgin/Site_UserPortal`): секретов в коде, коммитах и описаниях нет.

## Выпуск в бой — только по docs/service-requirements.md §39

- Бой = проект Google `droidmaps-runferry`: Cloud Run `runferry-backend` (europe-west3), хостинг `droidmaps-runferry`
  (my.runferry.com), правила и индексы Firestore, задания Cloud Scheduler.
- На каждом компьютере портал выпускает **одна** сессия выпусков портала этого компьютера. На Mac владельца —
  «Портал: главная сессия выпусков». Остальные сессии в бой ничего не отправляют, а присылают ей заявку.
- Правда о бое — новейшая ветка `origin/deploy/backend-*`; `main` после каждого выпуска перематывается до неё (с
  2026-11-20). Новую работу резать от **новейшей** `origin/deploy/*` и перед заявкой влить её ещё раз.
- Перед любой командой выпуска — `scripts/portal-release-guard.sh`. Ответ «НЕЛЬЗЯ» — не выпускать.
- **Никогда** `--env-vars-file`, `--set-env-vars`, `--set-secrets`, `--clear-env-vars` у `gcloud run`: они стирают
  переменные боя. Индексы — никогда `firebase deploy … --force`.
- `--project droidmaps-runferry` — в каждой команде `gcloud` и `firebase`.

## Коммиты

Заголовок по-английски; описание сначала по-английски, потом по-русски; в конце строка `Session: <название сессии>`,
затем `Co-Authored-By`. Добавлять файлы явными путями.
