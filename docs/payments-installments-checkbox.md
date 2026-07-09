# Оплата частями (monobank, ПриватБанк) + авто-чеки Checkbox — как это устроено и как автоматизировать

> Документ для владельца ФОП/сервиса RunFerry. Цель — заменить ручное оформление рассрочки и ручную выписку чеков (то, что сейчас делает жена в Telegram) на автоматический флоу в вашем backend (Node/Express на Cloud Run + Firestore). Все секреты — только через env/Secret Manager, согласно политике проекта.

---

## 1. Коротко: что происходит сейчас и что автоматизируем

**Сейчас (вручную):**
- Клиент хочет оплатить кораблик частями → жена вручную оформляет рассрочку через Telegram-переписку с банком/клиентом.
- После оплаты фискальный чек ПРРО тоже выбивается вручную (и его легко забыть).

**Что автоматизируем:**
1. **Инициацию оплаты частями** — backend сам создаёт заявку/счёт в банке по API, клиент подтверждает у себя в приложении, backend ловит подтверждение.
2. **Авто-выдачу фискального чека** — по факту успешной оплаты backend сам вызывает Checkbox и выбивает чек ПРРО. «Забыть чек» становится технически невозможно.

**Ключевое различие продуктов, которое нельзя путать:**

| Что | monobank | ПриватБанк |
|---|---|---|
| Обычная оплата картой | Интернет-эквайринг (Plata by mono), `invoice/create`, токен `X-Token` | LiqPay `paytype=card` |
| Оплата **частями** | **Отдельный продукт** «Покупка Частинами» (`u2.monobank.com.ua`, `order/*`, подпись HMAC) | LiqPay `paytype=paypart` / `moment_part` (та же интеграция!) |
| Фискальный чек | Не выдаёт сам → Checkbox отдельно | Не выдаёт сам → Checkbox отдельно |

**Главная ловушка monobank:** рассрочку **НЕЛЬЗЯ** включить параметром `paymentType` в обычном эквайринге — там `paymentType` умеет только `debit`/`hold`/`verification`. «Частини» — это совсем другой API и другой договор.

**Практический вывод по выбору:**
- Для ПриватБанка проще всего **LiqPay**: одна интеграция даёт и обычную карту, и части (`paypart`/`moment_part`).
- Для monobank части — это отдельное подключение (`order/create → confirm`), сложнее, чем эквайринг.
- Чек в обоих случаях выбивается через **Checkbox** единым модулем «платёж подтверждён → выбить чек».

---

## 2. monobank — оплата/покупка частинами (API, что подготовить, комиссии)

У monobank **два независимых продукта** со своими API, договорами и ключами.

### 2.1. Продукт 1 — Интернет-эквайринг (Plata by mono) — обычная оплата картой

Нужен, если рассрочка не требуется (карта / Apple Pay / Google Pay).

- **Base URL:** `https://api.monobank.ua`
- **Авторизация:** заголовок `X-Token: <токен мерчанта>` (боевой — из `web.monobank.ua` → «Управління еквайрингом»; тестовый — на `api.monobank.ua`).

**Основные методы:**
- `POST /api/merchant/invoice/create` — создать счёт.
  Тело: `amount` (int, **в копейках**, обяз.), `ccy` (int ISO4217, по умолч. `980`=UAH), `merchantPaymInfo {reference, destination, comment, basketOrder:[{name, qty, sum, code, ...}]}` (обяз., если включена фискализация), `redirectUrl`, `webHookUrl`, `validity` (сек, по умолч. 24ч, макс 30 дней), `paymentType` (`"debit"`|`"hold"`|`"verification"`), `qrId`, `code`, `saveCardData{saveCard}`, `agentFeePercent`, `tipsEmployeeId`, `displayType` (`"iframe"`).
  Ответ 200: `{invoiceId, pageUrl}` (`pageUrl` вида `https://pay.mbnk.biz/xxx`).
- `GET /api/merchant/invoice/status?invoiceId=...` — статус.
  `status ∈ created | processing | hold | success | failure | reversed | expired`.
- `POST /api/merchant/invoice/cancel` — возврат (полный/частичный).
- `POST /api/merchant/invoice/finalize` — списание с холда (для `paymentType=hold`).
- `GET /api/merchant/invoice/receipt?invoiceId=...` — квитанция.
- `GET /api/merchant/details` — данные мерчанта `{merchantId, merchantName, edrpou}`.
- `GET /api/merchant/pubkey` — публичный ключ для проверки подписи вебхуков.

**Вебхук эквайринга:** при `invoice/create` передаёте `webHookUrl`; monobank шлёт `POST` при смене статуса (тело = объект как в `/invoice/status`). Оплата прошла = `status="success"` (для холда — `"hold"`, затем `finalize` → `"success"`).
**Проверка подлинности:** в заголовке `X-Sign` — base64-подпись; проверяется **ECDSA по SHA256 от СЫРОГО тела** публичным ключом из `GET /api/merchant/pubkey` (ключ кэшировать, обновлять при неуспехе проверки). Обязательно отвечать `200`, иначе monobank ретраит. Подстраховка при потере вебхука — опрос `GET /api/merchant/invoice/status`.

> На самой странице `pay.mbnk.biz` клиенту иногда бывает доступна кнопка «Оплатити частинами», но это решается настройками мерчанта на стороне банка, **а не параметром** в `invoice/create`.

### 2.2. Продукт 2 — «Покупка Частинами / Оплата частинами» (розстрочка) — это и есть замена ручного флоу жены

- **Base URL:** prod `https://u2.monobank.com.ua`; sandbox `https://u2-demo-ext.mono.st4g3.com`; stage `https://u2-ext.mono.st4g3.com`
- **Авторизация:** заголовки `store-id: <идентификатор магазина>` и `signature: Base64(HMAC-SHA256(тело_запроса_как_байты, store_secret))`. Это **НЕ** тот же токен, что у эквайринга.

**Методы:**
- `POST /api/order/create` — создать заявку на рассрочку.
  Ключевые поля: `store_order_id` (уник., идемпотентность), `client_phone` (`+380XXXXXXXXX`), `total_sum`, `available_programs` (какие программы предложить: «оплата частинами» на 2/3/4 без %, либо «розстрочка» до ~24–25 платежей), `products`/`goods[] {name, count, sum}`, `result_callback` (URL вебхука).
- `POST /api/order/state` — опрос статуса заявки.
- `POST /api/order/confirm` — подтвердить после согласия клиента (после этого списывается первый платёж).
- `POST /api/order/reject` — отклонить/отменить.

**Статусы (`state` / `order_sub_state`):**
`WAITING_FOR_CLIENT`, `WAITING_FOR_STORE_CONFIRM` (клиент согласился — магазину надо подтвердить), `ACTIVE`, `DONE`, `RETURNED`.
FAIL/*: `CLIENT_NOT_FOUND`, `EXCEEDED_SUM_LIMIT`, `EXISTS_OTHER_OPEN_ORDER`, `NOT_ENOUGH_MONEY_FOR_INIT_DEBIT`, `REJECTED_BY_CLIENT`, `FRAUD_REJECTED`, `RESTRICTED_BY_RISKS`, `CLIENT_PUSH_TIMEOUT`, `REJECTED_BY_STORE`, `FAIL`.

**Флоу (по шагам):**
1. Backend: `POST /api/order/create` (со `store-id` + `signature`). Записать заказ в Firestore со статусом `WAITING_FOR_CLIENT`.
2. Клиенту в приложение monobank прилетает push — он выбирает число платежей и подтверждает договор.
3. На `result_callback` приходит `WAITING_FOR_STORE_CONFIRM` → проверить HMAC-подпись → если товар/услуга готовы к отгрузке, backend автоматически шлёт `POST /api/order/confirm`.
4. После `confirm` списывается первый платёж, статус → `ACTIVE` (затем `DONE` после полной оплаты).
5. Финал (`ACTIVE`/`DONE`) надёжнее ловить опросом `POST /api/order/state` (Cloud Scheduler раз в N минут по «висящим» заказам) — **callback на эти статусы не гарантирован**.

**Вебхук частин (`result_callback`):** приходит **только** в двух случаях: (1) переход в `IN_PROCESS`/`WAITING_FOR_STORE_CONFIRM`; (2) любой `FAIL/*`. Тело вида `{order_id, state, order_sub_state}`. Подлинность — пересчёт HMAC-SHA256 и сравнение с заголовком `signature`.
**Момент «оплата пошла» для фискализации** — переход в `ACTIVE` после вашего `confirm` (списан первый платёж).

### 2.3. Комиссии и ограничения (частини monobank)

- **Комиссию платит МАГАЗИН (продавец), а не клиент.** Для клиента 0% и без переплат. Размер зависит от числа платежей (ориентир: ~2,9% при разбивке на 2 платежа, растёт с числом частей).
- Метод **недоступен** магазинам, которые пытаются переложить комиссию на покупателя.
- Число платежей: «оплата частинами» — обычно 2/3/4 без %; «розстрочка» — до ~24–25 платежей. Точные `available_programs` и лимиты сумм задаёт банк в договоре.
- Работает **только** для клиентов с аккаунтом monobank (возможен `CLIENT_NOT_FOUND`). Оформление по номеру телефона + подтверждение в приложении — «молча» списать нельзя.
- Договор на частини оформляется **без POS-терминала**; эквайринговую комиссию по нему платить не нужно (это разные вещи).

### 2.4. Что подготовить (monobank)

- [ ] **Эквайринг:** заключить договор интернет-эквайринга (Plata by mono) на ФОП (заявка в monoбізнес). POS-терминал не нужен.
- [ ] **Эквайринг:** получить боевой `X-Token` в `web.monobank.ua` → «Управління еквайрингом». Тестовый — на `api.monobank.ua`. Хранить в env/Secret Manager, **не в коде**.
- [ ] **Эквайринг:** публичный HTTPS `webHookUrl` на Cloud Run + проверка подписи `X-Sign` через `GET /api/merchant/pubkey`.
- [ ] **Частини:** это **отдельное** подключение — подать заявку на «Покупка Частинами» и заключить отдельный договор партнёра. Получить `store-id` и `store_secret` (HMAC-ключ).
- [ ] **Частини:** сначала интеграция в sandbox (`u2-demo-ext.mono.st4g3.com`), потом прод-креды и переход на `u2.monobank.com.ua`.

**Официальная документация:**
- https://monobank.ua/en/api-docs/acquiring
- https://monobank.ua/en/api-docs/acquiring/methods/ia/post--api--merchant--invoice--create
- https://monobank.ua/en/api-docs/acquiring/methods/ia/get--api--merchant--invoice--status
- https://api.monobank.ua/docs/acquiring.html
- https://monobank.ua/en/knowledge-base/acquiring/online/website/api/token
- https://monobank.ua/en/api-docs/chast
- https://monobank.ua/knowledge-base/chast/about
- https://monobank.ua/en/knowledge-base/chast/how-it-works

---

## 3. ПриватБанк / LiqPay — оплата частями (API, paytype, что подготовить)

Два пути. **Рекомендуемый — LiqPay**: одна интеграция и для обычной карты, и для частей.

### 3.1. LiqPay — основной путь

- **Базовый хост:** `https://www.liqpay.ua/api/`
- **Client-Server (редирект/HTML-форма):** `POST https://www.liqpay.ua/api/3/checkout` — форма с hidden-полями `data` и `signature`.
- **Server-Server:** `POST https://www.liqpay.ua/api/request` — тело `data` и `signature` (напр. `status`/`refund`/`hold_completion`).
- **Версия:** `version=3`.
- **Авторизация:** `public_key` (в JSON внутри `data`) + `private_key` (только для подписи, на сервере, наружу не отдаётся).

**Кодирование и подпись:**
- `data = base64(JSON)`.
- `signature = base64(sha1(private_key + data + private_key))` — важно брать **бинарный** digest sha1 (в PHP `sha1($str, true)`), не hex. Тот же алгоритм — для проверки входящего вебхука.

**Ключевые параметры JSON:** `public_key`, `version=3`, `action` (`pay`|`hold`|`subscribe`|`status`|`refund`|`auth`), `amount`, `currency=UAH`, `description`, `order_id` (уник. ID заказа), `server_url` (URL вебхука), `result_url` (куда вернуть клиента), `language` (`uk`/`en`), `sandbox` (`1` для теста).

**Параметр частей — `paytype`.** Значения: `card`, `privat24`, `apay` (Apple Pay), `gpay` (Google Pay), **`paypart`** (оплата частями — комиссия на продавце), **`moment_part`** (мгновенная рассрочка — комиссия на покупателе), `invoice`, `qr`. Можно передать списком через запятую, чтобы клиент выбрал. Число платежей клиент выбирает на странице LiqPay.

**Разница двух типов частей:**
- **`paypart`** — «Оплата частинами»: комиссию платит **ПРОДАВЕЦ** (тариф растёт с числом платежей), покупателю ставка ~0,01%, **деньги продавцу сразу** в полном объёме.
- **`moment_part`** — «Миттєва розстрочка»: для продавца **бесплатно**, процент (~1,9%/мес) платит **покупатель**.
- Оба: сумма 300–300 000 грн, срок 1–24 мес, только UAH. Активируется в кабинете LiqPay в меню «Кредити» (~15 минут).

**Пример JSON перед кодированием:**
```json
{"public_key":"i000000000","version":3,"action":"pay","amount":5000,"currency":"UAH","description":"Кораблик RunFerry, оплата частями","order_id":"order-2026-0001","paytype":"paypart","server_url":"https://<cloudrun>/api/liqpay/callback","result_url":"https://runferry.../thanks"}
```

**Пример подписи (Node.js):**
```js
const crypto = require('crypto');
const data = Buffer.from(JSON.stringify(params)).toString('base64');
const signature = crypto.createHash('sha1').update(privateKey + data + privateKey).digest('base64');
// на фронт отдать { data, signature } и запостить формой на https://www.liqpay.ua/api/3/checkout
```

**Вебхук LiqPay — как узнать, что оплата прошла:**
LiqPay шлёт `POST` на `server_url` с полями формы `data` (base64 JSON) и `signature`.
Алгоритм проверки на backend:
1. взять пришедшие `data` и `signature`;
2. посчитать `own = base64(sha1(private_key + data + private_key))`;
3. сравнить `own` с `signature` — совпало → запрос подлинный;
4. декодировать `data` из base64 в JSON.
Ключевые поля вебхука: `status`, `order_id`, `amount`, `currency`, `payment_id`, `action`, `paytype`, `sender_card_mask2`.
**Статусы:** финальные — `success`, `failure`, `error`, `reversed`, `subscribed`/`unsubscribed`; промежуточные — `hold_wait` (для `action=hold` далее `hold_completion` через `api/request`), `processing`, `prepared`, а также `3ds_verify`/`otp_verify`/`cvv_verify`.
**Триггер автоматики:** обрабатывать чек **только** при `status=success` (для `paypart`/`moment_part` `success` = банк одобрил и продавцу зачислено).
Важно: быстро вернуть `200`, чек Checkbox выписывать в фоне; операция **идемпотентна по `order_id`** (возможны повторные колбэки). **Никогда не доверять `result_url`** (это редирект клиента) — источник истины только `server_url`.

### 3.2. Альтернатива — прямой PrivatBank PayParts API (без LiqPay)

Дублирует то, что уже даёт LiqPay; брать только если нужен полный контроль над рассрочкой без LiqPay.

- **Базовый URL:** `https://payparts2.privatbank.ua/ipp/v2`
- `POST /payment/create` — создать платёж (`state=CREATED`). Поля: `storeId` (до 20 симв.), `orderId` (до 64), `amount` (300–50000), `partsCount` (2–25), `merchantType` (`II` — мгновенная рассрочка, `PP` — оплата частями, `PB`, `IA`), `products [{name, count, price}]`, `responseUrl`, `redirectUrl`, `signature`.
- `POST /payment/confirm`, `POST /payment/cancel` — подтверждение/отмена холда; `POST /payment/state` — состояние.
- **Подпись запроса:** `base64(sha1(password + storeId + orderId + amount + partsCount + merchantType + responseUrl + redirectUrl + productsString + password))`, где `productsString` = конкатенация (`name + count + price`) по каждому товару.
- **Подпись успешного ответа/колбэка:** `base64(sha1(password + state + storeId + orderId + token + password))`.
- Колбэк приходит `POST` на `responseUrl` со `state` (`SUCCESS`/`FAIL`) и `token`.
- Ключи `storeId` и merchant `password` — в кабинете `payparts2.privatbank.ua/ipp/admin` (отдельный договор).

### 3.3. Что подготовить (ПриватБанк / LiqPay)

- [ ] **LiqPay:** зарегистрировать мерчанта (кабинет ПриватБанка/LiqPay), получить `public_key` и `private_key` в настройках API. `private_key` — только env/Secret Manager, никогда на фронте.
- [ ] **LiqPay:** активировать части в кабинете, меню «Кредити» (`paypart` и/или `moment_part`), привязать счёт ФОП 2600.../IBAN. Активация ~15 мин.
- [ ] Определиться, кто платит комиссию: `paypart` (платит ФОП, клиенту ~0%) или `moment_part` (бесплатно ФОП, процент на клиенте). Часто дают оба — клиент выбирает.
- [ ] Прописать `server_url` (вебхук на Cloud Run) и `result_url`; вебхук публичный по HTTPS, отвечает `200`.
- [ ] **Опционально** прямой PayParts: договор «Оплата Частинами», кабинет `payparts2.privatbank.ua/ipp/admin`, `storeId` + merchant `password` + `recipientId`.

**Официальная документация:**
- https://www.liqpay.ua/documentation/en
- https://www.liqpay.ua/documentation/en/data_signature
- https://www.liqpay.ua/documentation/en/api/aquiring/checkout/doc
- https://www.liqpay.ua/en/doc/api/callback
- https://www.liqpay.ua/methods/paypart
- https://www.liqpay.ua/ru/documentation/api/public/part_payment
- https://github.com/liqpay/sdk-php · https://github.com/liqpay/sdk-python
- https://payparts2.privatbank.ua/ipp/admin/
- https://api.privatbank.ua/

---

## 4. Checkbox — авто-выдача фискального чека (ПРРО): пошаговый API-флоу

Checkbox — ПРРО №1 в Украине. Его REST API позволяет с backend полностью автоматизировать выписку чека при каждой оплате. monobank/LiqPay **сами чек не выдают** — обязанность выдать чек лежит на ФОП через ПРРО.

- **Базовый URL:** prod `https://api.checkbox.in.ua` (в SDK/доках также встречается `https://api.checkbox.ua`); тест `https://dev-api.checkbox.in.ua`. Версия — `v1`.
- **Swagger:** `https://api.checkbox.in.ua/api/docs` · **портал:** `https://my.checkbox.ua`
- **Глобальные заголовки:** `X-Client-Name` (имя интеграции, напр. `"RunFerry-Backend"`), `X-Client-Version` (опц.), `X-License-Key` (лицензионный ключ кассы), `Authorization: Bearer <access_token>` (JWT кассира после signin).

### 4.1. Модель работы

Флоу построен на **смене (shift)** и чеках внутри неё:
1. Авторизация кассира → JWT.
2. Открытие смены (регистрируется в ДПС, ~5–7 сек).
3. На каждую продажу — чек продажи; сервер сам отправляет его в ДПС и возвращает фискальный номер/код.
4. Доставка чека клиенту (email/SMS/ссылка/QR/PDF).
5. В конце дня — закрытие смены (Z-отчёт).

**Смена не может быть открыта >24 часов** — закрывать раз в сутки (крон).

**Единицы измерения (частая ошибка!):** суммы (`price`/`value`/`total`) — **целые числа в КОПЕЙКАХ** (150.00 грн = `15000`); количество (`quantity`) — **в тысячных** (1 шт = `1000`, 0.5 = `500`). Сумма `payments` должна **точно равняться** сумме `goods` (с учётом `rounding`), иначе `4xx`.

### 4.2. API-методы

**1) Авторизация кассира:**
- `POST /api/v1/cashier/signin` — тело `{ "login": "...", "password": "..." }` → `{ "access_token": "JWT" }`.
- `POST /api/v1/cashier/signinPinCode` — в заголовке `X-License-Key`, в теле `{ "pin_code": "..." }`. Удобно для backend: один пин на кассу.
- `GET /api/v1/cashier/me` · `GET /api/v1/cashier/check-signature` · `POST /api/v1/cashier/signout`.

**2) Смена:**
- `POST /api/v1/shifts` — открыть (заголовок `X-License-Key`). Ответ `status` `CREATED` → `OPENED` (после ДПС). Перед чеками дождаться `OPENED` (поллинг `GET /api/v1/shifts/{shift_id}` или пауза ~5–7 сек).
- `GET /api/v1/shifts/{shift_id}` — статус (`CREATED`/`OPENED`/`CLOSING`/`CLOSED`).
- `GET /api/v1/cashier/shift` — текущая активная смена кассира.
- `POST /api/v1/shifts/close` — закрыть (Z-отчёт формируется автоматически).

**3) Чек продажи — `POST /api/v1/receipts/sell`, минимальное тело:**
```json
{
  "id": "<uuid чека, генерите сами — идемпотентность>",
  "cashier_name": "ФОП Прізвище",
  "goods": [
    {
      "good": { "code": "SKU-001", "name": "Кораблик прикормочний X", "price": 1500000 },
      "quantity": 1000
    }
  ],
  "payments": [
    { "type": "CASHLESS", "value": 1500000, "label": "Оплата частинами (monobank)" }
  ],
  "delivery": { "email": "client@mail.com" }
}
```
- `goods[].good`: `{ code, name, price (копейки), tax?, barcode?, uktzed? }` (для ФОП 2–3 гр. обычно без НДС).
- `payments[].type` — enum: `CASH`, `CASHLESS` (безнал/карта/части — используйте это), `CARD`. Плюс `value` (копейки) и `label`.
- `discounts[]`, `rounding`, `related_receipt_id` (для возврата) — опционально.
- Ответ: `{ id, serial, fiscal_code, fiscal_date, status, tax_url, transaction.response_status: "OK" }`.

**4) Выдача чека клиенту / представления:**
- `GET /api/v1/receipts/{receipt_id}` — данные + `fiscal_code` + `status`.
- `.../html` · `.../pdf` · `.../text` (для термопринтера) · `.../png` · `.../qrcode` · `.../xml`.
- `POST /api/v1/receipts/{receipt_id}/email` · `POST /api/v1/receipts/{receipt_id}/sms`. Либо просто дать клиенту `tax_url`.

**5) Офлайн-режим:** если нет связи с ДПС — `/receipts/sell` продолжает работать (сервер сам присваивает офлайн-код и дату); есть `POST /api/v1/receipts/sell-offline` с явным `fiscal_code`/`fiscal_date`. Пакет офлайн-кодов ограничен. Контроль: `GET /api/v1/cashier/check-offline-time`.
> Важно: если между оплатой и фискализацией прошло **>5 минут**, Checkbox требует офлайн-режим: `POST /api/v1/cash-registers/go-offline` → `POST /api/v1/receipts/sell-offline` с `fiscal_date` = временем банковской операции.

**6) Эквайринг / автофискализация Checkbox (invoices) — под кейс частин monobank:**
- Checkbox умеет формировать счёт у провайдера (`provider: MONOBANK`/`EASYPAY`, `acquiring_type: QR`/`INTERNET`). В теле — блок чека (`goods`/`payments`) + сумма + `callback_url`; в ответ — платёжная ссылка/QR (до 24 ч).
- После оплаты Checkbox **АВТОМАТИЧЕСКИ** фискализирует чек — `/receipts/sell` вручную звать не надо.
- Статусы счёта: `CREATED` → `PAID`. Отмена — только для `CREATED` (по uuid).

### 4.3. Как узнать, что оплата прошла и чек выписан

- **Вариант A (Checkbox invoices):** при создании счёта передаёте `callback_url` — Checkbox дёргает ваш endpoint при оплате и после фискализации. Можно и поллить статус счёта/чека.
- **Вариант B (monobank acquiring + Checkbox как фискализатор):** monobank шлёт вебхук об оплате (`success`) → вы читаете `GET https://api.monobank.ua/api/merchant/invoice/fiscal-checks?invoiceId=...` (заголовок `X-Token`). Ответ — массив `checks: { id, status (new/process/done/failed), type (sale/return), fiscalizationSource (checkbox/monopay), taxUrl, file (PDF base64), statusDescription }`. Чек **выписан при `status="done"`** → доступны `taxUrl` и PDF.
- **Вариант C (свой чек через `/receipts/sell`):** вебхука на оплату нет — вы сами зовёте `sell` после сигнала платёжного слоя; статус берёте из ответа (`transaction.response_status == "OK"`, есть `fiscal_code`) или поллингом `GET /receipts/{id}`.

### 4.4. Что подготовить (Checkbox)

- [ ] Аккаунт ФОП на `my.checkbox.ua` (паспорт, ІПН, данные торговой точки). Рассчитан на ФОП групп 2–3.
- [ ] КЕП/ЭЦП кассира: файловый ключ **или ОБЛАЧНЫЙ** через DepositSign (рекомендуется облачный — не держать файл на сервере, не переподписывать вручную).
- [ ] Зарегистрированная касса (ПРРО) в кабинете — регистрируется в ДПС.
- [ ] Зарегистрированный кассир (`login`+`password` **или** `pin_code`).
- [ ] Лицензионный ключ кассы (`LICENSE_KEY`) → заголовок `X-License-Key`.
- [ ] Активный **тариф** Checkbox (платная подписка за кассу) — иначе фискализация не работает.
- [ ] Для автофискализации оплат: счёт ФОП в monobank для бизнеса + эквайринг (~1,3% за транзакцию) **или** эквайринг через invoices Checkbox (`MONOBANK`/`EASYPAY`).
- [ ] env на Cloud Run: `CHECKBOX_LICENSE_KEY`, `CHECKBOX_PIN_CODE` (или login/password), `MONOBANK_TOKEN` — только env/Secret Manager, не хардкодить.
- [ ] Публичный HTTPS endpoint для вебхуков (`callback_url`/`webHookUrl`).

**Официальная документация:**
- https://wiki.checkbox.ua/uk/api · https://wiki.checkbox.ua/api/receipts
- https://wiki.checkbox.ua/uk/api/invoices · https://wiki.checkbox.ua/uk/instructions/mono
- https://api.checkbox.in.ua/api/docs · https://api.checkbox.in.ua/api/openapi.json
- https://my.checkbox.ua · https://checkbox.ua/
- https://checkbox.ua/blog/intehratsiia-checkbox-iz-monobank-iak-pryjmaty-oplaty-j-vydavaty-cheky-bez-turbot/
- https://monobank.ua/api-docs/acquiring/extras/prro/get--api--merchant--invoice--fiscal-checks

---

## 5. Архитектура автоматизации в RunFerry (оплата → вебхук → авто-чек), что создать у нас в backend

Стек: **Node/Express на Cloud Run + Firestore**. Идея — единый обработчик «платёж подтверждён → выбить чек», общий для всех платёжных путей.

### 5.1. Firestore

Коллекция `orders/{orderId}` с полями:
- `orderId` / `store_order_id` / `invoiceId` — **идемпотентность**;
- `status` (`pending`/`WAITING_FOR_CLIENT`/`paid`/`ACTIVE`/`DONE`/`failed`);
- `paytype` / `provider` (monobank-chast / liqpay-paypart / …);
- `amount`, `goods[]`;
- `receiptId` / `fiscal_code` / `tax_url` — признак «чек выбит» (защита от задвоения).

### 5.2. Эндпоинты backend

**A) Инициация оплаты — `POST /api/pay/create`**
Вход: `orderId`/сумма/тип (обычная карта или части).
- **LiqPay:** строит JSON (`action=pay`, `currency=UAH`, `order_id`, `server_url=<CloudRun>/api/liqpay/callback`, `result_url`; для частей `paytype:"paypart"`/`"moment_part"` или оба). `data=base64(JSON)`, `signature=base64(sha1(privateKey+data+privateKey))`. Возвращает фронту `{ data, signature }` → фронт постит форму на `https://www.liqpay.ua/api/3/checkout`.
- **monobank частини:** `POST https://u2.monobank.com.ua/api/order/create` со `store-id` + `signature=Base64(HMAC-SHA256(body, store_secret))`; `store_order_id`=uuid из Firestore, `client_phone`, `total_sum`, `products[]`, `available_programs`, `result_callback`.
- **monobank эквайринг (без рассрочки):** `POST /api/merchant/invoice/create` (`X-Token`) → отдать клиенту `pageUrl` (в SMS/Telegram-ссылку/страницу заказа).

В Firestore создать `orders/{orderId}` со статусом `pending` и `paytype`.

**B) Вебхук LiqPay — `POST /api/liqpay/callback`** (публичный, без auth-мидлвари):
1. прочитать `req.body.data` и `req.body.signature`;
2. пересчитать подпись, сравнить — не совпало → `400`;
3. декодировать `data` → JSON;
4. **идемпотентно по `order_id`**: если `receiptId` уже есть → сразу `200`;
5. если `status==="success"` → `orders/{orderId}=paid` + запустить фискализацию;
6. вернуть `200`.

**C) Вебхук monobank эквайринга — `POST` на `webHookUrl`:** проверить `X-Sign` (ECDSA/SHA256 от сырого тела, ключ из `/api/merchant/pubkey`) → при `status="success"` запустить фискализацию → `200`.

**D) Вебхук monobank частин — `POST` на `result_callback`:** проверить HMAC-SHA256 (заголовок `signature`) → при `WAITING_FOR_STORE_CONFIRM` обновить Firestore и автоматически `POST /api/order/confirm`.

**E) Cloud Scheduler (крон):**
- Опрос «висящих» частин: `POST /api/order/state` → при `ACTIVE` запустить фискализацию (callback на `ACTIVE`/`DONE` не гарантирован).
- Раз в сутки закрытие смены Checkbox: `POST /api/v1/shifts/close`.

### 5.3. Единый модуль фискализации Checkbox (общий для всех путей)

Обработчик «платёж подтверждён» (триггеры: LiqPay `success` / monobank эквайринг `success` / monobank частини `ACTIVE`):
1. Проверить в Firestore, что чек ещё не выбит (идемпотентность по `invoiceId`/`store_order_id`/`order_id`).
2. `POST /api/v1/cashier/signinPinCode` (кэшировать `access_token`, при `401` — повторный signin).
3. Проверить активную смену `GET /api/v1/cashier/shift`; если нет — `POST /api/v1/shifts`, ждать `OPENED`.
4. `POST /api/v1/receipts/sell` — `goods` из заказа, `payments:[{type:"CASHLESS", value:<копейки>}]`, `id`=uuid (идемпотентность).
5. Сохранить `fiscal_code`/`receipt_id`/`tax_url`/QR в Firestore; при необходимости отправить клиенту ссылку/PDF (email/SMS).

**Надёжность:**
- Чек выписывать **в фоне** (после `res.status(200)`, либо Cloud Tasks/PubSub) — вебхук всегда получает быстрый `200`.
- Ретраи Checkbox; учесть лимит **2 чека/сек** (иначе блок 5 сек).
- Всегда **копейки/тысячные**, `payments == goods`.
- Между оплатой и чеком >5 мин → офлайн-режим (`go-offline` → `sell-offline` с `fiscal_date`).

**Порядок вызовов (частини monobank):**
`order/create` → `[callback WAITING_FOR_STORE_CONFIRM]` → `order/confirm` → `[poll order/state=ACTIVE]` → Checkbox `receipts/sell` → save to Firestore.

**Порядок вызовов (LiqPay):**
`/api/pay/create` → форма на `/api/3/checkout` → `[callback status=success]` → Checkbox `signinPinCode` → (смена) → `receipts/sell` → save to Firestore.

---

## 6. Что подготовить владельцу (чеклисты, ключи, договоры, ФОП/касса)

**ФОП и касса:**
- [ ] ФОП групп 2–3, зарегистрированный **ПРРО** (Checkbox), активный тариф Checkbox.
- [ ] КЕП кассира — предпочтительно **облачный** (DepositSign).
- [ ] Обязанность выдавать фискальный чек при **каждой** оплате картой/безналом.

**monobank:**
- [ ] Договор интернет-эквайринга (Plata by mono) → `X-Token`.
- [ ] **Отдельно** договор «Покупка Частинами» → `store-id` + `store_secret`.
- [ ] Sandbox частин (`u2-demo-ext.mono.st4g3.com`) → потом прод (`u2.monobank.com.ua`).
- [ ] `webHookUrl` (эквайринг) + `result_callback` (частини) на Cloud Run, проверка подписей.

**ПриватБанк / LiqPay:**
- [ ] Мерчант LiqPay → `public_key` + `private_key`.
- [ ] Активировать «Кредити» (`paypart`/`moment_part`), привязать счёт ФОП/IBAN.
- [ ] `server_url` + `result_url`.
- [ ] (Опц.) прямой PayParts: `storeId` + `password` + `recipientId`.

**Секреты (только env/Secret Manager, не в коде и не на фронте):**
- [ ] `MONOBANK_TOKEN` (X-Token эквайринга)
- [ ] `MONO_CHAST_STORE_ID`, `MONO_CHAST_STORE_SECRET`
- [ ] `LIQPAY_PUBLIC_KEY`, `LIQPAY_PRIVATE_KEY`
- [ ] `CHECKBOX_LICENSE_KEY`, `CHECKBOX_PIN_CODE` (или login/password)

**Firestore:**
- [ ] Коллекция `orders` с идемпотентностью и признаком «чек выбит».

---

## 7. Юридические/налоговые нюансы и риски

- **Оплата частями — это НЕ рассрочка чеком.** Вы обязаны выбить чек на **ПОЛНУЮ** стоимость товара в момент продажи (деньги вам приходят сразу от банка; клиент гасит банку). В чеке ПРРО это **одна** оплата `CASHLESS` на полную сумму. Не бить чек по кускам платежей.
- **Комиссию за части платит магазин** (monobank; LiqPay `paypart`) — переложить на клиента нельзя, иначе метод недоступен. `moment_part` — бесплатно продавцу, процент на клиенте. Обычная карта LiqPay ~2,2–2,75%; эквайринг monobank ~1,3%.
- **Юридически** «Оплата частинами» — по сути кредитный продукт банка клиенту: продавец получает деньги сразу, кредитные отношения между банком и покупателем.
- **Смена ПРРО** не может быть открыта >24 ч — закрывать раз в сутки (Z-отчёт), иначе чеки перестанут проходить.
- **Единицы:** только целые копейки и тысячные; `payments == goods` — иначе `4xx` или неверная сумма.
- **Асинхронность ДПС:** открытие смены и фискализация проходят не мгновенно — нужен поллинг (`CREATED→OPENED`, чек до `fiscal_code`). Не считать готовым сразу по `200`.
- **Офлайн-режим** ограничен пакетом кодов и лимитом времени — периодически касса должна быть онлайн. Задержка чека >5 мин → `sell-offline` с `fiscal_date`.
- **Лимит Checkbox** — 2 чека/сек.
- **Активация** `paypart`/`moment_part` в кабинете LiqPay обязательна — без неё `paytype` вернёт ошибку.
- **Безопасность (критично):** обязательно проверять подписи вебхуков — `X-Sign`/ECDSA (monobank эквайринг), HMAC-SHA256 (monobank частини), `sha1(private_key+data+private_key)` (LiqPay). Иначе можно подделать «оплату» и выбить чек/отгрузить товар без денег. Никогда не доверять `result_url` — только серверный callback. Секреты — только в env/Secret Manager.
- **Ответственность** за корректность номенклатуры/сумм в чеке — на ФОП.
- Точные текущие URL прод (`api.checkbox.in.ua` vs `api.checkbox.ua`) и схему полей сверять по живому Swagger `/api/docs` — API версионируется.

---

## 8. Рекомендованный порядок внедрения (по шагам)

1. **База ФОП/ПРРО.** Зарегистрировать/проверить ФОП, ПРРО и Checkbox (касса, кассир, облачный КЕП DepositSign, лицензионный ключ, активный тариф). Прогнать вручную один тестовый чек через `my.checkbox.ua`.
2. **Модуль Checkbox в backend (фундамент).** Реализовать `signinPinCode` (кэш токена, авто-переавторизация по `401`), открытие/закрытие смены, `receipts/sell` (копейки/тысячные, идемпотентность по `id`). Крон закрытия смены раз в сутки. Проверить в `dev-api.checkbox.in.ua`.
3. **LiqPay (быстрый путь к оплате картой + частями).** Подключить мерчанта, `public_key`/`private_key`, активировать «Кредити». Реализовать `/api/pay/create` и `/api/liqpay/callback` (проверка подписи, идемпотентность по `order_id`). Сначала `sandbox:1`.
4. **Связать LiqPay → Checkbox.** В обработчике `status=success` вызывать модуль фискализации (в фоне). Тест end-to-end в песочнице: оплата частями `paypart` → авто-чек с `fiscal_code`/`tax_url` клиенту.
5. **monobank эквайринг** (обычная карта/Apple/Google Pay). `invoice/create` + `webHookUrl` с проверкой `X-Sign`. Подключить к тому же модулю фискализации.
6. **monobank частини** (замена ручного Telegram-флоу). Sandbox `u2-demo-ext.mono.st4g3.com`: `order/create` → callback `WAITING_FOR_STORE_CONFIRM` → авто-`order/confirm` → крон-опрос `order/state=ACTIVE` → фискализация. Затем прод `u2.monobank.com.ua`.
7. **Надёжность и переход в прод.** Ретраи и идемпотентность везде; крон-опросы «висящих» заказов; логирование и алерты на ошибки фискализации; учесть офлайн-режим и лимиты. Убрать `sandbox`, переключить креды на боевые, вынести все секреты в Secret Manager.
8. **Отключить ручной процесс.** После стабильной работы вывести жену из ручного оформления в Telegram — и рассрочка, и чеки идут автоматически.

**Официальная документация (сводно):**
- monobank: https://monobank.ua/en/api-docs/acquiring · https://monobank.ua/en/api-docs/chast · https://monobank.ua/en/knowledge-base/chast/how-it-works
- LiqPay/PrivatBank: https://www.liqpay.ua/documentation/en · https://www.liqpay.ua/methods/paypart · https://payparts2.privatbank.ua/ipp/admin/
- Checkbox: https://wiki.checkbox.ua/uk/api · https://wiki.checkbox.ua/uk/instructions/mono · https://api.checkbox.in.ua/api/docs
