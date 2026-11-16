import { apiRequest } from './apiClient.js'

export const monitorApi = {
  getBoard() {
    return apiRequest('/monitor/board')
  },

  getWaiting(search = '') {
    const query = new URLSearchParams()
    if (search.trim()) query.set('search', search.trim())
    const queryString = query.toString()
    return apiRequest(`/monitor/waiting${queryString ? `?${queryString}` : ''}`)
  },

  assignVoter(payload) {
    return apiRequest('/monitor/assign', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },

  resetSystem(systemId) {
    return apiRequest(`/monitor/systems/${systemId}/reset`, { method: 'POST' })
  },
}
