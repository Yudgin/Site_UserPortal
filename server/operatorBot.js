// Операторский Telegram-бот (поглощение проекта TelegramBot, ~5.8k строк TS — референс-исходники
// в operator-bot-src/). Решения владельца: тот же бот с переездом вебхука к нам; операторы —
// коллекция botOperators; ремонты — сразу наши заявки; хостинг — этот Cloud Run.
//
// Фаза Б1 (каркас): маршрут вебхука + гейт по токену/секрету. Пока TELEGRAM_OPERATOR_BOT_TOKEN
// не задан в env — модуль «спит» (безопасно деплоится). Перенос логики (dispatcher, callCard,
// clientFlow, repairView, results, serviceChoice, taskDeliver, archive) — фазы Б1–Б3.
export function registerOperatorBot(app, deps) {
  const TOKEN = process.env.TELEGRAM_OPERATOR_BOT_TOKEN || ''
  const SECRET = process.env.TELEGRAM_OPERATOR_WEBHOOK_SECRET || ''
  if (!TOKEN) {
    console.log('operatorBot: TELEGRAM_OPERATOR_BOT_TOKEN не задано — модуль вимкнено (фаза Б4)')
    return
  }

  app.post('/api/telegram/operator/webhook', async (req, res) => {
    res.sendStatus(200) // отвечаем сразу, чтобы Telegram не ретраил
    try {
      if (SECRET && req.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) {
        console.warn('operatorBot webhook: bad secret token')
        return
      }
      // TODO Б1: диспетчеризация апдейтов (порт operator-bot-src/bot/dispatcher.ts)
      console.log('operatorBot update:', JSON.stringify(req.body || {}).slice(0, 200))
    } catch (e) {
      console.error('operatorBot webhook error:', e.message)
    }
  })
}

export default registerOperatorBot
