# sip-engine — SIP-движок голосового шлюза

Небольшая программа на C++ (pjsua2 из pjproject 2.17). Сама ничего не решает: регистрируется линией в Binotel,
принимает и набирает звонки, проигрывает WAV, переводит звонки и соединяет их — по командам «мозга»
(`voice-gateway/brain`, Node). Обмен — JSON по одной строке: команды в stdin, события из stdout.
Журнал pjsip и движка идёт **только в stderr**; stdout чистый (посторонний вывод библиотек тоже перенаправлен в stderr).

## Сборка

```sh
make            # → ./sip-engine
make clean
```

Нужны: pjproject 2.17 из Homebrew (`/opt/homebrew/Cellar/pjproject/2.17`, статические библиотеки) и `openssl@4`
(`/opt/homebrew/opt/openssl@4`). pkg-config нет, поэтому флаги из `lib/pkgconfig/libpjproject.pc` переписаны
в `Makefile` вручную. Пути переопределяются: `make PJ=... SSL=...`. Компилятор — clang++, C++17, macOS arm64.

## Как устроено

- Один поток: `threadCnt = 0`, `mainThreadOnly = true`; главный цикл чередует `select()` по stdin (10 мс)
  и `libHandleEvents(10)`. Звуковой карты нет (`setNullDev`), мост 8 кГц.
- Транспорт только **UDP** (TCP не создаётся). Кодеки: PCMA = 255, PCMU = 254, остальные выключены.
  Когда отвечаем на чужое предложение и в нём есть PCMA, из ответа убирается PCMU — выбирается PCMA
  (иначе pjmedia взял бы порядок собеседника).
- Номера звонков (`call`) — собственные возрастающие числа движка (1, 2, 3…), не индексы pjsua: номер
  завершённого звонка никогда не достанется новому.
- Объекты звонков удаляются после `DISCONNECTED` в главном цикле, проигрыватели — через ~1 с после
  отключения (не из их собственных колбэков). Команда для неизвестного или завершённого звонка даёт `error`.
- Входящий звонок движок **не** берёт сам — решает мозг (`answer` / `hangup`). pjsua сам шлёт только 100 Trying.
- В боевом режиме (`register`) UDP-транспорт слушает 0.0.0.0, поэтому INVITE принимается только с доверенных IP:
  адреса сервера из DNS, адрес, откуда пришёл 2xx на REGISTER, и поле `trust`. С остальных — 403 в главном цикле,
  мозг получает лишь `{"ev":"untrusted","src":…}` (без `incoming`, без `state` по этому звонку). В локальном
  режиме адрес не проверяется.
- Входящие REFER и INVITE с Replaces движок отклоняет (603): шлюзу они не нужны.
- `xfer` / `xfer_replaces`: на финальный 2xx движок сам кладёт переводящую ногу.
- Повторы набора на 503 делает **мозг** (новый `dial` с новым `ref`), движок не повторяет.
- Пароль SIP не печатается нигде: команда `register` в журнал пишется только именем, буфер строки затирается.

## Протокол

Команды (stdin):

| Команда | Поля | Что делает |
|---|---|---|
| `register` | `server`, `user`, `password`, `expires` (по умолч. 120), `trust` (необяз., IP через запятую) | боевой режим: UDP-транспорт на случайном порту, `idUri sip:user@server`, регистратор `sip:server;transport=udp`, outbound proxy `sip:server;transport=udp;lr`, digest с realm `*`, NAT как в pjsua (rewrite Contact/Via, `;ob`); INVITE — только с IP сервера (DNS, ответ на REGISTER) и из `trust` |
| `local` | `bind` (127.0.0.1), `port` (5092), `user` (gw) | тестовый режим без регистратора: `sip:gw@127.0.0.1:5092` |
| `answer` | `call`, `code` (200) | ответить (180/183/200 или отказ ≥300) |
| `hangup` | `call`, `code` (необяз., напр. 486 для неотвеченного) | положить / отклонить |
| `play` | `call`, `file` (WAV PCM16 моно 8 кГц), `loop`, `tag` | заменить текущее проигрывание; если медиа ещё нет — начнётся, когда появится |
| `stop` | `call` | остановить проигрывание |
| `dial` | `ref`, `uri` | исходящий звонок |
| `xfer` | `call`, `uri` | слепой перевод (REFER) |
| `xfer_replaces` | `call` (A), `dest` (B) | сопровождаемый перевод: REFER на A с Replaces ноги B (Refer-To `…?Replaces=…` без `Require=replaces` — как консоль pjsua в ручной проверке с Binotel) |
| `bridge` | `a`, `b` | локальный мост звука A↔B в обе стороны (запасной вариант), останавливает проигрыватели |
| `quit` | — | положить всё, снять регистрацию, выйти с кодом 0 (то же при конце stdin и SIGTERM/SIGINT) |

События (stdout):

| Событие | Поля |
|---|---|
| `ready` | — (движок запущен, ждёт `register`/`local`) |
| `reg` | `code`, `reason`, `active`, `expires`; в локальном режиме один раз `{code:200, reason:"local", active:true, local:true}` |
| `incoming` | `call`, `from` (`sip:0500000001@45.91.130.64`), `number`, `name`, `gcid` (X-BINOTEL-GCID или `null`), `to`, `set_caller_id` (X-BINOTEL-SET-CALLER-ID или `null`), `src` (IP:порт отправителя) |
| `untrusted` | `src`, `method` — INVITE с недоверенного адреса отклонён 403 (только боевой режим) |
| `dialing` | `ref`, `call` — всегда **первое** событие исходящего звонка (CALLING и т. п. идут после) |
| `state` | `call`, `state` (CALLING/INCOMING/EARLY/CONNECTING/CONFIRMED/DISCONNECTED), `code`, `reason` |
| `media` | `call`, `active` (меняется, напр. при удержании) |
| `play_done` | `call`, `tag` — только для `loop:false`, в конце файла |
| `xfer` | `call`, `code`, `reason`, `final` (pjsua сообщает 202 как `100 Accepted`, затем NOTIFY 100, 200) |
| `dtmf` | `call`, `digit` (RFC 2833) |
| `error` | `cmd`, `call`, `ref`, `msg`; если `dial` не удалось начать — `{cmd:"dial", ref, call:null}` без `dialing` |

Заголовки X-BINOTEL-* ищутся без учёта регистра; `from`/`to` берутся из самого INVITE (pjsua в CallInfo
теряет порт).

## Журнал

stderr: строки `[engine] ...` и журнал pjsip. Уровень — `SIP_ENGINE_LOG_LEVEL` (0–6, по умолчанию 3;
4 — с текстами SIP-сообщений). Номер входящего в строках `[engine]` — только последние 4 цифры. На уровне 4
в журнал попадают полные INVITE — **номера и имена клиентов**, заголовки X-BINOTEL-*; значения
`Authorization`/`Proxy-Authorization` и `nonce`/`opaque` в `WWW-`/`Proxy-Authenticate` заменяются на `<…>`
(по digest-ответу иначе можно подбирать пароль линии офлайн). Такой журнал не пересылать целиком. Строки `conference.c Remove port N failed: PJ_EINVAL` при остановке
проигрывателя безвредны: деструктор проигрывателя в pjsua2 дважды снимает порт с моста.

## Проверка без Binotel

```sh
./smoke-test.sh     # всё только на 127.0.0.1; журналы в .smoke/
```

Скрипт собирает движок и запускает `smoke-test.mjs` (Node 24): движок в локальном режиме и два `pjsua`
(`--null-audio --no-tcp --auto-answer 200`, управление через stdin), плюс «сырой» SIP через UDP и
поддельный регистратор. Проверяет:

0. `ready`, `local`, ошибки на неизвестные звонки, кривой JSON и неудачный `dial`;
1a. «сырой» INVITE: `gcid` из `X-Binotel-Gcid`, имя, номер, отказ 486 (+ ACK);
1. pjsua звонит на шлюз → `incoming` → `answer` → приветствие (`play` до появления медиа) → `media`,
   `play_done` через ~4,86 с; запись у pjsua — звук есть; кодек PCMA, хотя pjsua предлагает PCMU раньше;
2. движок звонит pjsua → CONFIRMED → удержание по кругу → замена приветствием → `play_done` → `hangup`;
3. слепой перевод REFER на второй pjsua: события `xfer` 100, 100, 200 (final), нога положена, второй pjsua
   получил звонок;
4. сопровождаемый перевод `xfer_replaces` A→B: второй pjsua получил INVITE с Replaces, обе ноги шлюза
   закрыты, xfer 200 (final);
5. `bridge`: звук второго pjsua доходит до первого через шлюз;
6. `quit` → код 0, в stdout только JSON;
7. `register` на поддельный регистратор 127.0.0.1:5096: 401 → digest (проверяется по паролю) → 200,
   REGISTER на `sip:…;transport=udp`, INVITE с `Route: <sip:…;transport=udp;lr>`, в SDP только 8/0/telephone-event,
   503 доходит до мозга как `state DISCONNECTED code 503`, при выходе — REGISTER с expires 0;
   пароль не найден ни в stderr, ни в stdout, ни в SIP-пакетах;
7b. боевой режим, проверка адреса: INVITE с 127.0.0.1 (адрес регистратора) → `incoming` с `src`; с LAN-адреса
   этой машины → 403 и только `untrusted`; с `trust` = LAN-адрес → снова `incoming`;
8. конец stdin и SIGTERM → звонки положены, код 0.

На настоящем Binotel движок этим скриптом **не** проверялся — это следующий шаг (живой звонок на линию 901).
