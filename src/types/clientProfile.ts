// Профиль клиента. Ключ (id документа) — нормализованный телефон, поэтому записи с
// одинаковым номером автоматически попадают в один профиль (авто-слияние по телефону).
// Google-вход связывается через authUids. Массивы наполняются arrayUnion (только добавление).

export interface ClientProfile {
  id: string // = нормализованный телефон
  phone: string
  name?: string
  email?: string
  authUids: string[] // связанные Firebase Auth uid (Google и т.д.)
  boatIds: string[] // clientBoat записи клиента
  sessionIds: string[] // чат-сессии клиента
  taskIds: string[] // задачи сервиса клиента
  updatedAt: string
}
