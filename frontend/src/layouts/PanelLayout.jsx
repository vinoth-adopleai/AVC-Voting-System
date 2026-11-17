import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router'

import { authApi } from '../api/authApi.js'
import { monitorApi } from '../api/monitorApi.js'
import LanguageToggle from '../components/ui/LanguageToggle.jsx'
import { getRoleLabel } from '../app/roles.js'
import { useAuthStore } from '../stores/authStore.js'
import { useUiStore } from '../stores/uiStore.js'

const adminNavigation = [
  { key: 'dashboard', path: '/admin', end: true, icon: '◫' },
  { key: 'election', path: '/admin/election', icon: '◷' },
  { key: 'positions', path: '/admin/positions', icon: '▤' },
  { key: 'candidates', path: '/admin/candidates', icon: '♙' },
  { key: 'voters', path: '/admin/voters', icon: '♧' },
  { key: 'staff', path: '/admin/staff', icon: '♙' },
  { key: 'systems', path: '/admin/systems', icon: '▦' },
  { key: 'exceptions', path: '/admin/exceptions', icon: '⚑' },
  { key: 'reports', path: '/admin/reports', icon: '▥' },
  { key: 'audit', path: '/admin/audit', icon: '⌕' },
]

const navigationByRole = {
  ADMIN: adminNavigation,
  GATE1_OFFICER: [{ key: 'entry', path: '/entry', end: true, icon: '↳' }],
  ENTRY_OFFICER: [{ key: 'entry', path: '/entry', end: true, icon: '↳' }],
  MONITOR_OFFICER: [{ key: 'monitor', path: '/monitor', end: true, icon: '▦' }],
  MONITOR_SUPERVISOR: [{ key: 'monitor', path: '/monitor', end: true, icon: '▦' }],
  AUDITOR: [
    { key: 'reports', path: '/auditor', end: true, icon: '▥' },
    { key: 'lookups', path: '/auditor/lookups', icon: '⌕' },
  ],
}

navigationByRole.MONITOR_OFFICER.push({ key: 'waiting', path: '/monitor/waiting', end: true, icon: '☷' })
navigationByRole.MONITOR_SUPERVISOR.push({ key: 'waiting', path: '/monitor/waiting', end: true, icon: '☷' })

function initials(user) {
  const name = user?.display_name ?? user?.name ?? user?.username ?? 'Staff'
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
}

export default function PanelLayout() {
  const { t } = useTranslation()
  const location = useLocation()
  const navigate = useNavigate()
  const user = useAuthStore((state) => state.user)
  const clearSession = useAuthStore((state) => state.clearSession)
  const isNavigationOpen = useUiStore((state) => state.isNavigationOpen)
  const closeNavigation = useUiStore((state) => state.closeNavigation)
  const navigation = navigationByRole[user?.role] ?? []
  const activeItem = useMemo(
    () =>
      [...navigation]
        .sort((a, b) => b.path.length - a.path.length)
        .find((item) =>
          item.end
            ? location.pathname === item.path
            : location.pathname.startsWith(item.path),
        ),
    [location.pathname, navigation],
  )
  const displayName = user?.display_name ?? user?.name ?? user?.username ?? 'Staff'
  const isBoothStaff = user?.role === 'MONITOR_OFFICER' || user?.role === 'MONITOR_SUPERVISOR'
  const boardQuery = useQuery({
    queryKey: ['monitor', 'board'],
    queryFn: monitorApi.getBoard,
    enabled: isBoothStaff,
  })
  const boothLabel = boardQuery.data?.booths
    ?.map((booth) => `${t('monitor.booth')} ${booth.booth_no}`)
    .join(', ')

  async function handleSignOut() {
    try {
      await authApi.logout()
    } catch {
      // Clear the local session even if the API is unavailable.
    } finally {
      clearSession()
      closeNavigation()
      navigate('/login', { replace: true })
    }
  }

  return (
    <div className="staff-app-shell">
      {isNavigationOpen ? (
        <button
          className="mobile-nav-backdrop"
          aria-label={t('actions.closeNavigation')}
          onClick={closeNavigation}
          type="button"
        />
      ) : null}
      <aside className={`staff-sidebar ${isNavigationOpen ? 'is-open' : ''}`}>
        <Link className="brand-lockup sidebar-brand" to={navigation[0]?.path ?? '/'}>
          <span className="brand-mark" aria-hidden="true">
            <span />
          </span>
          <span className="brand-copy">
            <strong>{t('appName')}</strong>
            <small>{t('appDescriptor')}</small>
          </span>
        </Link>

        <div className="sidebar-context">
          <span className="sidebar-context-label">{t('roleWorkspace', { role: getRoleLabel(user?.role) })}</span>
          {boothLabel || user?.desk_name ? <strong>{boothLabel || user.desk_name}</strong> : null}
        </div>

        <nav className="sidebar-navigation" aria-label="Main navigation">
          <p className="nav-section-label">Workspace</p>
          {navigation.map((item) => (
            <NavLink
              key={item.path}
              className={({ isActive }) =>
                `nav-link ${isActive ? 'is-active' : ''}`
              }
              end={item.end}
              onClick={closeNavigation}
              to={item.path}
            >
              <span className="nav-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span>{t(`navigation.${item.key}`)}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="sidebar-profile">
            <span className="profile-avatar">{initials(user)}</span>
            <span className="profile-copy">
              <strong>{displayName}</strong>
              <small>{getRoleLabel(user?.role)}</small>
            </span>
            <button
              className="icon-button signout-icon"
              aria-label={t('signOut')}
              onClick={handleSignOut}
              title={t('signOut')}
              type="button"
            >
              <span aria-hidden="true">↗</span>
            </button>
          </div>
        </div>
      </aside>

      <div className="staff-main-column">
        <header className="staff-topbar">
          <button
            className="icon-button mobile-menu-button"
            aria-label={t('actions.openNavigation')}
            onClick={() => useUiStore.getState().toggleNavigation()}
            type="button"
          >
            <span aria-hidden="true">☰</span>
          </button>
          <div className="breadcrumb">
            <span>AVC Election</span>
            <span aria-hidden="true">/</span>
            <strong>{activeItem ? t(`navigation.${activeItem.key}`) : getRoleLabel(user?.role)}</strong>
          </div>
          <div className="topbar-actions">
            <LanguageToggle className="topbar-language" />
          </div>
        </header>
        <main className="staff-page-content">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
