import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'

import { adminApi } from '../../api/adminApi.js'
import StatusBadge from '../../components/ui/StatusBadge.jsx'

const BOOTHS_PER_PAGE = 5

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character])
}

function printRegistrationSheet(systems) {
  const printWindow = window.open('', '_blank', 'width=900,height=700')
  if (!printWindow) return
  const cards = systems.map((system) => `
    <article class="device">
      <h2>${escapeHtml(system.name)}</h2>
      <p>System ${escapeHtml(system.system_no)} · Booth ${escapeHtml(system.desk_no)}</p>
      <code>${escapeHtml(system.token)}</code>
      <small>Keep this token private. Enter it on the registered voting device.</small>
    </article>
  `).join('')
  printWindow.document.open()
  printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Device registration sheet</title>
    <style>
      body{font:14px Arial,sans-serif;color:#24384b;padding:24px}h1{font-size:22px;margin:0 0 18px}
      .sheet{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
      .device{break-inside:avoid;border:1px solid #ccd6df;border-radius:8px;padding:16px}
      h2{font-size:16px;margin:0 0 6px}.device p{color:#617284;margin:0 0 12px}
      code{display:block;overflow-wrap:anywhere;border:1px dashed #9babb9;padding:10px;font-size:12px}
      small{display:block;margin-top:10px;color:#7a4c24}
      @media print{body{padding:0}.device{break-inside:avoid}}
    </style></head><body><h1>Voting system registration tokens</h1><main class="sheet">${cards}</main></body></html>`)
  printWindow.document.close()
  printWindow.focus()
  printWindow.print()
}

function getStaffName(person) {
  return person?.full_name || person?.username || ''
}

function downloadTokenCsv(csvText, electionId) {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `voting-system-tokens-election-${electionId}.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function SystemsWorkspace() {
  const queryClient = useQueryClient()
  const [electionId, setElectionId] = useState('')
  const [deskCount, setDeskCount] = useState('3')
  const [systemCount, setSystemCount] = useState('3')
  const [selectedDeskId, setSelectedDeskId] = useState('')
  const [assignmentDrafts, setAssignmentDrafts] = useState({})
  const [newlyRegistered, setNewlyRegistered] = useState([])
  const [copiedSystemId, setCopiedSystemId] = useState(null)
  const [actionError, setActionError] = useState('')
  const [isSetupOpen, setIsSetupOpen] = useState(false)
  const [expandedBoothId, setExpandedBoothId] = useState(null)
  const [boothPage, setBoothPage] = useState(1)
  const tokenCardRef = useRef(null)

  const electionsQuery = useQuery({ queryKey: ['admin', 'elections'], queryFn: adminApi.getElections })
  const staffQuery = useQuery({ queryKey: ['admin', 'staff'], queryFn: adminApi.getStaff })
  const elections = electionsQuery.data ?? []
  const selectedElection = useMemo(
    () => elections.find((election) => String(election.id) === electionId),
    [elections, electionId],
  )
  const systemQuery = useQuery({
    queryKey: ['admin', 'systems', electionId],
    queryFn: () => adminApi.getDesksAndSystems(electionId),
    enabled: Boolean(electionId),
  })
  const staff = staffQuery.data ?? []
  const monitorOfficers = staff.filter((person) => person.role === 'MONITOR_OFFICER' && person.is_active)
  const desks = systemQuery.data?.desks ?? []
  const totalBoothPages = Math.max(1, Math.ceil(desks.length / BOOTHS_PER_PAGE))
  const currentBoothPage = Math.min(boothPage, totalBoothPages)
  const visibleDesks = desks.slice((currentBoothPage - 1) * BOOTHS_PER_PAGE, currentBoothPage * BOOTHS_PER_PAGE)
  const isLocked = selectedElection?.status !== 'DRAFT'
  const canIssueDeviceToken = ['DRAFT', 'OPEN'].includes(selectedElection?.status)

  useEffect(() => {
    if (!electionId && elections.length) setElectionId(String(elections[0].id))
  }, [elections, electionId])

  useEffect(() => {
    if (newlyRegistered.length) {
      tokenCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [newlyRegistered])

  useEffect(() => {
    if (!isSetupOpen) return undefined
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setIsSetupOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [isSetupOpen])

  useEffect(() => {
    if (!desks.length) {
      setAssignmentDrafts({})
      setSelectedDeskId('')
      return
    }
    setAssignmentDrafts(Object.fromEntries(desks.map((desk) => [desk.id, {
      officer_id: desk.officer ? String(desk.officer.id) : '',
      supervisor_id: desk.supervisor ? String(desk.supervisor.id) : '',
    }])))
    if (!desks.some((desk) => String(desk.id) === selectedDeskId)) {
      setSelectedDeskId(String(desks[0].id))
    }
  }, [desks, selectedDeskId])

  const reloadSystems = () => queryClient.invalidateQueries({ queryKey: ['admin', 'systems', electionId] })
  const createDesksMutation = useMutation({
    mutationFn: adminApi.createMonitorDesks,
    onSuccess: (result) => {
      setActionError('')
      setDeskCount('3')
      reloadSystems()
      setActionError(`${result.created_count} booth${result.created_count === 1 ? '' : 's'} created.`)
    },
  })
  const assignMutation = useMutation({
    mutationFn: ({ deskId, payload }) => adminApi.assignMonitorDesk(deskId, payload),
    onSuccess: () => {
      setActionError('Booth assignments saved.')
      reloadSystems()
    },
  })
  const registerMutation = useMutation({
    mutationFn: adminApi.createVotingSystems,
    onSuccess: (result) => {
      setNewlyRegistered(result.systems.map((system) => ({
        ...system,
        desk_no: desks.find((desk) => desk.id === system.monitor_desk_id)?.desk_no,
      })))
      setActionError('')
      reloadSystems()
      setIsSetupOpen(false)
    },
  })
  const systemStatusMutation = useMutation({
    mutationFn: ({ systemId, isActive }) => adminApi.setVotingSystemActive(systemId, isActive),
    onSuccess: reloadSystems,
  })
  const systemTokenMutation = useMutation({
    mutationFn: adminApi.getVotingSystemToken,
    onSuccess: (system) => {
      setNewlyRegistered([{
        ...system,
        desk_no: desks.find((desk) => desk.id === system.monitor_desk_id)?.desk_no,
      }])
      setActionError('')
      reloadSystems()
    },
  })
  const exportTokensMutation = useMutation({
    mutationFn: async (id) => {
      const csvText = await adminApi.exportVotingSystemTokens(id)
      downloadTokenCsv(csvText, id)
    },
    onSuccess: () => {
      setNewlyRegistered([])
      setActionError('Token CSV downloaded. Repeated downloads will contain the same permanent tokens while DEVICE_TOKEN_SECRET stays unchanged.')
      reloadSystems()
    },
  })

  function submitDeskCount(event) {
    event.preventDefault()
    if (!electionId) return
    setActionError('')
    setNewlyRegistered([])
    createDesksMutation.mutate({ election_id: Number(electionId), count: Number(deskCount) })
  }

  function submitSystemCount(event) {
    event.preventDefault()
    if (!electionId || !selectedDeskId) return
    setActionError('')
    registerMutation.mutate({
      election_id: Number(electionId),
      monitor_desk_id: Number(selectedDeskId),
      count: Number(systemCount),
    })
  }

  function saveAssignment(desk) {
    const draft = assignmentDrafts[desk.id] ?? {}
    setActionError('')
    assignMutation.mutate({
      deskId: desk.id,
      payload: {
        officer_id: draft.officer_id ? Number(draft.officer_id) : null,
        supervisor_id: draft.supervisor_id ? Number(draft.supervisor_id) : null,
      },
    })
  }

  async function copyToken(system) {
    try {
      await navigator.clipboard.writeText(system.token)
      setCopiedSystemId(system.id)
      window.setTimeout(() => setCopiedSystemId(null), 1800)
    } catch {
      setActionError('Clipboard access was blocked. Select and copy the token text instead.')
    }
  }

  if (electionsQuery.isPending) return <section className="systems-card" role="status">Loading elections…</section>
  if (electionsQuery.isError) {
    return <section className="systems-card"><p className="form-error" role="alert">{electionsQuery.error.message}</p></section>
  }
  if (!elections.length) {
    return (
      <section className="systems-card">
        <p className="systems-notice">Create an election before registering booths and voting systems. <Link to="/admin/election">Go to Election setup</Link></p>
      </section>
    )
  }

  return (
    <div className="systems-workspace">
      {isLocked ? <p className="systems-notice">Booth assignments and system registration are locked after the election opens. System activation can still be changed below.</p> : null}
      {actionError ? <p className={actionError.includes('created') || actionError.includes('saved') || actionError.includes('downloaded') ? 'systems-success' : 'form-error'} role="status">{actionError}</p> : null}

      <section className="systems-card systems-overview-card">
        <div className="systems-token-export-controls">
          <label className="form-field systems-election-field" htmlFor="systems-election">
            <span>Election</span>
            <select id="systems-election" onChange={(event) => {
              setElectionId(event.target.value)
              setBoothPage(1)
              setNewlyRegistered([])
              setActionError('')
            }} value={electionId}>
              {elections.map((election) => <option key={election.id} value={election.id}>{election.name}</option>)}
            </select>
          </label>
          <button
            className="button button-primary"
            disabled={!canIssueDeviceToken || !systemQuery.data?.system_count || exportTokensMutation.isPending}
            onClick={() => {
              const confirmed = window.confirm(
                'This will download the stable permanent tokens for every system. Tokens created by the earlier random-token version may change once; subsequent downloads will contain the same values. Continue?',
              )
              if (confirmed) exportTokensMutation.mutate(electionId)
            }}
            type="button"
          >
            {exportTokensMutation.isPending ? 'Preparing CSV…' : 'Generate and download CSV'}
          </button>
          <button className="button button-secondary" disabled={isLocked} onClick={() => setIsSetupOpen(true)} type="button">
            Set up booths and systems
          </button>
        </div>
        {exportTokensMutation.isError ? <p className="form-error" role="alert">{exportTokensMutation.error.message}</p> : null}

      {isSetupOpen ? (
        <div className="systems-dialog-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setIsSetupOpen(false)
        }}>
          <section aria-labelledby="systems-setup-dialog-title" aria-modal="true" className="systems-setup-dialog" role="dialog">
            <div className="systems-setup-dialog-heading">
              <div>
                <span className="panel-kicker">BOOTH AND SYSTEM SETUP</span>
                <h2 id="systems-setup-dialog-title">Create booths and register voting systems</h2>
              </div>
              <button aria-label="Close setup" className="icon-button" onClick={() => setIsSetupOpen(false)} type="button">×</button>
            </div>

            <div className="systems-setup-grid">
              <section className="systems-card">
                <div className="systems-card-heading">
                  <div><h2>Booths</h2><p>{systemQuery.data?.desk_count ?? 0} booths registered</p></div>
                </div>
                <form className="systems-inline-form" onSubmit={submitDeskCount}>
                  <label className="form-field" htmlFor="systems-desk-count">
                    <span>Add booths</span>
                    <input id="systems-desk-count" max="150" min="1" onChange={(event) => setDeskCount(event.target.value)} required type="number" value={deskCount} />
                  </label>
                  <button className="button button-primary" disabled={isLocked || createDesksMutation.isPending} type="submit">{createDesksMutation.isPending ? 'Creating…' : 'Create booths'}</button>
                </form>
                {createDesksMutation.isError ? <p className="form-error" role="alert">{createDesksMutation.error.message}</p> : null}
                {staffQuery.isError ? <p className="form-error" role="alert">Could not load staff for booth assignments: {staffQuery.error.message}</p> : null}
              </section>

              <section className="systems-card">
                <div className="systems-card-heading">
                  <div><h2>Voting systems</h2><p>{systemQuery.data?.system_count ?? 0} systems registered</p></div>
                </div>
                {!desks.length ? (
                  <p className="systems-notice">Create at least one booth before registering systems.</p>
                ) : (
                  <form className="systems-inline-form" onSubmit={submitSystemCount}>
                    <label className="form-field" htmlFor="systems-desk-select">
                      <span>Booth</span>
                      <select id="systems-desk-select" onChange={(event) => setSelectedDeskId(event.target.value)} value={selectedDeskId}>
                        {desks.map((desk) => <option key={desk.id} value={desk.id}>Booth {desk.desk_no}</option>)}
                      </select>
                    </label>
                    <label className="form-field systems-count-field" htmlFor="systems-count">
                      <span>Systems to add</span>
                      <input id="systems-count" max="50" min="1" onChange={(event) => setSystemCount(event.target.value)} required type="number" value={systemCount} />
                    </label>
                    <button className="button button-primary" disabled={isLocked || registerMutation.isPending} type="submit">{registerMutation.isPending ? 'Registering…' : 'Register systems'}</button>
                  </form>
                )}
                {registerMutation.isError ? <p className="form-error" role="alert">{registerMutation.error.message}</p> : null}
              </section>
            </div>
          </section>
        </div>
      ) : null}

      {newlyRegistered.length ? (
        <section className="systems-card systems-token-card" aria-live="polite" ref={tokenCardRef}>
          <div className="systems-card-heading">
            <div>
              <h2>Save this permanent device token</h2>
              <p>This token is stable and does not expire. Future CSV downloads return the same value while DEVICE_TOKEN_SECRET stays unchanged. Save it on its assigned voting terminal.</p>
            </div>
            <button className="button button-secondary" onClick={() => printRegistrationSheet(newlyRegistered)} type="button">Print registration sheet</button>
          </div>
          <div className="systems-token-list">
            {newlyRegistered.map((system) => (
              <article className="systems-token-row" key={system.id}>
                <div><strong>{system.name}</strong><span>Booth {system.desk_no} · System {system.system_no}</span></div>
                <code>{system.token}</code>
                <button className="button button-secondary" onClick={() => copyToken(system)} type="button">{copiedSystemId === system.id ? 'Copied' : 'Copy token'}</button>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <div className="systems-desks-card">
        {systemQuery.isPending ? <p className="systems-notice" role="status">Loading booths and systems…</p> : null}
        {systemQuery.isError ? <p className="form-error" role="alert">{systemQuery.error.message}</p> : null}
        {!systemQuery.isPending && !systemQuery.isError && !desks.length ? <p className="systems-notice">No booths have been created.</p> : null}
        {desks.length ? (
          <div className="systems-booth-list">
            <div className="systems-booth-list-header admin-list-header" aria-hidden="true">
              <span>No.</span>
              <span>Booth</span>
              <span>Booth officer</span>
              <span>Assigned systems</span>
              <span>Action</span>
            </div>
            {visibleDesks.map((desk, pageIndex) => {
            const index = (currentBoothPage - 1) * BOOTHS_PER_PAGE + pageIndex
            const draft = assignmentDrafts[desk.id] ?? { officer_id: '', supervisor_id: '' }
            const isExpanded = expandedBoothId === desk.id
            const systemsListId = `desk-systems-${desk.id}`
            return (
              <article className="systems-booth-list-item" key={desk.id}>
                <div className="systems-booth-list-row admin-list-row">
                  <span className="systems-booth-list-number">{String(index + 1).padStart(2, '0')}</span>
                  <strong className="systems-booth-list-name">Booth {desk.desk_no}</strong>
                  <label className="form-field systems-booth-list-field">
                    <span>Booth officer</span>
                    <select aria-label={`Booth officer for booth ${desk.desk_no}`} disabled={isLocked || staffQuery.isPending} id={`desk-officer-${desk.id}`} onChange={(event) => setAssignmentDrafts((current) => ({ ...current, [desk.id]: { ...draft, officer_id: event.target.value } }))} value={draft.officer_id}>
                      <option value="">Unassigned</option>
                      {monitorOfficers.map((person) => <option key={person.id} value={person.id}>{getStaffName(person)}</option>)}
                    </select>
                  </label>
                  <button aria-controls={systemsListId} aria-expanded={isExpanded} className="button button-secondary systems-assigned-systems-button" onClick={() => setExpandedBoothId(isExpanded ? null : desk.id)} type="button">
                    Assigned systems ({desk.systems.length})
                  </button>
                  <button className="button button-secondary systems-save-assignment-button" disabled={isLocked || assignMutation.isPending} onClick={() => saveAssignment(desk)} type="button">{assignMutation.isPending ? 'Saving…' : 'Save assignment'}</button>
                </div>
                <div className="systems-booth-list-devices" hidden={!isExpanded} id={systemsListId}>
                  {isExpanded && (desk.systems.length ? (
                      <ul className="systems-device-list">
                        {desk.systems.map((system) => (
                          <li key={system.id}>
                            <div><strong>{system.name}</strong><span>System {system.system_no}</span></div>
                            <StatusBadge tone={system.is_active ? system.status === 'OFFLINE' ? 'danger' : system.status === 'OCCUPIED' ? 'warning' : 'success' : 'neutral'}>
                              {system.is_active ? system.status : 'DISABLED'}
                            </StatusBadge>
                            {system.last_seen_at ? <time dateTime={system.last_seen_at}>Seen {new Date(system.last_seen_at).toLocaleString()}</time> : <span className="systems-never-seen">Never connected</span>}
                            <button
                              className="button button-secondary systems-rotate-token-button"
                              disabled={!canIssueDeviceToken || !system.is_active || system.status === 'OCCUPIED' || systemTokenMutation.isPending}
                              onClick={() => {
                                const confirmed = window.confirm(
                                  `Get the stable permanent token for ${system.name}? A token from the earlier random-token version may be replaced. Save this token for the terminal.`,
                                )
                                if (!confirmed) return
                                setActionError('')
                                setNewlyRegistered([])
                                systemTokenMutation.mutate(system.id)
                              }}
                              type="button"
                            >
                              {systemTokenMutation.isPending ? 'Loading…' : 'Get permanent token'}
                            </button>
                            <button className="staff-status-button" disabled={systemStatusMutation.isPending || system.status === 'OCCUPIED'} onClick={() => systemStatusMutation.mutate({ systemId: system.id, isActive: !system.is_active })} type="button">
                              {system.is_active ? 'Disable' : 'Enable'}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : <p className="systems-empty-devices">No voting systems assigned to this booth.</p>)}
                </div>
              </article>
            )
            })}
          </div>
        ) : null}
        <div className="systems-pagination">
          <span>Page {currentBoothPage} of {totalBoothPages}</span>
          <div>
            <button className="button button-secondary" disabled={currentBoothPage <= 1} onClick={() => setBoothPage((page) => Math.max(1, page - 1))} type="button">Previous</button>
            <button className="button button-secondary" disabled={currentBoothPage >= totalBoothPages} onClick={() => setBoothPage((page) => Math.min(totalBoothPages, page + 1))} type="button">Next</button>
          </div>
        </div>
      </div>
      {assignMutation.isError ? <p className="form-error" role="alert">{assignMutation.error.message}</p> : null}
      {systemStatusMutation.isError ? <p className="form-error" role="alert">{systemStatusMutation.error.message}</p> : null}
      {systemTokenMutation.isError ? <p className="form-error" role="alert">{systemTokenMutation.error.message}</p> : null}
      </section>
    </div>
  )
}
