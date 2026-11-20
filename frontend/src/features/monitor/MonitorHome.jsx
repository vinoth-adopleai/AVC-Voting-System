import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router'

import { monitorApi } from '../../api/monitorApi.js'
import StatusBadge from '../../components/ui/StatusBadge.jsx'
import VoterPhoto from '../../components/ui/VoterPhoto.jsx'
import { formatIstDateTime, formatIstTime } from '../../utils/dateTime.js'

const POLL_INTERVAL = 2_000
const HEARTBEAT_STALE_MS = 10 * 60 * 1_000
const WAITING_PAGE_SIZE = 10

function getSystemState(system) {
  if (!system.is_active || system.status === 'OFFLINE') return 'offline'
  if (system.status === 'OCCUPIED') return 'occupied'
  const lastSeen = system.last_seen_at ? new Date(system.last_seen_at).getTime() : 0
  if (!lastSeen || Date.now() - lastSeen > HEARTBEAT_STALE_MS) return 'attention'
  return 'free'
}

function getStateTone(state) {
  if (state === 'free') return 'success'
  if (state === 'occupied') return 'warning'
  if (state === 'attention') return 'danger'
  return 'neutral'
}

export default function MonitorHome() {
  const { t } = useTranslation()
  const location = useLocation()
  const queryClient = useQueryClient()
  const [lookupSerial, setLookupSerial] = useState('')
  const [selectedVoter, setSelectedVoter] = useState(null)
  const [selectedSystemId, setSelectedSystemId] = useState('')
  const [notice, setNotice] = useState('')
  const [queuePage, setQueuePage] = useState(1)
  const isWaitingListPage = location.pathname.endsWith('/waiting')

  const boardQuery = useQuery({
    queryKey: ['monitor', 'board'],
    queryFn: monitorApi.getBoard,
    refetchInterval: POLL_INTERVAL,
  })
  const waitingQuery = useQuery({
    queryKey: ['monitor', 'waiting', queuePage],
    queryFn: () => monitorApi.getWaiting('', queuePage, WAITING_PAGE_SIZE),
    enabled: isWaitingListPage && Boolean(boardQuery.data),
    refetchInterval: POLL_INTERVAL,
  })
  const lookupMutation = useMutation({ mutationFn: monitorApi.findVoter })

  const assignMutation = useMutation({
    mutationFn: monitorApi.assignVoter,
    onSuccess: (result) => {
      setNotice(t('monitor.assignedSuccess', {
        name: result.name,
        serial: result.serial_no,
        booth: result.booth_no,
        system: result.system_no,
      }))
      setSelectedVoter(null)
      setSelectedSystemId('')
      setQueuePage(1)
      queryClient.invalidateQueries({ queryKey: ['monitor'] })
    },
    onError: () => queryClient.invalidateQueries({ queryKey: ['monitor'] }),
  })
  const resetMutation = useMutation({
    mutationFn: monitorApi.resetSystem,
    onSuccess: () => {
      setNotice(t('monitor.resetSuccess'))
      queryClient.invalidateQueries({ queryKey: ['monitor'] })
    },
    onError: () => queryClient.invalidateQueries({ queryKey: ['monitor'] }),
  })

  const booths = boardQuery.data?.booths ?? []
  const availableSystems = useMemo(
    () => booths.flatMap((booth) => booth.systems
      .filter((system) => system.is_active && system.status === 'FREE' && !system.current_voter_id)
      .map((system) => ({ ...system, booth_no: booth.booth_no }))),
    [booths],
  )
  const waitingItems = waitingQuery.data?.items ?? []
  const waitingTotal = waitingQuery.data?.total ?? 0
  const waitingTotalPages = Math.max(1, Math.ceil(waitingTotal / WAITING_PAGE_SIZE))

  useEffect(() => {
    if (queuePage > waitingTotalPages) setQueuePage(waitingTotalPages)
  }, [queuePage, waitingTotalPages])

  useEffect(() => {
    if (!selectedVoter) return
    if (!availableSystems.some((system) => String(system.id) === selectedSystemId)) {
      setSelectedSystemId(availableSystems[0] ? String(availableSystems[0].id) : '')
    }
  }, [availableSystems, selectedSystemId, selectedVoter])

  function selectVoter(voter) {
    setNotice('')
    setSelectedVoter(voter)
    setSelectedSystemId(availableSystems[0] ? String(availableSystems[0].id) : '')
  }

  function handleVoterLookup(event) {
    event.preventDefault()
    const serial = lookupSerial.trim()
    if (!serial) return
    lookupMutation.mutate(serial)
  }

  function handleVoterLookupChange(value) {
    setLookupSerial(value)
    lookupMutation.reset()
  }

  function handleAssign(event) {
    event.preventDefault()
    if (!selectedVoter || !selectedSystemId) return
    assignMutation.mutate({ voter_id: selectedVoter.id, system_id: Number(selectedSystemId) })
  }

  function handleReset(system) {
    const confirmation = t('monitor.resetConfirm', {
      voter: system.voter?.name ?? '',
      system: system.system_no,
    })
    if (window.confirm(confirmation)) {
      setNotice('')
      resetMutation.mutate(system.id)
    }
  }

  return (
    <div className="booth-board-page">
      {boardQuery.isPending ? <section className="booth-operations-card" role="status">{t('monitor.loadingBoard')}</section> : null}
      {boardQuery.isError ? (
        <section className="booth-operations-card booth-operations-error">
          <p className="form-error" role="alert">{boardQuery.error.message}</p>
          <button className="button button-secondary" onClick={() => boardQuery.refetch()} type="button">{t('monitor.retry')}</button>
        </section>
      ) : null}

      {boardQuery.data ? (
        <div className={`booth-operations-layout${isWaitingListPage ? ' is-waiting-list-layout' : ''}`}>
          {!isWaitingListPage ? (
            <section className="booth-operations-card booth-voter-lookup-card" aria-labelledby="booth-voter-lookup-title">
              <div className="booth-section-heading">
                <div>
                  <h2 id="booth-voter-lookup-title">{t('monitor.lookupTitle')}</h2>
                  <p>{t('monitor.lookupDescription')}</p>
                </div>
              </div>
              <form className="booth-voter-lookup-form" onSubmit={handleVoterLookup}>
                <label className="form-field" htmlFor="booth-voter-lookup-serial">
                  <span>{t('entry.serialLabel')}</span>
                  <input
                    autoComplete="off"
                    id="booth-voter-lookup-serial"
                    maxLength={20}
                    onChange={(event) => handleVoterLookupChange(event.target.value)}
                    placeholder={t('entry.serialPlaceholder')}
                    required
                    value={lookupSerial}
                  />
                </label>
                <button className="button button-primary" disabled={lookupMutation.isPending || !lookupSerial.trim()} type="submit">
                  {lookupMutation.isPending ? t('entry.searching') : t('monitor.lookupSubmit')}
                </button>
              </form>
              {lookupMutation.isError ? <p className="form-error booth-lookup-error" role="alert">{lookupMutation.error.message}</p> : null}
              {notice ? <p className="booth-action-success" role="status">{notice}</p> : null}
              {lookupMutation.data?.voter ? (() => {
                const voter = lookupMutation.data.voter
                const statusTone = voter.status === 'ELIGIBLE' ? 'success' : voter.status === 'VOTED' ? 'neutral' : 'warning'
                const statusLabel = voter.status === 'ELIGIBLE'
                  ? t('entry.readyToEnter')
                  : voter.status === 'ENTERED'
                    ? t('entry.alreadyEntered')
                    : voter.status === 'VOTED'
                      ? t('entry.alreadyVoted')
                      : t('entry.atBooth')
                return (
                  <article className="entry-voter-result booth-lookup-result" aria-live="polite">
                    <div className="entry-voter-heading">
                      <div className="entry-voter-identity">
                        <div className="entry-voter-serial-block">
                          <span>{t('entry.serialLabel')}</span>
                          <strong>{voter.serial_no}</strong>
                        </div>
                        <h3>{voter.name}</h3>
                        <StatusBadge tone={statusTone}>{statusLabel}</StatusBadge>
                      </div>
                      <div className="booth-result-photo-actions">
                        <VoterPhoto className="entry-voter-photo" name={voter.name} photo={voter.photo} />
                        <button
                          className="button button-primary booth-assign-result-button"
                          disabled={voter.status !== 'ENTERED' || !availableSystems.length || assignMutation.isPending}
                          onClick={() => selectVoter(voter)}
                          type="button"
                        >
                          {t('monitor.assignSystem')}
                        </button>
                      </div>
                    </div>
                    <dl className="entry-voter-details">
                      {voter.father_husband_name ? <div><dt>{t('entry.fatherHusbandName')}</dt><dd>{voter.father_husband_name}</dd></div> : null}
                      {voter.age ? <div><dt>{t('entry.age')}</dt><dd>{voter.age}</dd></div> : null}
                      {voter.gender ? <div><dt>{t('entry.gender')}</dt><dd>{voter.gender === 'M' ? t('entry.male') : voter.gender === 'F' ? t('entry.female') : voter.gender}</dd></div> : null}
                      {voter.address ? <div className="entry-address"><dt>{t('entry.address')}</dt><dd>{voter.address}</dd></div> : null}
                    </dl>
                  </article>
                )
              })() : null}
            </section>
          ) : null}

          {isWaitingListPage ? (
          <section className="booth-operations-card booth-queue-card" aria-labelledby="booth-queue-title">
            <div className="booth-section-heading">
              <div>
                <h2 id="booth-queue-title">{t('monitor.waitingTitle')}</h2>
                <p>{t('monitor.waitingDescription')}</p>
              </div>
              <span className="booth-count">{waitingTotal}</span>
            </div>

            {waitingQuery.isPending ? <p className="booth-empty-state" role="status">{t('monitor.loadingQueue')}</p> : null}
            {waitingQuery.isError ? <p className="form-error" role="alert">{waitingQuery.error.message}</p> : null}
            {!waitingQuery.isPending && !waitingQuery.isError && !waitingItems.length ? (
              <p className="booth-empty-state">{t('monitor.noWaitingVoters')}</p>
            ) : null}

            {waitingItems.length ? (
              <>
                <div className="booth-waiting-list" aria-busy={waitingQuery.isFetching}>
                  <div className="booth-waiting-table" role="table" aria-label={t('monitor.waitingTitle')}>
                    <div className="booth-waiting-table-header admin-list-header" role="row">
                      <span role="columnheader">{t('entry.serialLabel')}</span>
                      <span role="columnheader">{t('monitor.waitingName')}</span>
                      <span role="columnheader">{t('entry.fatherHusbandName')}</span>
                      <span role="columnheader">{t('entry.age')}</span>
                      <span role="columnheader">{t('entry.gender')}</span>
                      <span role="columnheader">{t('entry.address')}</span>
                      <span role="columnheader">{t('entry.enteredAt')}</span>
                    </div>
                    <div role="rowgroup">
                      {waitingItems.map((voter) => (
                        <div className="booth-waiting-table-row admin-list-row" key={voter.id} role="row">
                          <span data-label={t('entry.serialLabel')} role="cell">{voter.serial_no}</span>
                          <strong data-label={t('monitor.waitingName')} role="cell">{voter.name}</strong>
                          <span data-label={t('entry.fatherHusbandName')} role="cell">{voter.father_husband_name || '—'}</span>
                          <span data-label={t('entry.age')} role="cell">{voter.age ?? '—'}</span>
                          <span data-label={t('entry.gender')} role="cell">{voter.gender === 'M' ? t('entry.male') : voter.gender === 'F' ? t('entry.female') : voter.gender || '—'}</span>
                          <span className="booth-waiting-address" data-label={t('entry.address')} role="cell" title={voter.address || ''}>{voter.address || '—'}</span>
                          <time data-label={t('entry.enteredAt')} dateTime={voter.entered_at} role="cell">{formatIstDateTime(voter.entered_at)}</time>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </>
            ) : null}
            {!waitingQuery.isPending && !waitingQuery.isError ? (
              <nav className="booth-queue-pagination" aria-label="Waiting voter pagination">
                <span>Page {queuePage} of {waitingTotalPages}</span>
                <div>
                  <button className="button button-secondary" disabled={queuePage <= 1 || waitingQuery.isFetching} onClick={() => setQueuePage((page) => page - 1)} type="button">Previous</button>
                  <button className="button button-secondary" disabled={queuePage >= waitingTotalPages || waitingQuery.isFetching} onClick={() => setQueuePage((page) => page + 1)} type="button">Next</button>
                </div>
              </nav>
            ) : null}
          </section>
          ) : null}

          {!isWaitingListPage ? (
          <section className="booth-operations-card booth-systems-card" aria-labelledby="booth-systems-title">
            <div className="booth-section-heading">
              <div>
                <h2 id="booth-systems-title">{t('monitor.systemsTitle')}</h2>
                <p>{t('monitor.systemsDescription')}</p>
              </div>
              <span className="booth-count">{booths.reduce((total, booth) => total + booth.systems.length, 0)}</span>
            </div>
            {resetMutation.isError ? <p className="form-error" role="alert">{resetMutation.error.message}</p> : null}

            {!booths.some((booth) => booth.systems.length) ? (
              <p className="booth-empty-state">{t('monitor.noSystems')}</p>
            ) : (
              <div className="booth-grid">
                {booths.map((booth) => (
                  <section className="booth-group" key={booth.id} aria-label={`${t('monitor.booth')} ${booth.booth_no}`}>
                    <h3>{t('monitor.booth')} {booth.booth_no}</h3>
                    <div className="booth-system-grid">
                      {booth.systems.map((system) => {
                        const state = getSystemState(system)
                        return (
                          <article className={`booth-system-card is-${state}`} key={system.id}>
                            <div className="booth-system-heading">
                              <div>
                                <span className="booth-system-number">{t('monitor.system')} {system.system_no}</span>
                                <h4>{system.name || `${t('monitor.system')} ${system.system_no}`}</h4>
                              </div>
                              <StatusBadge tone={getStateTone(state)}>{t(`monitor.state.${state}`)}</StatusBadge>
                            </div>
                            {system.voter ? (
                              <div className="booth-current-voter">
                                <span>{t('monitor.currentVoter')}</span>
                                <strong>{system.voter.name}</strong>
                                <small>{system.voter.serial_no}</small>
                              </div>
                            ) : (
                              <p className="booth-system-availability">{state === 'free' ? t('monitor.available') : t('monitor.noActiveSession')}</p>
                            )}
                            <div className="booth-system-footer">
                              <span>{system.last_seen_at ? t('monitor.lastSeen', { time: formatIstTime(system.last_seen_at) }) : t('monitor.neverConnected')}</span>
                              {system.status === 'OCCUPIED' && system.voter ? (
                                <button
                                  className="button button-secondary booth-reset-button"
                                  disabled={resetMutation.isPending}
                                  onClick={() => handleReset(system)}
                                  type="button"
                                >
                                  {resetMutation.isPending ? t('monitor.resetting') : t('monitor.resetButton')}
                                </button>
                              ) : null}
                            </div>
                          </article>
                        )
                      })}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </section>
          ) : null}
        </div>
      ) : null}

      {selectedVoter ? (
        <div className="booth-dialog-backdrop">
          <section className="booth-assign-dialog" role="dialog" aria-modal="true" aria-labelledby="booth-assign-title">
            <div className="booth-section-heading">
              <div>
                <p className="booth-voter-serial">{selectedVoter.serial_no}</p>
                <h2 id="booth-assign-title">{selectedVoter.name}</h2>
                <p>{t('monitor.chooseSystem')}</p>
              </div>
            </div>
            <form className="booth-assign-form" onSubmit={handleAssign}>
              {assignMutation.isError ? <p className="form-error" role="alert">{assignMutation.error.message}</p> : null}
              <label className="form-field" htmlFor="booth-system-select">
                <span>{t('monitor.systemLabel')}</span>
                <select id="booth-system-select" onChange={(event) => setSelectedSystemId(event.target.value)} value={selectedSystemId}>
                  {availableSystems.map((system) => (
                    <option key={system.id} value={system.id}>{t('monitor.booth')} {system.booth_no} · {t('monitor.system')} {system.system_no}</option>
                  ))}
                </select>
              </label>
              {!availableSystems.length ? <p className="form-error">{t('monitor.noAvailableSystems')}</p> : null}
              <div className="booth-dialog-actions">
                <button className="button button-secondary" onClick={() => setSelectedVoter(null)} type="button">{t('monitor.cancel')}</button>
                <button className="button button-primary booth-give-access-submit" disabled={!selectedSystemId || assignMutation.isPending} type="submit">
                  {assignMutation.isPending ? t('monitor.assigning') : t('monitor.giveAccess')}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  )
}
