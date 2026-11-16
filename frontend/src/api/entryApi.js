import { apiRequest } from './apiClient.js'

export const entryApi = {
  findVoter(serial) {
    return apiRequest(`/entry/voters?serial=${encodeURIComponent(serial)}`)
  },

  markEntered(voterId) {
    return apiRequest('/entry/enter', {
      method: 'POST',
      body: JSON.stringify({ voter_id: voterId }),
    })
  },

  undoEntry(voterId) {
    return apiRequest('/entry/undo', {
      method: 'POST',
      body: JSON.stringify({ voter_id: voterId }),
    })
  },

  getMyLog(page, pageSize) {
    const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) })
    return apiRequest(`/entry/my-log?${query}`)
  },
}
