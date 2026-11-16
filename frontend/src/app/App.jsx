import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Suspense, lazy, useEffect } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router'

import { authApi } from '../api/authApi.js'
import { useAuthStore } from '../stores/authStore.js'
import { getHomePath } from './roles.js'

const LoginPage = lazy(() => import('../features/auth/LoginPage.jsx'))
const PanelLayout = lazy(() => import('../layouts/PanelLayout.jsx'))
const AdminHome = lazy(() => import('../features/admin/AdminHome.jsx'))
const AdminSection = lazy(() => import('../features/admin/AdminSection.jsx'))
const EntryHome = lazy(() => import('../features/entry/EntryHome.jsx'))
const MonitorHome = lazy(() => import('../features/monitor/MonitorHome.jsx'))
const AuditorHome = lazy(() => import('../features/auditor/AuditorHome.jsx'))
const AuditorLookups = lazy(() => import('../features/auditor/AuditorLookups.jsx'))
const BoothHome = lazy(() => import('../features/booth/BoothHome.jsx'))
let sessionBootstrapPromise

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 15_000,
    },
    mutations: {
      retry: 0,
    },
  },
})

function RouteLoading() {
  return (
    <div className="route-loading" role="status" aria-live="polite">
      <span className="loading-mark" aria-hidden="true" />
      <span>Loading workspace…</span>
    </div>
  )
}

function RequireAuth({ allowedRoles }) {
  const user = useAuthStore((state) => state.user)

  if (!user) {
    return <Navigate to="/login" replace />
  }

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return <Navigate to={getHomePath(user.role)} replace />
  }

  return <Outlet />
}

function HomeRedirect() {
  const user = useAuthStore((state) => state.user)
  return <Navigate to={user ? getHomePath(user.role) : '/login'} replace />
}

function AppRoutes() {
  return (
    <Suspense fallback={<RouteLoading />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth allowedRoles={['ADMIN']} />}>
          <Route path="/admin" element={<PanelLayout />}>
            <Route index element={<AdminHome />} />
            <Route path=":section" element={<AdminSection />} />
          </Route>
        </Route>
        <Route element={<RequireAuth allowedRoles={['GATE1_OFFICER', 'ENTRY_OFFICER']} />}>
          <Route path="/entry" element={<PanelLayout />}>
            <Route index element={<EntryHome />} />
          </Route>
        </Route>
        <Route element={<RequireAuth allowedRoles={['MONITOR_OFFICER', 'MONITOR_SUPERVISOR']} />}>
          <Route path="/monitor" element={<PanelLayout />}>
            <Route index element={<MonitorHome />} />
          </Route>
        </Route>
        <Route element={<RequireAuth allowedRoles={['AUDITOR']} />}>
          <Route path="/auditor" element={<PanelLayout />}>
            <Route index element={<AuditorHome />} />
            <Route path="lookups" element={<AuditorLookups />} />
          </Route>
        </Route>
        <Route path="/booth" element={<BoothHome />} />
        <Route path="/" element={<HomeRedirect />} />
        <Route path="*" element={<HomeRedirect />} />
      </Routes>
    </Suspense>
  )
}

export default function App() {
  const isSessionResolved = useAuthStore((state) => state.isSessionResolved)
  const setSession = useAuthStore((state) => state.setSession)
  const clearSession = useAuthStore((state) => state.clearSession)

  useEffect(() => {
    if (!sessionBootstrapPromise) {
      const controller = new AbortController()
      const timeoutId = window.setTimeout(() => controller.abort(), 5_000)
      sessionBootstrapPromise = authApi
        .refresh(controller.signal)
        .then((session) => {
          if (session?.access_token && session?.user?.role) {
            setSession({ accessToken: session.access_token, user: session.user })
          } else {
            clearSession()
          }
        })
        .catch(() => clearSession())
        .finally(() => window.clearTimeout(timeoutId))
    }
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        {isSessionResolved ? <AppRoutes /> : <RouteLoading />}
      </BrowserRouter>
    </QueryClientProvider>
  )
}
