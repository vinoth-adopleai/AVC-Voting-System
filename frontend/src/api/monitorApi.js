import { apiRequest } from './apiClient.js'

export const monitorApi = {
  getBoard() {
    return apiRequest('/monitor/board')
  },

  getWaiting(search = '', page = 1, pageSize = 6) {
    const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) })
    if (search.trim()) query.set('search', search.trim())
    const queryString = query.toString()
    return apiRequest(`/monitor/waiting${queryString ? `?${queryString}` : ''}`)
  },

  findVoter(serial) {
    return apiRequest(`/monitor/voters?serial=${encodeURIComponent(serial)}`)
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
