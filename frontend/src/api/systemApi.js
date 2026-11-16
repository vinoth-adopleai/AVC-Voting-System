import { apiRequest } from './apiClient.js'

export const systemApi = {
  health() {
    return apiRequest('/healthz')
  },
}
