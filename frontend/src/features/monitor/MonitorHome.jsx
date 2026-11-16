import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { monitorApi } from '../../api/monitorApi.js'
import PageHeader from '../../components/ui/PageHeader.jsx'
import StatusBadge from '../../components/ui/StatusBadge.jsx'

const POLL_INTERVAL = 2_000
const HEARTBEAT_STALE_MS = 10 * 60 * 1_000

function formatTime(value) {
  if (!value) return '—'
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function formatWait(seconds) {
  const minutes = Math.floor(seconds / 60)
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

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
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [selectedVoter, setSelectedVoter] = useState(null)
  const [selectedSystemId, setSelectedSystemId] = useState('')
  const [notice, setNotice] = useState('')

  const boardQuery = useQuery({
    queryKey: ['monitor', 'board'],
    queryFn: monitorApi.getBoard,
    refetchInterval: POLL_INTERVAL,
  })
  const waitingQuery = useQuery({
    queryKey: ['monitor', 'waiting', search],
    queryFn: () => monitorApi.getWaiting(search),
    enabled: Boolean(boardQuery.data),
    refetchInterval: POLL_INTERVAL,
  })

  const assignMutation = useMutation({
    mutationFn: monitorApi.assignVoter,
    onSuccess: (result) => {
      setNotice(t('monitor.assignedSuccess', {
        name: result.name,
        booth: result.booth_no,
        system: result.system_no,
      }))
      setSelectedVoter(null)
      setSelectedSystemId('')
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
  const actionError = assignMutation.error || resetMutation.error

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

  const headerActions = boardQuery.data ? (
    <div className="booth-board-context">
      <span>{boardQuery.data.election_name}</span>
      {booths.map((booth) => <StatusBadge key={booth.id} tone="neutral">{t('monitor.booth')} {booth.booth_no}</StatusBadge>)}
    </div>
  ) : null

  return (
    <>
      <PageHeader
        title={t('monitor.title')}
        description={t('monitor.description')}
        actions={headerActions}
      />

      {boardQuery.isPending ? <section className="booth-operations-card" role="status">{t('monitor.loadingBoard')}</section> : null}
      {boardQuery.isError ? (
        <section className="booth-operations-card booth-operations-error">
          <p className="form-error" role="alert">{boardQuery.error.message}</p>
          <button className="button button-secondary" onClick={() => boardQuery.refetch()} type="button">{t('monitor.retry')}</button>
        </section>
      ) : null}

      {boardQuery.data ? (
        <div className="booth-operations-layout">
          <section className="booth-operations-card" aria-labelledby="booth-systems-title">
            <div className="booth-section-heading">
              <div>
                <h2 id="booth-systems-title">{t('monitor.systemsTitle')}</h2>
                <p>{t('monitor.systemsDescription')}</p>
              </div>
              <span className="booth-count">{booths.reduce((total, booth) => total + booth.systems.length, 0)}</span>
            </div>

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
                              <span>{system.last_seen_at ? t('monitor.lastSeen', { time: formatTime(system.last_seen_at) }) : t('monitor.neverConnected')}</span>
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

          <section className="booth-operations-card booth-queue-card" aria-labelledby="booth-queue-title">
            <div className="booth-section-heading">
              <div>
                <h2 id="booth-queue-title">{t('monitor.waitingTitle')}</h2>
                <p>{t('monitor.waitingDescription')}</p>
              </div>
              <span className="booth-count">{waitingItems.length}</span>
            </div>

            <label className="form-field booth-queue-search" htmlFor="waiting-voter-search">
              <span>{t('monitor.searchLabel')}</span>
              <input
                autoComplete="off"
                id="waiting-voter-search"
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('monitor.searchPlaceholder')}
                value={search}
              />
            </label>

            {!availableSystems.length ? <p className="booth-empty-state">{t('monitor.noAvailableSystems')}</p> : null}
            {notice ? <p className="booth-action-success" role="status">{notice}</p> : null}
            {actionError && !selectedVoter ? <p className="form-error" role="alert">{actionError.message}</p> : null}
            {waitingQuery.isPending ? <p className="booth-empty-state" role="status">{t('monitor.loadingQueue')}</p> : null}
            {waitingQuery.isError ? <p className="form-error" role="alert">{waitingQuery.error.message}</p> : null}
            {!waitingQuery.isPending && !waitingQuery.isError && !waitingItems.length ? (
              <p className="booth-empty-state">{search ? t('monitor.noSearchResults') : t('monitor.noWaitingVoters')}</p>
            ) : null}

            <div className="booth-waiting-list">
              {waitingItems.map((voter) => (
                <article className="booth-waiting-voter" key={voter.id}>
                  <div className="booth-waiting-voter-main">
                    <span className="booth-voter-serial">{voter.serial_no}</span>
                    <strong>{voter.name}</strong>
                    {voter.father_husband_name ? <small>{t('monitor.fatherHusbandName')}: {voter.father_husband_name}</small> : null}
                  </div>
                  <span className="booth-wait-time">{formatWait(voter.wait_seconds)}</span>
                  <button
                    className="button button-primary booth-give-access-button"
                    disabled={!availableSystems.length || assignMutation.isPending}
                    onClick={() => selectVoter(voter)}
                    type="button"
                  >
                    {t('monitor.selectVoter')}
                  </button>
                </article>
              ))}
            </div>
          </section>
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
                <button className="button button-primary" disabled={!selectedSystemId || assignMutation.isPending} type="submit">
                  {assignMutation.isPending ? t('monitor.assigning') : t('monitor.giveAccess')}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </>
  )
}
