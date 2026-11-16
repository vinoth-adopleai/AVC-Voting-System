const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')

async function boothRequest(path, deviceToken, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${deviceToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = payload?.detail
    const error = new Error(detail?.message || 'The voting terminal request could not be completed.')
    error.code = detail?.code
    error.status = response.status
    throw error
  }
  return payload
}

export const boothApi = {
  getSession(deviceToken) {
    return boothRequest('/booth/session', deviceToken)
  },

  submitBallot(deviceToken, payload) {
    return boothRequest('/booth/ballot', deviceToken, {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },
}
