import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import en from './locales/en.js'
import ta from './locales/ta.js'

const savedLanguage = localStorage.getItem('avc-language')

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ta: { translation: ta },
  },
  lng: savedLanguage === 'ta' ? 'ta' : 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnNull: false,
})

i18n.on('languageChanged', (language) => {
  const nextLanguage = language === 'ta' ? 'ta' : 'en'
  localStorage.setItem('avc-language', nextLanguage)
  document.documentElement.lang = nextLanguage
})

export default i18n
