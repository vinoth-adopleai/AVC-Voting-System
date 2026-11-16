import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { entryApi } from '../../api/entryApi.js'
import PageHeader from '../../components/ui/PageHeader.jsx'
import StatusBadge from '../../components/ui/StatusBadge.jsx'
import VoterPhoto from '../../components/ui/VoterPhoto.jsx'

const ENTRY_LOG_PAGE_SIZE = 8

function formatTime(value) {
  if (!value) return '—'
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value))
}

function canUndo(voter, now) {
  if (voter?.status !== 'ENTERED' || !voter.entered_at) return false
  const elapsed = now - new Date(voter.entered_at).getTime()
  return elapsed >= 0 && elapsed <= 60_000
}

export default function EntryHome() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const inputRef = useRef(null)
  const [serial, setSerial] = useState('')
  const [searchedSerial, setSearchedSerial] = useState('')
  const [lookup, setLookup] = useState(null)
  const [success, setSuccess] = useState('')
  const [now, setNow] = useState(Date.now())
  const [logPage, setLogPage] = useState(1)

  const logQuery = useQuery({
    queryKey: ['entry', 'my-log', logPage],
    queryFn: () => entryApi.getMyLog(logPage, ENTRY_LOG_PAGE_SIZE),
  })

  const searchMutation = useMutation({
    mutationFn: entryApi.findVoter,
    onSuccess: (result, searchedValue) => {
      const currentValue = inputRef.current?.value.trim() ?? ''
      if (currentValue.toLocaleLowerCase() !== searchedValue.toLocaleLowerCase()) return
      setLookup(result)
      setSearchedSerial(searchedValue)
      setSuccess('')
    },
  })

  const markMutation = useMutation({
    mutationFn: entryApi.markEntered,
    onSuccess: (voter) => {
      setSuccess(t('entry.markedSuccess', { name: voter.name, serial: voter.serial_no }))
      setSerial('')
      setSearchedSerial('')
      setLookup(null)
      setLogPage(1)
      searchMutation.reset()
      queryClient.invalidateQueries({ queryKey: ['entry', 'my-log'] })
      inputRef.current?.focus()
    },
  })

  const undoMutation = useMutation({
    mutationFn: entryApi.undoEntry,
    onSuccess: () => {
      setSuccess(t('entry.undoSuccess'))
      setLookup(null)
      setSearchedSerial('')
      queryClient.invalidateQueries({ queryKey: ['entry', 'my-log'] })
      inputRef.current?.focus()
    },
  })

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  function handleSearch(event) {
    event.preventDefault()
    const normalizedSerial = serial.trim()
    if (!normalizedSerial) return

    if (
      lookup?.voter
      && searchedSerial.toLocaleLowerCase() === normalizedSerial.toLocaleLowerCase()
      && lookup.voter.status === 'ELIGIBLE'
    ) {
      markMutation.mutate(lookup.voter.id)
      return
    }

    setSuccess('')
    setLookup(null)
    setSearchedSerial(normalizedSerial)
    searchMutation.mutate(normalizedSerial)
  }

  function handleSerialChange(value) {
    setSerial(value)
    if (value.trim().toLocaleLowerCase() !== searchedSerial.toLocaleLowerCase()) {
      setLookup(null)
      setSearchedSerial('')
      setSuccess('')
      searchMutation.reset()
      markMutation.reset()
      undoMutation.reset()
    }
  }

  const voter = lookup?.voter
  const logTotal = logQuery.data?.total ?? 0
  const logTotalPages = Math.max(1, Math.ceil(logTotal / ENTRY_LOG_PAGE_SIZE))
  const busy = searchMutation.isPending || markMutation.isPending
  const error = searchMutation.error || markMutation.error || undoMutation.error
  const errorMessage = error?.code === 'VOTING_NOT_STARTED'
    ? t('entry.votingNotStarted')
    : error?.code === 'VOTER_NOT_FOUND'
      ? t('entry.notOnList')
      : error?.code === 'ENTRY_UNDO_EXPIRED'
        ? t('entry.undoExpired')
        : error?.message

  useEffect(() => {
    if (logPage > logTotalPages) setLogPage(logTotalPages)
  }, [logPage, logTotalPages])

  return (
    <div className="entry-page">
      <PageHeader
        title={t('entry.title')}
        description={t('entry.description')}
        actions={logQuery.data?.election?.name ? <span className="entry-election-name">{logQuery.data.election.name}</span> : null}
      />

      <div className="entry-workspace">
        <section className="entry-checkin-card" aria-labelledby="entry-search-title">
          <div className="entry-card-heading">
            <div>
              <h2 id="entry-search-title">{t('entry.checkInTitle')}</h2>
              <p>{t('entry.checkInDescription')}</p>
            </div>
          </div>

          <form className="entry-search-form" onSubmit={handleSearch}>
            <label className="form-field" htmlFor="entry-serial">
              <span>{t('entry.serialLabel')}</span>
              <input
                autoComplete="off"
                autoCapitalize="characters"
                id="entry-serial"
                disabled={markMutation.isPending}
                maxLength={20}
                onChange={(event) => handleSerialChange(event.target.value)}
                placeholder={t('entry.serialPlaceholder')}
                ref={inputRef}
                required
                value={serial}
              />
            </label>
            <button className="button button-primary entry-search-button" disabled={busy || !serial.trim()} type="submit">
              {searchMutation.isPending ? t('entry.searching') : markMutation.isPending ? t('entry.marking') : voter?.status === 'ELIGIBLE' && searchedSerial.toLocaleLowerCase() === serial.trim().toLocaleLowerCase() ? t('entry.markButton') : t('entry.searchButton')}
            </button>
          </form>

          {errorMessage ? <p className="form-error entry-feedback" role="alert">{errorMessage}</p> : null}
          {success ? <p className="entry-success entry-feedback" role="status">{success}</p> : null}

          {voter ? (
            <article className="entry-voter-result" aria-live="polite">
              <div className="entry-voter-heading">
                <div className="entry-voter-identity">
                  <div className="entry-voter-serial-block">
                    <span>Serial number</span>
                    <strong>{voter.serial_no}</strong>
                  </div>
                  <h3>{voter.name}</h3>
                  <StatusBadge tone={voter.status === 'ELIGIBLE' ? 'success' : voter.status === 'VOTED' ? 'neutral' : 'warning'}>
                    {voter.status === 'ELIGIBLE' ? t('entry.readyToEnter') : voter.status === 'ENTERED' ? t('entry.alreadyEntered') : voter.status === 'VOTED' ? t('entry.alreadyVoted') : t('entry.atBooth')}
                  </StatusBadge>
                </div>
                <VoterPhoto className="entry-voter-photo" name={voter.name} photo={voter.photo} />
              </div>
              <dl className="entry-voter-details">
                {voter.father_husband_name ? <div><dt>{t('entry.fatherHusbandName')}</dt><dd>{voter.father_husband_name}</dd></div> : null}
                {voter.age ? <div><dt>{t('entry.age')}</dt><dd>{voter.age}</dd></div> : null}
                {voter.gender ? <div><dt>{t('entry.gender')}</dt><dd>{voter.gender === 'M' ? t('entry.male') : voter.gender === 'F' ? t('entry.female') : voter.gender}</dd></div> : null}
                {voter.address ? <div className="entry-address"><dt>{t('entry.address')}</dt><dd>{voter.address}</dd></div> : null}
                {voter.status === 'ENTERED' && voter.entered_at ? <div><dt>{t('entry.enteredAt')}</dt><dd>{formatTime(voter.entered_at)}</dd></div> : null}
              </dl>
            </article>
          ) : null}
        </section>

        <section className="entry-log-card" aria-labelledby="entry-log-title">
          <div className="entry-card-heading">
            <div>
              <h2 id="entry-log-title">{t('entry.recentEntries')}</h2>
              <p>{t('entry.recentEntriesDescription')}</p>
            </div>
            <span className="entry-log-count">{logTotal.toLocaleString()}</span>
          </div>
          {logQuery.isPending ? <p className="entry-empty-state" role="status">{t('entry.loadingEntries')}</p> : null}
          {logQuery.isError ? (
            <div className="entry-empty-state">
              <p className="form-error" role="alert">{logQuery.error.message}</p>
              <button className="button button-secondary" onClick={() => logQuery.refetch()} type="button">{t('entry.retry')}</button>
            </div>
          ) : null}
          {!logQuery.isPending && !logQuery.isError && !logQuery.data?.election ? (
            <p className="entry-empty-state">{t('entry.votingNotStarted')}</p>
          ) : null}
          {!logQuery.isPending && !logQuery.isError && logQuery.data?.election && !logQuery.data.items.length ? (
            <p className="entry-empty-state">{t('entry.noRecentEntries')}</p>
          ) : null}
          {logQuery.data?.items?.length ? (
            <>
              <div className="entry-log-list" aria-busy={logQuery.isFetching}>
                {logQuery.data.items.map((item) => (
                  <article className="entry-log-row" key={item.id}>
                    <div className="entry-log-voter">
                      <span className="entry-serial">{item.serial_no}</span>
                      <strong>{item.name}</strong>
                    </div>
                    <time dateTime={item.entered_at}>{formatTime(item.entered_at)}</time>
                    {canUndo(item, now) ? (
                      <button className="button button-secondary entry-undo-button" disabled={undoMutation.isPending} onClick={() => undoMutation.mutate(item.id)} type="button">
                        {t('entry.undoButton')}
                      </button>
                    ) : <span className="entry-log-status">{item.status === 'VOTED' ? t('entry.alreadyVoted') : item.status === 'BOOTH_ASSIGNED' ? t('entry.atBooth') : t('entry.enteredStatus')}</span>}
                  </article>
                ))}
              </div>
              {logTotalPages > 1 ? (
                <nav className="entry-pagination" aria-label="Entry history pagination">
                  <span>Page {logPage} of {logTotalPages}</span>
                  <div>
                    <button className="button button-secondary" disabled={logPage <= 1 || logQuery.isFetching} onClick={() => setLogPage((current) => current - 1)} type="button">Previous</button>
                    <button className="button button-secondary" disabled={logPage >= logTotalPages || logQuery.isFetching} onClick={() => setLogPage((current) => current + 1)} type="button">Next</button>
                  </div>
                </nav>
              ) : null}
            </>
          ) : null}
        </section>
      </div>
    </div>
  )
}
