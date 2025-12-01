# API Documentation / Документация API

## Общая информация

### Base URL
- **Production**: `https://portal.runferry.com/api/hs/`
- **Mock (Development)**: `http://localhost:3001`

### Аутентификация
Все запросы (кроме GET) автоматически включают учетные данные кораблика:
```json
{
  "boatId": "BOAT001",
  "boatPassword": "password123"
}
```

### Формат ответа
Все API методы возвращают унифицированный формат:

```typescript
interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: {
    code: string
    message: string
  }
}
```

---

## Структуры данных (Models)

### Reservoir (Водоем)
```typescript
interface Reservoir {
  id: string           // Уникальный идентификатор
  number: number       // Порядковый номер водоема
  name: string         // Название водоема
  basePoint: {         // Базовая точка (домашняя позиция)
    lat: number        // Широта
    lng: number        // Долгота
  }
  pointsCount: number  // Количество точек на водоеме
}
```

### Point (Точка)
```typescript
interface Point {
  id: string           // Уникальный идентификатор
  reservoirId: string  // ID водоема, к которому принадлежит точка
  number: number       // Порядковый номер точки
  name: string         // Название точки
  coordinates: {       // Координаты точки
    lat: number        // Широта
    lng: number        // Долгота
  }
  depth?: number       // Глубина (опционально), в метрах
  createdAt: string    // Дата создания (ISO 8601)
}
```

### Delivery (История завоза)
```typescript
interface Delivery {
  id: string                               // Уникальный идентификатор
  pointId: string                          // ID точки завоза
  timestamp: string                        // Время завоза (ISO 8601)
  duration: number                         // Продолжительность в секундах
  distance: number                         // Расстояние в метрах
  status: 'completed' | 'aborted' | 'failed'  // Статус завоза
}
```

### BoatInfo (Информация о кораблике)
```typescript
interface BoatInfo {
  id: string           // ID кораблика
  name: string         // Название кораблика
  firmware: string     // Версия прошивки
}
```

### Distributor (Дистрибьютор)
```typescript
interface Distributor {
  id: string           // Уникальный идентификатор
  name: string         // Название дистрибьютора
  region: string       // Регион
}
```

### Share (Данные шаринга)
```typescript
interface Share {
  id: string           // Уникальный идентификатор
  shareKey: string     // Ключ для шаринга
  reservoirId: string  // ID водоема
  expiresAt: string    // Дата истечения (ISO 8601)
}
```

---

## API Endpoints

### 1. Boats (Кораблики)

#### Проверка учетных данных кораблика
Проверяет валидность ID и пароля кораблика.

**Endpoint:** `GET /boats?id={boatId}`

**Request:**
```typescript
interface BoatVerifyRequest {
  boatId: string
  password: string
}
```

**Response:**
```typescript
interface BoatVerifyResponse {
  valid: boolean
  boatInfo?: BoatInfo  // Присутствует только если valid: true
}
```

**Пример запроса:**
```
GET /boats?id=BOAT001
```

**Пример ответа (успешный):**
```json
{
  "success": true,
  "data": {
    "valid": true,
    "boatInfo": {
      "id": "BOAT001",
      "name": "My Bait Boat",
      "firmware": "v2.5.1"
    }
  }
}
```

**Коды ошибок:**
- `VERIFICATION_FAILED` - Ошибка проверки учетных данных

---

### 2. Reservoirs (Водоемы)

#### Получить все водоемы
Возвращает список всех водоемов для указанного кораблика.

**Endpoint:** `GET /reservoirs?boatId={boatId}`

**Response:**
```typescript
interface GetReservoirsResponse {
  reservoirs: Reservoir[]
}
```

**Пример запроса:**
```
GET /reservoirs?boatId=BOAT001
```

**Пример ответа:**
```json
{
  "success": true,
  "data": {
    "reservoirs": [
      {
        "id": "res-1",
        "number": 1,
        "name": "Озеро Синевир",
        "basePoint": { "lat": 48.6167, "lng": 23.6833 },
        "pointsCount": 7
      }
    ]
  }
}
```

**Коды ошибок:**
- `FETCH_FAILED` - Ошибка загрузки водоемов

---

#### Переименовать водоем
Изменяет название водоема.

**Endpoint:** `PATCH /reservoirs/{id}`

**Request:**
```typescript
interface RenameReservoirRequest {
  boatId: string
  boatPassword: string
  reservoirNumber: number
  newName: string
}
```

**Request Body:**
```json
{
  "name": "Новое название",
  "boatId": "BOAT001",
  "boatPassword": "password123"
}
```

**Response:**
```typescript
{
  success: boolean
  data?: Reservoir
}
```

**Коды ошибок:**
- `NOT_FOUND` - Водоем не найден
- `UPDATE_FAILED` - Ошибка обновления

---

#### Создать ссылку для шаринга
Генерирует уникальный ключ для шаринга водоема.

**Endpoint:** `POST /shares`

**Request Body:**
```json
{
  "shareKey": "abc123xyz",
  "reservoirId": "res-1",
  "expiresAt": "2025-01-01T00:00:00Z",
  "boatId": "BOAT001",
  "boatPassword": "password123"
}
```

**Response:**
```typescript
interface ShareReservoirResponse {
  shareKey: string    // Уникальный ключ для шаринга
  expiresAt: string   // Дата истечения (7 дней)
}
```

**Пример ответа:**
```json
{
  "success": true,
  "data": {
    "shareKey": "abc123xyz",
    "expiresAt": "2025-12-06T20:01:52.528Z"
  }
}
```

**Коды ошибок:**
- `SHARE_FAILED` - Ошибка создания ссылки

---

#### Получить водоем по ключу шаринга
Возвращает данные водоема и его точки по ключу шаринга.

**Endpoint:** `GET /shares?shareKey={key}`

После получения shareKey:
- `GET /reservoirs/{reservoirId}` - получить водоем
- `GET /points?reservoirId={reservoirId}` - получить точки

**Response:**
```typescript
interface GetSharedResponse {
  reservoir: Reservoir
  points: Point[]
}
```

**Коды ошибок:**
- `NOT_FOUND` - Ссылка не найдена или истекла
- `FETCH_FAILED` - Ошибка загрузки данных

---

#### Импортировать водоем по ключу шаринга
Импортирует водоем со всеми точками в указанный кораблик.

**Метод API:** `reservoirsApi.importShared(shareKey, boatId, boatPassword)`

**Параметры:**
```typescript
interface ImportSharedParams {
  shareKey: string       // Ключ шаринга
  boatId: string         // ID кораблика-получателя
  boatPassword: string   // Пароль кораблика-получателя
}
```

**Процесс импорта:**
1. Получение данных шаринга по ключу (`GET /shares?shareKey={key}`)
2. Получение оригинального водоема (`GET /reservoirs/{reservoirId}`)
3. Получение всех точек водоема (`GET /points?reservoirId={reservoirId}`)
4. Создание нового водоема для целевого кораблика (`POST /reservoirs`)
5. Копирование всех точек в новый водоем (`POST /points` для каждой точки)

**Response:**
```typescript
interface ImportSharedResponse {
  reservoir: Reservoir   // Созданный водоем
}
```

**Пример использования:**
```typescript
const result = await reservoirsApi.importShared(
  'abc123xyz',           // shareKey
  'BOAT002',             // целевой boatId
  'demo456'              // пароль целевого кораблика
)

if (result.success) {
  console.log('Водоем импортирован:', result.data?.reservoir)
}
```

**Коды ошибок:**
- `NOT_FOUND` - Ссылка шаринга не найдена или истекла
- `IMPORT_FAILED` - Ошибка импорта водоема

---

### 3. Points (Точки)

#### Получить точки водоема
Возвращает все точки для указанного водоема.

**Endpoint:** `GET /points?reservoirId={reservoirId}`

**Response:**
```typescript
interface GetPointsResponse {
  points: Point[]
}
```

**Пример запроса:**
```
GET /points?reservoirId=res-1
```

**Пример ответа:**
```json
{
  "success": true,
  "data": {
    "points": [
      {
        "id": "pt-1",
        "reservoirId": "res-1",
        "number": 1,
        "name": "Точка біля берега",
        "coordinates": { "lat": 48.617, "lng": 23.684 },
        "depth": 3.5,
        "createdAt": "2024-01-15T10:00:00Z"
      }
    ]
  }
}
```

**Коды ошибок:**
- `FETCH_FAILED` - Ошибка загрузки точек

---

#### Создать точку
Создает новую точку на водоеме.

**Endpoint:** `POST /points`

**Request:**
```typescript
interface CreatePointRequest {
  boatId: string
  boatPassword: string
  reservoirId: string
  name: string
  coordinates: {
    lat: number
    lng: number
  }
  depth?: number
}
```

**Request Body:**
```json
{
  "id": "pt-1234567890",
  "reservoirId": "res-1",
  "number": 5,
  "name": "Новая точка",
  "coordinates": { "lat": 48.617, "lng": 23.684 },
  "depth": 4.5,
  "createdAt": "2025-01-15T10:00:00Z",
  "boatId": "BOAT001",
  "boatPassword": "password123"
}
```

**Response:**
```typescript
{
  success: boolean
  data?: Point
}
```

**Примечание:** При создании точки также обновляется `pointsCount` водоема.

**Коды ошибок:**
- `CREATE_FAILED` - Ошибка создания точки

---

#### Обновить точку
Обновляет данные существующей точки.

**Endpoint:** `PATCH /points/{pointId}`

**Request Body:**
```json
{
  "name": "Обновленное название",
  "depth": 5.0,
  "boatId": "BOAT001",
  "boatPassword": "password123"
}
```

**Response:**
```typescript
{
  success: boolean
  data?: Point
}
```

**Коды ошибок:**
- `UPDATE_FAILED` - Ошибка обновления точки

---

#### Удалить точку
Удаляет точку с водоема.

**Endpoint:** `DELETE /points/{pointId}`

**Response:**
```typescript
{
  success: boolean
}
```

**Примечание:** При удалении точки также обновляется `pointsCount` водоема.

**Коды ошибок:**
- `DELETE_FAILED` - Ошибка удаления точки

---

### 4. Deliveries (История завозов)

#### Получить историю завозов для точки
Возвращает историю завозов для указанной точки, отсортированную по дате (новые первые).

**Endpoint:** `GET /deliveries?pointId={pointId}`

**Response:**
```typescript
interface GetDeliveriesResponse {
  deliveries: Delivery[]
}
```

**Пример ответа:**
```json
{
  "success": true,
  "data": {
    "deliveries": [
      {
        "id": "del-1",
        "pointId": "pt-1",
        "timestamp": "2024-11-20T08:30:00Z",
        "duration": 180,
        "distance": 45,
        "status": "completed"
      }
    ]
  }
}
```

**Коды ошибок:**
- `FETCH_FAILED` - Ошибка загрузки истории

---

#### Получить историю завозов для водоема
Возвращает историю завозов для всех точек водоема.

**Endpoint:** Составной запрос:
1. `GET /points?reservoirId={reservoirId}` - получить все точки
2. `GET /deliveries` - получить все завозы
3. Фильтрация по pointIds на клиенте

**Response:**
```typescript
interface GetDeliveriesResponse {
  deliveries: Delivery[]
}
```

**Коды ошибок:**
- `FETCH_FAILED` - Ошибка загрузки истории

---

### 5. Distributors (Дистрибьюторы)

#### Получить список дистрибьюторов
Возвращает список всех дистрибьюторов.

**Endpoint:** `GET /distributors`

**Response:**
```typescript
interface GetDistributorsResponse {
  distributors: Distributor[]
}
```

**Пример ответа:**
```json
{
  "success": true,
  "data": {
    "distributors": [
      {
        "id": "dist-1",
        "name": "Fishing Pro Ukraine",
        "region": "Ukraine"
      }
    ]
  }
}
```

---

## Коды ошибок

| Код | Описание |
|-----|----------|
| `VERIFICATION_FAILED` | Ошибка проверки учетных данных кораблика |
| `FETCH_FAILED` | Ошибка загрузки данных |
| `CREATE_FAILED` | Ошибка создания записи |
| `UPDATE_FAILED` | Ошибка обновления записи |
| `DELETE_FAILED` | Ошибка удаления записи |
| `NOT_FOUND` | Запись не найдена |
| `SHARE_FAILED` | Ошибка создания ссылки шаринга |
| `IMPORT_FAILED` | Ошибка импорта водоема |

---

## HTTP статусы

| Статус | Описание | Действие |
|--------|----------|----------|
| `200` | Успешный запрос | - |
| `401` | Неавторизован | Очистка учетных данных кораблика |
| `403` | Доступ запрещен | Лог ошибки |
| `500+` | Ошибка сервера | Лог ошибки |

---

## Примеры использования

### Аутентификация и получение водоемов
```typescript
// 1. Проверка учетных данных кораблика
const verifyResult = await boatsApi.verify({
  boatId: 'BOAT001',
  password: 'password123'
})

if (verifyResult.success && verifyResult.data?.valid) {
  // 2. Сохранение учетных данных
  authStore.setBoatCredentials({
    boatId: 'BOAT001',
    boatPassword: 'password123'
  })

  // 3. Получение водоемов
  const reservoirsResult = await reservoirsApi.getAll('BOAT001')

  if (reservoirsResult.success) {
    console.log(reservoirsResult.data?.reservoirs)
  }
}
```

### Работа с точками
```typescript
// Получить точки водоема
const pointsResult = await pointsApi.getByReservoir('res-1')

// Создать новую точку
const createResult = await pointsApi.create({
  reservoirId: 'res-1',
  name: 'Новая точка',
  coordinates: { lat: 48.617, lng: 23.684 },
  depth: 4.5
})

// Удалить точку
const deleteResult = await pointsApi.delete('pt-123')
```

### Шаринг водоема
```typescript
// Создать ссылку для шаринга
const shareResult = await reservoirsApi.share('res-1')
const shareKey = shareResult.data?.shareKey

// Получить водоем по ключу (для просмотра)
const sharedResult = await reservoirsApi.getShared(shareKey)
console.log(sharedResult.data?.reservoir)
console.log(sharedResult.data?.points)

// Импортировать водоем в другой кораблик
const importResult = await reservoirsApi.importShared(
  shareKey,
  selectedBoat.credentials.boatId,
  selectedBoat.credentials.boatPassword
)

if (importResult.success) {
  console.log('Водоем импортирован:', importResult.data?.reservoir)
}
```

---

## Settings API (Настройки кораблика)

### Внешний API
- **URL**: `http://160baf.cube-host.online:8812/InfoBase1/hs/ad`
- **Auth**: Basic Auth (iis/sas)

### Backend (наш сервер)
- **URL**: `http://localhost:3002`
- Проксирует запросы к внешнему API
- Скрывает credentials от клиента

### Структуры данных

#### BoatSettingParameter (Параметр настройки)
```typescript
interface BoatSettingParameter {
  ID: number                      // ID параметра
  Name: string                    // Название параметра
  Value: Record<string, string>   // Варианты значений (ключ -> описание)
}
```

#### BoatSettingGroup (Группа настроек)
```typescript
interface BoatSettingGroup {
  group_name: string              // Название группы
  parameters: BoatSettingParameter[]  // Параметры в группе
}
```

### Получить схему настроек

Возвращает список всех доступных настроек с их вариантами значений.

**Endpoint:** `GET /RTL/`

**Query Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| Localization | string | Локализация (en_US, uk_UA, ru_RU) |
| Email | string | Email пользователя |
| chipId | string | ID кораблика |
| chipType | string | Тип чипа |

**Пример запроса:**
```
GET /RTL/?Localization=uk_UA&Email=user@example.com&chipId=BOAT001&chipType=chip_type
```

**Пример ответа:**
```json
[
  {
    "group_name": "Main setting of driving",
    "parameters": [
      {
        "ID": 34,
        "Name": "Швидкість завезення",
        "Value": {
          "1": "10",
          "2": "20",
          "3": "30",
          "4": "40",
          "5": "50",
          "6": "60",
          "7": "70",
          "8": "80",
          "9": "90"
        }
      },
      {
        "ID": 30,
        "Name": "Proportional (PID)",
        "Value": {
          "0": "0",
          "1": "1",
          "2": "2",
          "3": "3",
          "4": "4",
          "5": "5"
        }
      }
    ]
  },
  {
    "group_name": "SONAR test",
    "parameters": [
      {
        "ID": 205,
        "Name": "Sonar enable",
        "Value": {
          "0": "НІ",
          "1": "Так"
        }
      }
    ]
  }
]
```

### Группы настроек

| Группа | Описание |
|--------|----------|
| ESP test | Настройки ESP (FlySky, NOW) |
| SONAR test | Настройки эхолота |
| Main setting of driving | Основные настройки вождения (PID, скорости) |
| Дія при натисканні тримерів | Действия триммеров |
| Додаткові виходи живлення | Дополнительные выходы питания |
| Додаткові серво виходи | Дополнительные серво выходы |
| Іконки мобільного додатку | Иконки мобильного приложения |
| Основні серво виходи | Основные серво выходы |
| Параметри основних виходів | Параметры основных выходов |
| Плата живлення - виходи | Плата питания - выходы |
| Фічі | Дополнительные функции |

### Примеры использования

```typescript
import { settingsApi } from '@/api/endpoints/settings'

// Получить схему настроек
const schemaResult = await settingsApi.getSettingsSchema({
  chipId: 'BOAT001',
  localization: 'uk_UA'
})

if (schemaResult.success) {
  const groups = schemaResult.data
  groups.forEach(group => {
    console.log(`Группа: ${group.group_name}`)
    group.parameters.forEach(param => {
      console.log(`  ${param.ID}: ${param.Name}`)
    })
  })
}
```
