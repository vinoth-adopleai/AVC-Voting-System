import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { adminApi } from '../../api/adminApi.js'

const reportTabs = [
  { key: 'TURNOUT', label: 'Turnout' },
  { key: 'RECONCILIATION', label: 'Reconciliation' },
  { key: 'RESULTS', label: 'Results' },
]

const checkLabels = {
  voted_voters_match_valid_ballots: 'Voters marked VOTED match valid submitted ballots',
  vote_rows_match_ballot_total: 'Submitted vote rows match the configured ballot total',
}

const countCards = [
  { key: 'total_voters', label: 'Total voters' },
  { key: 'entered_voters', label: 'Entered, not voted' },
  { key: 'voted_voters', label: 'Voted' },
  { key: 'not_entered_voters', label: 'Not entered' },
]

function formatCount(value) {
  return Number(value ?? 0).toLocaleString()
}

function formatHour(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function CandidatePortrait({ candidate }) {
  const [hasImageError, setHasImageError] = useState(false)
  if (!candidate.photo_url || hasImageError) {
    const initial = candidate.candidate_ta?.trim().slice(0, 1) || '•'
    return <span className="report-candidate-photo-placeholder" aria-hidden="true">{initial}</span>
  }
  return (
    <img
      alt={`${candidate.candidate_ta} photo`}
      className="report-candidate-photo"
      decoding="async"
      loading="lazy"
      onError={() => setHasImageError(true)}
      src={candidate.photo_url}
    />
  )
}

export default function ReportsWorkspace() {
  const queryClient = useQueryClient()
  const [selectedElectionId, setSelectedElectionId] = useState('')
  const [activeTab, setActiveTab] = useState('TURNOUT')
  const [exportJobId, setExportJobId] = useState('')
  const [downloadError, setDownloadError] = useState('')

  const electionsQuery = useQuery({
    queryKey: ['admin', 'elections'],
    queryFn: adminApi.getElections,
    refetchInterval: 15_000,
  })
  const elections = electionsQuery.data ?? []
  const selectedElection = elections.find((election) => String(election.id) === selectedElectionId) ?? null
  const isClosed = selectedElection?.status === 'CLOSED' || selectedElection?.status === 'PUBLISHED'
  const isOpen = selectedElection?.status === 'OPEN'

  useEffect(() => {
    if (!elections.length) {
      setSelectedElectionId('')
      return
    }
    if (!elections.some((election) => String(election.id) === selectedElectionId)) {
      setSelectedElectionId(String(elections[0].id))
    }
  }, [elections, selectedElectionId])

  useEffect(() => {
    setExportJobId('')
    setDownloadError('')
  }, [selectedElectionId, activeTab])

  const turnoutQuery = useQuery({
    queryKey: ['admin', 'reports', 'turnout', selectedElectionId],
    queryFn: () => adminApi.getTurnoutReport(selectedElectionId),
    enabled: Boolean(selectedElectionId),
    refetchInterval: 15_000,
  })
  const reconciliationQuery = useQuery({
    queryKey: ['admin', 'reports', 'reconciliation', selectedElectionId],
    queryFn: () => adminApi.getReconciliationReport(selectedElectionId),
    enabled: Boolean(selectedElectionId),
    refetchInterval: isClosed ? 15_000 : false,
  })
  const reconciliationPassed = reconciliationQuery.data?.passed === true
  const resultsAvailable = isOpen || (isClosed && reconciliationPassed)
  const resultsQuery = useQuery({
    queryKey: ['admin', 'reports', 'results', selectedElectionId],
    queryFn: () => adminApi.getFinalResults(selectedElectionId),
    enabled: Boolean(selectedElectionId) && resultsAvailable,
    refetchInterval: isOpen ? 5_000 : false,
  })

  const publishMutation = useMutation({
    mutationFn: adminApi.publishResults,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'elections'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'reports', 'reconciliation', selectedElectionId] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'reports', 'results', selectedElectionId] })
    },
  })
  const exportMutation = useMutation({
    mutationFn: adminApi.requestReportExport,
    onSuccess: (job) => {
      setDownloadError('')
      setExportJobId(job.id)
    },
  })
  const exportJobQuery = useQuery({
    queryKey: ['admin', 'reports', 'export', exportJobId],
    queryFn: () => adminApi.getReportExport(exportJobId),
    enabled: Boolean(exportJobId),
    refetchInterval: (query) => ['QUEUED', 'RUNNING'].includes(query.state.data?.status) ? 1_500 : false,
  })

  const hourlyMaximum = useMemo(() => {
    const values = (turnoutQuery.data?.hourly ?? []).flatMap((hour) => [hour.entered, hour.voted])
    return Math.max(1, ...values)
  }, [turnoutQuery.data])
  const resultsPositions = resultsQuery.data?.positions ?? []
  const canExportActiveReport = activeTab === 'TURNOUT'
    || (activeTab === 'RECONCILIATION' && isClosed)
    || (activeTab === 'RESULTS' && resultsAvailable)

  function requestExport(exportFormat) {
    if (!selectedElectionId) return
    const reportType = activeTab === 'RESULTS'
      ? 'FINAL_RESULTS'
      : activeTab
    exportMutation.mutate({
      election_id: Number(selectedElectionId),
      report_type: reportType,
      export_format: exportFormat,
    })
  }

  async function downloadExport() {
    if (!exportJobQuery.data?.id) return
    setDownloadError('')
    try {
      const file = await adminApi.downloadReportExport(exportJobQuery.data.id)
      const url = URL.createObjectURL(file)
      const link = document.createElement('a')
      const extension = exportJobQuery.data.export_format === 'PDF' ? 'pdf' : 'xlsx'
      link.href = url
      link.download = `election-${selectedElectionId}-${exportJobQuery.data.report_type.toLowerCase().replaceAll('_', '-')}.${extension}`
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
    } catch (error) {
      setDownloadError(error.message)
    }
  }

  return (
    <section className="reports-workspace" aria-label="Election reports">
      <header className="reports-toolbar">
        {elections.length ? (
          <label className="form-field reports-election-field" htmlFor="reports-election">
            <span>Election</span>
            <select
              id="reports-election"
              onChange={(event) => setSelectedElectionId(event.target.value)}
              value={selectedElectionId}
            >
              {elections.map((election) => (
                <option key={election.id} value={String(election.id)}>
                  {election.name} · {election.status}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <div className="reports-export-controls" aria-label="Export report">
          <button
            className="button button-secondary"
            disabled={!selectedElectionId || exportMutation.isPending || !canExportActiveReport}
            onClick={() => requestExport('PDF')}
            type="button"
          >
            Export PDF
          </button>
          <button
            className="button button-secondary"
            disabled={!selectedElectionId || exportMutation.isPending || !canExportActiveReport}
            onClick={() => requestExport('XLSX')}
            type="button"
          >
            Export Excel
          </button>
        </div>
      </header>

      {electionsQuery.isPending ? <p role="status">Loading elections…</p> : null}
      {electionsQuery.isError ? <p className="form-error" role="alert">{electionsQuery.error.message}</p> : null}
      {!electionsQuery.isPending && !electionsQuery.isError && !elections.length ? (
        <p className="reports-empty">Create an election before generating reports.</p>
      ) : null}

      {selectedElection ? (
        <>
          <nav className="reports-tabs" aria-label="Report type">
            {reportTabs.map((tab) => (
              <button
                aria-current={activeTab === tab.key ? 'page' : undefined}
                className={`reports-tab ${activeTab === tab.key ? 'is-active' : ''}`}
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                type="button"
              >
                {tab.label}
              </button>
            ))}
          </nav>

          {(exportMutation.isError || downloadError) ? (
            <p className="form-error" role="alert">{downloadError || exportMutation.error.message}</p>
          ) : null}
          {exportJobQuery.data ? (
            <div className="report-export-status" role="status" aria-live="polite">
              <span>{exportJobQuery.data.status === 'READY' ? 'Export is ready.' : exportJobQuery.data.status === 'FAILED' ? exportJobQuery.data.error_message : 'Preparing export…'}</span>
              {exportJobQuery.data.status === 'READY' ? (
                <button className="button button-secondary" onClick={downloadExport} type="button">Download</button>
              ) : null}
            </div>
          ) : null}

          {activeTab === 'TURNOUT' ? (
            <section className="report-view" aria-labelledby="turnout-report-title">
              <div className="report-section-heading">
                <div>
                  <p className="eyebrow">LIVE REPORT</p>
                  <h2 id="turnout-report-title">Turnout</h2>
                  <p>Voter progress for {selectedElection.name}.</p>
                </div>
                <span className="report-updated-at">
                  {turnoutQuery.data?.election_status === 'OPEN' ? 'Updates every 15 seconds' : selectedElection.status}
                </span>
              </div>
              {turnoutQuery.isPending ? <p role="status">Loading turnout…</p> : null}
              {turnoutQuery.isError ? <p className="form-error" role="alert">{turnoutQuery.error.message}</p> : null}
              {turnoutQuery.data ? (
                <>
                  <div className="voter-summary-grid">
                    {countCards.map((card) => (
                      <article className="voter-summary-card" key={card.key}>
                        <span>{card.label}</span>
                        <strong>{formatCount(turnoutQuery.data.summary[card.key])}</strong>
                      </article>
                    ))}
                  </div>
                  <section className="report-chart-section" aria-labelledby="turnout-hourly-title">
                    <div className="report-section-heading report-chart-heading">
                      <div>
                        <h3 id="turnout-hourly-title">Entries and votes by hour</h3>
                        <p>Counts are grouped by each voter’s current entry and vote timestamps.</p>
                      </div>
                      <div className="report-chart-legend">
                        <span><i className="is-entry" />Entered</span>
                        <span><i className="is-voted" />Voted</span>
                      </div>
                    </div>
                    {turnoutQuery.data.hourly.length ? (
                      <div className="report-hourly-chart">
                        {turnoutQuery.data.hourly.map((hour) => (
                          <div className="report-hour-column" key={hour.hour}>
                            <div className="report-hour-bars" title={`Entered ${hour.entered}; voted ${hour.voted}`}>
                              <span className="is-entry" style={{ height: `${Math.max(hour.entered ? 4 : 0, (hour.entered / hourlyMaximum) * 100)}%` }} />
                              <span className="is-voted" style={{ height: `${Math.max(hour.voted ? 4 : 0, (hour.voted / hourlyMaximum) * 100)}%` }} />
                            </div>
                            <small>{formatHour(hour.hour)}</small>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="reports-empty">No entry or vote activity has been recorded.</p>
                    )}
                  </section>
                </>
              ) : null}
            </section>
          ) : null}

          {activeTab === 'RECONCILIATION' ? (
            <section className="report-view" aria-labelledby="reconciliation-title">
              <div className="report-section-heading">
                <div>
                  <p className="eyebrow">FINAL CHECKS</p>
                  <h2 id="reconciliation-title">Reconciliation</h2>
                  <p>Results remain locked until the election is closed and these checks pass.</p>
                </div>
              </div>
              {reconciliationQuery.isPending ? <p role="status">Checking ballots and vote records…</p> : null}
              {reconciliationQuery.isError ? <p className="form-error" role="alert">{reconciliationQuery.error.message}</p> : null}
              {reconciliationQuery.data ? (
                <>
                  <div className="reconciliation-metrics">
                    <div><span>Voters marked VOTED</span><strong>{formatCount(reconciliationQuery.data.voted_voters)}</strong></div>
                    <div><span>Valid ballots</span><strong>{formatCount(reconciliationQuery.data.valid_ballots)}</strong></div>
                    <div><span>Submitted vote rows</span><strong>{formatCount(reconciliationQuery.data.submitted_votes)}</strong></div>
                    <div><span>Expected vote rows</span><strong>{formatCount(reconciliationQuery.data.expected_votes)}</strong></div>
                  </div>
                  <ul className="reconciliation-check-list">
                    {Object.entries(reconciliationQuery.data.checks).map(([key, passed]) => (
                      <li className={passed ? 'is-passed' : 'is-failed'} key={key}>
                        <span aria-hidden="true">{passed ? '✓' : '!'}</span>
                        <strong>{checkLabels[key]}</strong>
                        <small>{passed ? 'Passed' : 'Needs review'}</small>
                      </li>
                    ))}
                  </ul>
                  {!reconciliationQuery.data.is_closed ? (
                    <p className="report-lock-message">Close the election to complete final reconciliation.</p>
                  ) : reconciliationQuery.data.ready_to_publish ? (
                    <p className="report-success-message" role="status">All reconciliation checks passed. Final results are available.</p>
                  ) : (
                    <p className="form-error" role="alert">Reconciliation did not pass. Review the counts before releasing results.</p>
                  )}
                </>
              ) : null}
            </section>
          ) : null}

          {activeTab === 'RESULTS' ? (
            <section className="report-view" aria-labelledby="final-results-title">
              <div className="report-section-heading">
                <div>
                  <p className="eyebrow">{isOpen ? 'LIVE RESULTS' : 'CLOSED ELECTION'}</p>
                  <h2 id="final-results-title">{isOpen ? 'Live results' : 'Final results'}</h2>
                  <p>{isOpen
                    ? 'Provisional totals from submitted ballots. Results refresh automatically while the election is open.'
                    : 'Candidate totals include valid submitted ballots only.'}</p>
                </div>
                {isOpen ? <span className="report-live-badge"><i aria-hidden="true" />LIVE | Refreshes every 5 seconds</span> : null}
                {selectedElection.status === 'CLOSED' && reconciliationPassed ? (
                  <button
                    className="button button-primary"
                    disabled={publishMutation.isPending}
                    onClick={() => {
                      if (window.confirm('Publish the reconciled election results?')) {
                        publishMutation.mutate(Number(selectedElectionId))
                      }
                    }}
                    type="button"
                  >
                    {publishMutation.isPending ? 'Publishing…' : 'Publish results'}
                  </button>
                ) : null}
              </div>
              {publishMutation.isError ? <p className="form-error" role="alert">{publishMutation.error.message}</p> : null}
              {selectedElection.status === 'DRAFT' ? <p className="report-lock-message">Results will appear after the election opens.</p> : null}
              {isClosed && reconciliationQuery.isPending ? <p role="status">Checking reconciliation before showing results…</p> : null}
              {isClosed && reconciliationQuery.data && !reconciliationPassed ? (
                <p className="report-lock-message">Final results are hidden until reconciliation passes. Review the Reconciliation tab.</p>
              ) : null}
              {resultsAvailable && resultsQuery.isPending ? <p role="status">Loading results…</p> : null}
              {resultsAvailable && resultsQuery.isError ? <p className="form-error" role="alert">{resultsQuery.error.message}</p> : null}
              {resultsAvailable && resultsQuery.data ? (
                resultsPositions.length ? (
                  <div className="final-results-list">
                    {resultsPositions.map((position) => (
                      <section className="final-results-position" key={position.position_id}>
                        <header>
                          <span className="results-position-order">{String(position.display_order).padStart(2, '0')}</span>
                          <div><strong>{position.position_name_ta}</strong><small>{position.position_name}</small></div>
                        </header>
                        <div className="report-table-wrap">
                          <table className="report-table">
                            <thead><tr><th>Order</th><th>Candidate</th><th>Votes</th></tr></thead>
                            <tbody>
                              {position.candidates.length ? position.candidates.map((candidate, index) => (
                                <tr key={candidate.candidate_id}>
                                  <td>{index + 1}</td>
                                  <td className="report-candidate-cell">
                                    <CandidatePortrait candidate={candidate} />
                                    <span><strong>{candidate.candidate_ta}</strong>{candidate.candidate_en ? <small>{candidate.candidate_en}</small> : null}</span>
                                  </td>
                                  <td>{formatCount(candidate.vote_count)}</td>
                                </tr>
                              )) : <tr><td className="report-no-candidates" colSpan="3">No candidates are configured for this position.</td></tr>}
                            </tbody>
                          </table>
                        </div>
                      </section>
                    ))}
                  </div>
                ) : (
                  <p className="reports-empty">No candidate results are available for this election.</p>
                )
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
