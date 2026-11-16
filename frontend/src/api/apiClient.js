import { useAuthStore } from '../stores/authStore.js'

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(message, status, code, detail = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

export async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers)
  const token = useAuthStore.getState().accessToken

  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  if (options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
    credentials: 'include',
  })
  const contentType = response.headers.get('content-type') ?? ''
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text()

  if (!response.ok) {
    const detail = payload?.detail
    const validationMessage = Array.isArray(detail)
      ? detail.map((item) => {
        const field = Array.isArray(item.loc)
          ? item.loc.filter((part) => part !== 'body').join('.')
          : ''
        return `${field ? `${field}: ` : ''}${item.msg ?? 'Invalid value'}`
      }).join('; ')
      : ''
    const message = typeof detail === 'string'
      ? detail
      : detail?.message ?? validationMessage ?? payload?.message ?? 'The request could not be completed.'
    throw new ApiError(message, response.status, detail?.code, detail)
  }

  return payload
}
