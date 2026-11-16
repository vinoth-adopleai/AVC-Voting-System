import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import LanguageToggle from '../components/ui/LanguageToggle.jsx'

export default function AuthLayout({ children }) {
  const { t } = useTranslation()

  return (
    <main className="auth-page">
      <div className="auth-page-glow auth-page-glow--top" aria-hidden="true" />
      <div className="auth-page-glow auth-page-glow--bottom" aria-hidden="true" />
      <header className="auth-topbar">
        <Link className="brand-lockup" to="/login" aria-label={t('appName')}>
          <span className="brand-mark" aria-hidden="true">
            <span />
          </span>
          <span className="brand-copy">
            <strong>{t('appName')}</strong>
            <small>{t('appDescriptor')}</small>
          </span>
        </Link>
        <LanguageToggle />
      </header>
      <div className="auth-content">{children}</div>
      <footer className="auth-footer">
        <span>AVC Election System</span>
        <span className="footer-separator" aria-hidden="true" />
        <span>Secure staff access</span>
      </footer>
    </main>
  )
}
