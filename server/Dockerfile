# Cloud Run образ бэкенда RunFerry (боты Telegram/Viber + AI-эндпоинты + NP/1С-прокси).
# Слушает на $PORT (Cloud Run задаёт 8080); index.js читает process.env.PORT.
# Креды Firebase — через ADC рантайм-сервис-аккаунта Cloud Run (firebase-admin applicationDefault()).
# Секреты (ANTHROPIC_API_KEY, TELEGRAM_*, VIBER_*, NP_API_KEY, SETTINGS_*) передаются как env Cloud Run.
FROM node:20-slim

WORKDIR /app

# Сначала манифесты — для кэша слоёв
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Остальной код (.env исключён через .gcloudignore/.dockerignore)
COPY . .

ENV NODE_ENV=production
# Cloud Run сам инжектит PORT=8080; EXPOSE — документирующий
EXPOSE 8080

CMD ["node", "index.js"]
