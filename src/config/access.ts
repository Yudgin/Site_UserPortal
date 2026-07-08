// Доступ администратора к редактированию прайс-листа.
//
// Пока определяется по email. Та же проверка продублирована в firestore.rules
// (request.auth.token.email) — то есть запись в прайс защищена и на уровне базы,
// а не только в интерфейсе. При добавлении администратора обновить оба места.

export const ADMIN_EMAILS = ['admin@runferry.de']

export const isAdminEmail = (email: string | null | undefined): boolean =>
  !!email && ADMIN_EMAILS.includes(email.toLowerCase())
