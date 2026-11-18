import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { adminApi } from '../../api/adminApi.js'

const summaryCards = [
  { key: 'total_voters', label: 'Total voters' },
  { key: 'entered_voters', label: 'Entered, not voted' },
  { key: 'voted_voters', label: 'Voted' },
  { key: 'not_entered_voters', label: 'Not entered' },
]

function genderLabel(gender) {
  if (gender === 'M') return 'Male'
  if (gender === 'F') return 'Female'
  return gender
}

export default function VoterDashboard() {
  const [selectedElectionId, setSelectedElectionId] = useState('')
  const electionsQuery = useQuery({
    queryKey: ['admin', 'elections'],
    queryFn: adminApi.getElections,
  })
  const elections = electionsQuery.data ?? []

  useEffect(() => {
    if (!elections.length) {
      setSelectedElectionId('')
      return
    }
    if (!elections.some((election) => String(election.id) === selectedElectionId)) {
      setSelectedElectionId(String(elections[0].id))
    }
  }, [elections, selectedElectionId])

  const summaryQuery = useQuery({
    queryKey: ['admin', 'dashboard', 'voter-summary', selectedElectionId],
    queryFn: () => adminApi.getVoterDashboardSummary(selectedElectionId),
    enabled: Boolean(selectedElectionId),
    refetchInterval: 10_000,
  })
  const thokuthiGenderQuery = useQuery({
    queryKey: ['admin', 'dashboard', 'thokuthi-gender', selectedElectionId],
    queryFn: () => adminApi.getThokuthiGenderCounts(selectedElectionId),
    enabled: Boolean(selectedElectionId),
    refetchInterval: 10_000,
  })

  const { genderColumns, thokuthiRows } = useMemo(() => {
    const items = thokuthiGenderQuery.data?.items ?? []
    const codes = [...new Set(items.map((item) => item.gender).filter(Boolean))]
    const columns = [...new Set(['M', 'F', ...codes.filter((code) => code !== 'M' && code !== 'F')])]
    const groups = new Map()

    for (const item of items) {
      const key = item.thokuthi ?? ''
      if (!groups.has(key)) {
        groups.set(key, { thokuthi: key, counts: Object.fromEntries(columns.map((column) => [column, 0])) })
      }
      const gender = item.gender || 'UNSPECIFIED'
      groups.get(key).counts[gender] = item.voter_count
    }

    const rows = [...groups.values()]
      .map((row) => ({ ...row, total: Object.values(row.counts).reduce((sum, count) => sum + count, 0) }))
      .sort((left, right) => {
        if (!left.thokuthi) return 1
        if (!right.thokuthi) return -1
        return left.thokuthi.localeCompare(right.thokuthi)
      })
    return { genderColumns: columns, thokuthiRows: rows }
  }, [thokuthiGenderQuery.data])

  return (
    <section className="voter-dashboard-panel" aria-labelledby="voter-dashboard-title">
      <header className="voter-dashboard-heading">
        <div>
          <p className="eyebrow">VOTER TURNOUT</p>
          <h2 id="voter-dashboard-title">Voter dashboard</h2>
          <p>Voter progress and Thokuthi breakdown for the selected election.</p>
        </div>
        {elections.length ? (
          <label className="form-field voter-dashboard-election" htmlFor="voter-dashboard-election">
            <span>Election</span>
            <select
              id="voter-dashboard-election"
              onChange={(event) => setSelectedElectionId(event.target.value)}
              value={selectedElectionId}
            >
              {elections.map((election) => (
                <option key={election.id} value={String(election.id)}>{election.name}</option>
              ))}
            </select>
          </label>
        ) : null}
      </header>

      {electionsQuery.isPending ? <p role="status">Loading elections…</p> : null}
      {electionsQuery.isError ? <p className="form-error" role="alert">{electionsQuery.error.message}</p> : null}
      {!electionsQuery.isPending && !electionsQuery.isError && !elections.length ? (
        <p className="voter-dashboard-empty">Create an election and import voters to see dashboard totals.</p>
      ) : null}

      {selectedElectionId ? (
        <>
          {summaryQuery.isPending ? <p role="status">Loading voter totals…</p> : null}
          {summaryQuery.isError ? <p className="form-error" role="alert">{summaryQuery.error.message}</p> : null}
          {summaryQuery.data ? (
            <div className="voter-summary-grid">
              {summaryCards.map((card) => (
                <article className="voter-summary-card" key={card.key}>
                  <span>{card.label}</span>
                  <strong>{Number(summaryQuery.data[card.key] ?? 0).toLocaleString()}</strong>
                </article>
              ))}
            </div>
          ) : null}

          <div className="thokuthi-dashboard-section">
            <div className="thokuthi-dashboard-heading">
              <div>
                <h3>Thokuthi by gender</h3>
              </div>
            </div>
            {thokuthiGenderQuery.isPending ? <p role="status">Loading Thokuthi counts…</p> : null}
            {thokuthiGenderQuery.isError ? <p className="form-error" role="alert">{thokuthiGenderQuery.error.message}</p> : null}
            {!thokuthiGenderQuery.isPending && !thokuthiGenderQuery.isError ? (
              thokuthiRows.length ? (
                <div className="thokuthi-dashboard-table-wrap">
                  <table className="thokuthi-dashboard-table">
                    <thead>
                      <tr>
                        <th scope="col">Thokuthi</th>
                        {genderColumns.map((gender) => <th key={gender} scope="col">{genderLabel(gender)}</th>)}
                        <th scope="col">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {thokuthiRows.map((row) => (
                        <tr key={row.thokuthi || 'unspecified'}>
                          <th scope="row">{row.thokuthi || 'Unspecified'}</th>
                          {genderColumns.map((gender) => <td key={gender}>{row.counts[gender].toLocaleString()}</td>)}
                          <td>{row.total.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="voter-dashboard-empty">No voters have been imported for this election.</p>
              )
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  )
}
