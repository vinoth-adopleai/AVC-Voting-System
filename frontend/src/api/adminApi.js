import { apiRequest } from './apiClient.js'

export const adminApi = {
  getElection(electionId) {
    const query = electionId ? `?election_id=${encodeURIComponent(electionId)}` : ''
    return apiRequest(`/admin/election${query}`)
  },

  getElectionReadiness(electionId) {
    const query = electionId ? `?election_id=${encodeURIComponent(electionId)}` : ''
    return apiRequest(`/admin/election/readiness${query}`)
  },

  openElection(payload) {
    return apiRequest('/admin/election/open', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },

  stopElection(electionId) {
    return apiRequest('/admin/election/close', {
      method: 'POST',
      body: JSON.stringify({ election_id: electionId }),
    })
  },

  saveElection(payload) {
    return apiRequest('/admin/election', {
      method: 'PUT',
      body: JSON.stringify(payload),
    })
  },

  getElections() {
    return apiRequest('/admin/elections')
  },

  getPositions(electionId) {
    return apiRequest(`/admin/positions?election_id=${encodeURIComponent(electionId)}`)
  },

  addPosition(payload) {
    return apiRequest('/admin/positions', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },

  updatePosition(positionId, payload) {
    return apiRequest(`/admin/positions/${positionId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    })
  },

  getCandidates(positionId) {
    return apiRequest(`/admin/candidates?position_id=${encodeURIComponent(positionId)}`)
  },

  addCandidate(formData) {
    return apiRequest('/admin/candidates', {
      method: 'POST',
      body: formData,
    })
  },

  updateCandidate(candidateId, formData) {
    return apiRequest(`/admin/candidates/${candidateId}`, {
      method: 'PUT',
      body: formData,
    })
  },

  setCandidateActive(candidateId, isActive) {
    return apiRequest(`/admin/candidates/${candidateId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ is_active: isActive }),
    })
  },

  previewVoterImport(formData) {
    return apiRequest('/admin/voters/import/preview', {
      method: 'POST',
      body: formData,
    })
  },

  importVoters(formData) {
    return apiRequest('/admin/voters/import', {
      method: 'POST',
      body: formData,
    })
  },

  getVoters(electionId, page = 1, pageSize = 50) {
    const query = new URLSearchParams({
      election_id: electionId,
      page: String(page),
      page_size: String(pageSize),
    })
    return apiRequest(`/admin/voters?${query.toString()}`)
  },

  getVoterDashboardSummary(electionId) {
    return apiRequest(`/admin/dashboard/voters/summary?election_id=${encodeURIComponent(electionId)}`)
  },

  getThokuthiGenderCounts(electionId) {
    return apiRequest(`/admin/dashboard/voters/thokuthi-gender?election_id=${encodeURIComponent(electionId)}`)
  },

  getTurnoutReport(electionId) {
    return apiRequest(`/admin/reports/turnout?election_id=${encodeURIComponent(electionId)}`)
  },

  getReconciliationReport(electionId) {
    return apiRequest(`/admin/reports/reconciliation?election_id=${encodeURIComponent(electionId)}`)
  },

  getFinalResults(electionId) {
    return apiRequest(`/admin/reports/results?election_id=${encodeURIComponent(electionId)}`)
  },

  publishResults(electionId) {
    return apiRequest('/admin/reports/publish', {
      method: 'POST',
      body: JSON.stringify({ election_id: electionId }),
    })
  },

  requestReportExport(payload) {
    return apiRequest('/admin/reports/exports', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },

  getReportExport(jobId) {
    return apiRequest(`/admin/reports/exports/${encodeURIComponent(jobId)}`)
  },

  downloadReportExport(jobId) {
    return apiRequest(`/admin/reports/exports/${encodeURIComponent(jobId)}/download`, {
      responseType: 'blob',
    })
  },

  getStaff() {
    return apiRequest('/admin/staff')
  },

  createStaff(payload) {
    return apiRequest('/admin/staff', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },

  setStaffActive(staffId, isActive) {
    return apiRequest(`/admin/staff/${staffId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ is_active: isActive }),
    })
  },

  getDesksAndSystems(electionId) {
    return apiRequest(`/admin/systems?election_id=${encodeURIComponent(electionId)}`)
  },

  createMonitorDesks(payload) {
    return apiRequest('/admin/monitor-desks', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },

  assignMonitorDesk(deskId, payload) {
    return apiRequest(`/admin/monitor-desks/${deskId}/assignment`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    })
  },

  createVotingSystems(payload) {
    return apiRequest('/admin/voting-systems', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },

  getVotingSystemToken(systemId) {
    return apiRequest(`/admin/voting-systems/${systemId}/token`, { method: 'POST' })
  },

  exportVotingSystemTokens(electionId) {
    return apiRequest('/admin/voting-system-tokens/export', {
      method: 'POST',
      body: JSON.stringify({ election_id: Number(electionId) }),
    })
  },

  setVotingSystemActive(systemId, isActive) {
    return apiRequest(`/admin/voting-systems/${systemId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ is_active: isActive }),
    })
  },
}
