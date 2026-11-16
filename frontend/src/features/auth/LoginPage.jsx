import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'

import { ApiError } from '../../api/apiClient.js'
import { authApi } from '../../api/authApi.js'
import AuthLayout from '../../layouts/AuthLayout.jsx'
import { getHomePath } from '../../app/roles.js'
import { useAuthStore } from '../../stores/authStore.js'

export default function LoginPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const setSession = useAuthStore((state) => state.setSession)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const loginMutation = useMutation({
    mutationFn: async (credentials) => {
      const session = await authApi.login(credentials)
      if (!session?.access_token || !session?.user?.role) {
        throw new ApiError(
          'The sign-in response is missing the access token or staff role.',
          502,
          'INVALID_AUTH_RESPONSE',
        )
      }
      return session
    },
    onSuccess: (session) => {
      setSession({ accessToken: session.access_token, user: session.user })
      navigate(getHomePath(session.user.role), { replace: true })
    },
  })

  function handleSubmit(event) {
    event.preventDefault()
    loginMutation.mutate({ username: username.trim(), password })
  }

  return (
    <AuthLayout>
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-card-heading">
          <span className="login-kicker">STAFF PORTAL</span>
          <h1 id="login-title">{t('signInTitle')}</h1>
          <p>{t('signInDescription')}</p>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          <label className="form-field" htmlFor="username">
            <span>{t('username')}</span>
            <input
              autoComplete="username"
              autoFocus
              id="username"
              name="username"
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Enter your username"
              required
              value={username}
            />
          </label>
          <label className="form-field" htmlFor="password">
            <span>{t('password')}</span>
            <input
              autoComplete="current-password"
              id="password"
              name="password"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter your password"
              required
              type="password"
              value={password}
            />
          </label>

          {loginMutation.isError ? (
            <p className="form-error" role="alert">
              <span aria-hidden="true">!</span>
              {loginMutation.error.message || t('loginError')}
            </p>
          ) : null}

          <button
            className="button button-primary login-submit"
            disabled={loginMutation.isPending}
            type="submit"
          >
            {loginMutation.isPending ? t('signingIn') : t('signIn')}
            <span aria-hidden="true">→</span>
          </button>
        </form>
        <div className="login-security-note">
          <span className="security-icon" aria-hidden="true">⌑</span>
          <span>Access is limited to authorized election staff.</span>
        </div>
      </section>
    </AuthLayout>
  )
}
