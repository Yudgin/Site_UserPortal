import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

import uk from './locales/uk.json'
import ru from './locales/ru.json'
import en from './locales/en.json'
import de from './locales/de.json'
import ro from './locales/ro.json'
import pl from './locales/pl.json'

export const languages = [
  { code: 'en', name: 'English', flag: '🇬🇧' },
  { code: 'uk', name: 'Українська', flag: '🇺🇦' },
  { code: 'ru', name: 'Русский', flag: '🇷🇺' },
  { code: 'de', name: 'Deutsch', flag: '🇩🇪' },
  { code: 'ro', name: 'Română', flag: '🇷🇴' },
  { code: 'pl', name: 'Polski', flag: '🇵🇱' },
]

// Check if user has previously selected a language
const LANGUAGE_KEY = 'i18nextLng'
const hasStoredLanguage = localStorage.getItem(LANGUAGE_KEY) !== null

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      uk: { translation: uk },
      ru: { translation: ru },
      en: { translation: en },
      de: { translation: de },
      ro: { translation: ro },
      pl: { translation: pl },
    },
    lng: hasStoredLanguage ? undefined : 'en', // Default to English for new users
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage'],
      caches: ['localStorage'],
    },
  })

export default i18n
