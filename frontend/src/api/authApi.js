import { apiRequest } from './apiClient.js'

export const authApi = {
  login(credentials) {
    return apiRequest('/auth/login', {
      method: 'POST',
      body: JSON.stringify(credentials),
    })
  },

  refresh(signal) {
    return apiRequest('/auth/refresh', { method: 'POST', signal })
  },

  logout() {
    return apiRequest('/auth/logout', { method: 'POST' })
  },
}
