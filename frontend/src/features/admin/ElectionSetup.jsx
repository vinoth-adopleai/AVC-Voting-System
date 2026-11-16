import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'

import { adminApi } from '../../api/adminApi.js'
import StatusBadge from '../../components/ui/StatusBadge.jsx'

function formatTimestamp(value) {
  if (!value) return 'Not recorded'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Not recorded'
    : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  const clock = [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':')
  return `${days ? `${days}d ` : ''}${clock}`
}

function electionTimer(election, now) {
  if (!election.start_time) return 'Not started'
  const startedAt = new Date(election.start_time).getTime()
  if (Number.isNaN(startedAt)) return 'Not recorded'
  const stoppedAt = election.end_time ? new Date(election.end_time).getTime() : now
  const duration = formatDuration(stoppedAt - startedAt)
  return election.status === 'OPEN' ? `Elapsed ${duration}` : `Duration ${duration}`
}

export default function ElectionSetup() {
  const queryClient = useQueryClient()
  const [selectedElectionId, setSelectedElectionId] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [name, setName] = useState('')
  const [electionDate, setElectionDate] = useState('')
  const [serversConfirmed, setServersConfirmed] = useState(false)
  const [clockNow, setClockNow] = useState(Date.now())

  const electionsQuery = useQuery({
    queryKey: ['admin', 'elections'],
    queryFn: adminApi.getElections,
  })
  const elections = electionsQuery.data ?? []
  const selectedElection = useMemo(
    () => elections.find((item) => String(item.id) === selectedElectionId) ?? null,
    [elections, selectedElectionId],
  )
  const election = isCreating ? null : selectedElection

  useEffect(() => {
    if (!selectedElectionId && elections.length) {
      setSelectedElectionId(String(elections[0].id))
    }
  }, [elections, selectedElectionId])

  useEffect(() => {
    if (isCreating || !selectedElection) {
      setName('')
      setElectionDate('')
      return
    }
    setName(selectedElection.name ?? '')
    setElectionDate(selectedElection.election_date ?? '')
  }, [isCreating, selectedElection])

  useEffect(() => {
    if (election?.status !== 'OPEN' || !election.start_time) return undefined
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [election?.id, election?.start_time, election?.status])

  const saveMutation = useMutation({
    mutationFn: adminApi.saveElection,
    onSuccess: (savedElection) => {
      queryClient.setQueryData(['admin', 'elections'], (current = []) => [
        savedElection,
        ...current.filter((item) => item.id !== savedElection.id),
      ])
      setSelectedElectionId(String(savedElection.id))
      setIsCreating(false)
      queryClient.invalidateQueries({ queryKey: ['admin', 'election', 'readiness'] })
    },
  })

  const readinessQuery = useQuery({
    queryKey: ['admin', 'election', 'readiness', election?.id],
    queryFn: () => adminApi.getElectionReadiness(election.id),
    enabled: election?.status === 'DRAFT',
  })

  const openMutation = useMutation({
    mutationFn: adminApi.openElection,
    onSuccess: (openedElection) => {
      queryClient.setQueryData(['admin', 'elections'], (current = []) => [
        openedElection,
        ...current.filter((item) => item.id !== openedElection.id),
      ])
      queryClient.invalidateQueries({ queryKey: ['admin', 'election', 'readiness'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'positions'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'systems'] })
      setServersConfirmed(false)
    },
    onError: () => queryClient.invalidateQueries({ queryKey: ['admin', 'election', 'readiness'] }),
  })

  const stopMutation = useMutation({
    mutationFn: adminApi.stopElection,
    onSuccess: (stoppedElection) => {
      queryClient.setQueryData(['admin', 'elections'], (current = []) => [
        stoppedElection,
        ...current.filter((item) => item.id !== stoppedElection.id),
      ])
      queryClient.invalidateQueries({ queryKey: ['admin', 'election', 'readiness'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'positions'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'systems'] })
    },
  })

  if (electionsQuery.isPending) {
    return <section className="election-setup-card" role="status">Loading elections…</section>
  }

  if (electionsQuery.isError) {
    return (
      <section className="election-setup-card">
        <p className="form-error" role="alert">{electionsQuery.error.message}</p>
        <button className="button button-primary" onClick={() => electionsQuery.refetch()} type="button">Retry</button>
      </section>
    )
  }

  function handleSubmit(event) {
    event.preventDefault()
    saveMutation.mutate({
      ...(isCreating ? {} : { election_id: election.id }),
      name: name.trim(),
      election_date: electionDate,
    })
  }

  function beginCreate() {
    setIsCreating(true)
    setServersConfirmed(false)
    saveMutation.reset()
  }

  function cancelCreate() {
    setIsCreating(false)
    saveMutation.reset()
  }

  const readiness = readinessQuery.data
  const readinessChecks = readiness?.checks
  const hasUnsavedChanges = Boolean(election) && (
    name.trim() !== election.name
    || electionDate !== election.election_date
  )
  const isLocked = election && election.status !== 'DRAFT'
  const checkLabels = {
    positions: 'Positions and vote limits are configured',
    candidates: 'Every position has an active candidate',
    voters: 'Voters have been imported',
    entry_officers: 'At least one active entry officer is available',
    systems: 'At least one active voting system is registered',
    booth_officers: 'Every booth has an active booth officer',
    system_booth_officers: 'Every active system is assigned to a booth with an active officer',
    servers: 'At least two API servers are healthy',
    single_open_election: 'No other election is open',
  }

  return (
    <section className="election-setup-card" aria-labelledby="election-details-title">
      <div className="election-setup-heading">
        <div>
          <p className="eyebrow">ELECTION DETAILS</p>
          <h2 id="election-details-title">{election?.name ?? (isCreating ? 'Create election' : 'Configure an election')}</h2>
        </div>
        {election ? (
          <StatusBadge tone={election.status === 'DRAFT' ? 'warning' : election.status === 'CLOSED' ? 'neutral' : 'success'}>
            {election.status}
          </StatusBadge>
        ) : null}
      </div>

      <div className="election-picker-row">
        <label className="form-field" htmlFor="election-picker">
          <span>Choose election</span>
          <select
            className="election-picker-select"
            disabled={isCreating || elections.length === 0}
            id="election-picker"
            onChange={(event) => setSelectedElectionId(event.target.value)}
            value={selectedElectionId}
          >
            {elections.length === 0 ? <option value="">No elections created</option> : null}
            {elections.map((item) => (
              <option key={item.id} value={String(item.id)}>
                {item.name} · {item.status}
              </option>
            ))}
          </select>
        </label>
        {!isCreating ? (
          <button className="button button-secondary" onClick={beginCreate} type="button">Create election</button>
        ) : (
          <button className="button button-secondary" onClick={cancelCreate} type="button">Cancel</button>
        )}
      </div>

      {election ? (
        <dl className="election-meta-grid">
          <div><dt>Election name</dt><dd>{election.name}</dd></div>
          <div><dt>Election date</dt><dd>{election.election_date}</dd></div>
          <div><dt>Started at</dt><dd>{formatTimestamp(election.start_time)}</dd></div>
          <div><dt>Ended at</dt><dd>{election.end_time ? formatTimestamp(election.end_time) : election.status === 'OPEN' ? 'In progress' : 'Not recorded'}</dd></div>
          <div><dt>Election timer</dt><dd aria-live="polite">{electionTimer(election, clockNow)}</dd></div>
          <div><dt>Current status</dt><dd>{election.status}</dd></div>
        </dl>
      ) : isCreating ? null : (
        <p className="election-empty-note">Create an election to configure its schedule.</p>
      )}

      {isCreating || (election && !isLocked) ? (
        <form className="election-setup-form" id="election-setup-form" onSubmit={handleSubmit}>
          <label className="form-field" htmlFor="election-name">
            <span>Election name</span>
            <input autoComplete="off" id="election-name" maxLength={200} onChange={(event) => setName(event.target.value)} placeholder="Enter the election name" required value={name} />
          </label>
          <label className="form-field" htmlFor="election-date">
            <span>Election date</span>
            <input id="election-date" onChange={(event) => setElectionDate(event.target.value)} required type="date" value={electionDate} />
          </label>
          {saveMutation.isError ? <p className="form-error" role="alert">{saveMutation.error.message}</p> : null}
          {saveMutation.isSuccess ? <p className="election-save-success" role="status">Election saved.</p> : null}
        </form>
      ) : election ? (
        <p className="election-locked-note">Configuration is locked because this election is no longer a draft.</p>
      ) : null}

      {election?.status === 'DRAFT' ? (
        <section className="election-readiness" aria-labelledby="election-readiness-title">
          <div className="election-readiness-heading">
            <div>
              <h3 id="election-readiness-title">Pre-flight checklist</h3>
              <p>Complete these checks before starting the election. Starting locks election configuration.</p>
            </div>
            {readinessQuery.isError ? (
              <button className="button button-secondary" onClick={() => readinessQuery.refetch()} type="button">Retry</button>
            ) : null}
          </div>
          {readinessQuery.isPending ? <p className="election-readiness-message" role="status">Checking election setup…</p> : null}
          {readinessQuery.isError ? <p className="form-error" role="alert">{readinessQuery.error.message}</p> : null}
          {readinessChecks ? (
            <ul className="election-readiness-list">
              {Object.entries(readinessChecks).filter(([key]) => key !== 'ballot_total').map(([key, check]) => {
                const checkReady = key === 'positions'
                  ? check.ready && readinessChecks.ballot_total?.ready
                  : check.ready || (key === 'servers' && serversConfirmed)
                const actual = key === 'servers' && serversConfirmed ? 'Confirmed by administrator' : check.actual
                return (
                  <li className={checkReady ? 'is-ready' : 'is-incomplete'} key={key}>
                    <input
                      aria-label={checkLabels[key] ?? key}
                      checked={checkReady}
                      className="election-readiness-checkbox"
                      disabled={key !== 'servers'}
                      onChange={(event) => {
                        if (key === 'servers') setServersConfirmed(event.target.checked)
                      }}
                      type="checkbox"
                    />
                    <div>
                      <strong>{checkLabels[key] ?? key}</strong>
                      <small>{key === 'positions' ? `${check.actual} / ${check.expected} positions${readinessChecks.ballot_total?.ready ? '' : ' · Vote limits need review'}`
                          : key === 'candidates' ? `${check.actual} active candidates`
                            : key === 'voters' ? `${check.actual} voters`
                              : key === 'entry_officers' ? `${check.actual} active entry officers`
                                : key === 'systems' ? `${check.actual} active systems`
                                  : key === 'system_booth_officers' ? check.actual
                              : key === 'booth_officers' ? `${check.actual}; ${check.expected}`
                                : key === 'single_open_election' ? (check.ready ? 'None found' : `${check.actual} other open elections`)
                                  : actual}</small>
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : null}
          {readiness ? (
            <div className="election-open-form">
              {openMutation.isError ? <p className="form-error" role="alert">{openMutation.error.message}</p> : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {election?.status === 'OPEN' && stopMutation.isError ? (
        <p className="form-error" role="alert">{stopMutation.error.message}</p>
      ) : null}

      <div className="election-status-actions" aria-label="Election status actions">
        <button
          className="button button-secondary election-save-button"
          disabled={(!isCreating && (!election || Boolean(isLocked))) || saveMutation.isPending}
          form="election-setup-form"
          type="submit"
        >
          {saveMutation.isPending ? 'Saving…' : 'Draft'}
        </button>
        <button
          className="button button-primary election-save-button"
          disabled={election?.status !== 'DRAFT' || hasUnsavedChanges || !readiness?.ready || !serversConfirmed || openMutation.isPending}
          onClick={() => {
            if (window.confirm('Start this election now? Setup changes will be locked.')) {
              openMutation.mutate({ election_id: election.id, confirm_servers_healthy: true })
            }
          }}
          type="button"
        >
          {openMutation.isPending ? 'Starting…' : 'Start'}
        </button>
        <button
          className="button button-danger election-save-button"
          disabled={election?.status !== 'OPEN' || stopMutation.isPending}
          onClick={() => {
            if (window.confirm('Stop this election now? Voting will no longer be available.')) {
              stopMutation.mutate(election.id)
            }
          }}
          type="button"
        >
          {stopMutation.isPending ? 'Stopping…' : 'Stop'}
        </button>
      </div>
    </section>
  )
}
