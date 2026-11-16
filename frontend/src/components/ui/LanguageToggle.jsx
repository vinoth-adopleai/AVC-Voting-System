import { useTranslation } from 'react-i18next'

export default function LanguageToggle({ className = '' }) {
  const { i18n, t } = useTranslation()
  const currentLanguage = i18n.resolvedLanguage === 'ta' ? 'ta' : 'en'

  function changeLanguage(language) {
    void i18n.changeLanguage(language)
  }

  return (
    <div className={`language-toggle ${className}`} aria-label={t('language')}>
      <button
        aria-pressed={currentLanguage === 'en'}
        className={currentLanguage === 'en' ? 'is-active' : ''}
        onClick={() => changeLanguage('en')}
        type="button"
      >
        EN
      </button>
      <span aria-hidden="true" />
      <button
        aria-pressed={currentLanguage === 'ta'}
        className={currentLanguage === 'ta' ? 'is-active' : ''}
        onClick={() => changeLanguage('ta')}
        type="button"
      >
        தமிழ்
      </button>
    </div>
  )
}
