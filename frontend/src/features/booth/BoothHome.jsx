import { useEffect, useMemo, useState } from 'react'

import { boothApi } from '../../api/boothApi.js'

const DEVICE_TOKEN_KEY = 'avc-voting-device-token'
const POLL_INTERVAL_MS = 2000

function readSavedToken() {
  try {
    return window.localStorage.getItem(DEVICE_TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

function errorMessage(error) {
  if (error?.code === 'DEVICE_TOKEN_REQUIRED' || error?.code === 'INVALID_DEVICE_TOKEN') {
    return 'This terminal token is invalid. Enter the voting system token again.'
  }
  if (error?.code === 'BALLOT_CONFIGURATION_INVALID') {
    return 'This election is not ready. Ask the administrator to configure seven positions and their vote limits.'
  }
  return error?.message || 'The voting terminal could not reach the server. Retrying…'
}

function selectionPayload(positions, selections) {
  return positions.map((position) => ({
    position_id: position.id,
    candidate_ids: selections[position.id] || [],
  }))
}

function RotationButton({ isRotated, onClick }) {
  return (
    <button className="booth-rotate-button" type="button" onClick={onClick}>
      <span aria-hidden="true">↻</span>
      {isRotated ? 'திரையை மீட்டமை' : 'திரையைச் சுழற்று'}
    </button>
  )
}

function ConfirmationDialog({ title, message, cancelLabel, confirmLabel, onCancel, onConfirm }) {
  return (
    <div className="booth-confirmation-backdrop">
      <section className="booth-confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="booth-confirmation-title">
        <h2 id="booth-confirmation-title">{title}</h2>
        <p>{message}</p>
        <div className="booth-confirmation-actions">
          {cancelLabel ? <button className="button button-secondary" type="button" onClick={onCancel}>{cancelLabel}</button> : null}
          <button className="button button-primary" type="button" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </section>
    </div>
  )
}

export default function BoothHome() {
  const [deviceToken, setDeviceToken] = useState(readSavedToken)
  const [tokenDraft, setTokenDraft] = useState('')
  const [showTokenSetup, setShowTokenSetup] = useState(!readSavedToken())
  const [terminal, setTerminal] = useState(null)
  const [connectionError, setConnectionError] = useState('')
  const [screenIndex, setScreenIndex] = useState(0)
  const [reviewing, setReviewing] = useState(false)
  const [selections, setSelections] = useState({})
  const [submissionKey, setSubmissionKey] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [thankYou, setThankYou] = useState(false)
  const [lockedPositionIds, setLockedPositionIds] = useState(() => new Set())
  const [confirmingPositionExit, setConfirmingPositionExit] = useState(false)
  const [confirmingSubmit, setConfirmingSubmit] = useState(false)
  const [isRotated, setIsRotated] = useState(false)
  const [limitNotice, setLimitNotice] = useState('')

  const positions = terminal?.positions || []
  const currentPosition = positions[screenIndex]
  const currentSelection = currentPosition ? (selections[currentPosition.id] || []) : []
  const selectedCount = useMemo(
    () => Object.values(selections).reduce((total, ids) => total + ids.length, 0),
    [selections],
  )

  useEffect(() => {
    try {
      if (deviceToken) window.localStorage.setItem(DEVICE_TOKEN_KEY, deviceToken)
      else window.localStorage.removeItem(DEVICE_TOKEN_KEY)
    } catch {
      // The device token remains available for this page session if storage is blocked.
    }
  }, [deviceToken])

  useEffect(() => {
    if (!deviceToken || thankYou) return undefined
    let stopped = false
    let timerId

    const poll = async () => {
      try {
        const response = await boothApi.getSession(deviceToken)
        if (stopped) return
        setConnectionError('')
        setTerminal(response.state === 'BALLOT' ? response : null)
        if (response.state !== 'BALLOT') timerId = window.setTimeout(poll, POLL_INTERVAL_MS)
      } catch (error) {
        if (stopped) return
        setConnectionError(errorMessage(error))
        setTerminal(null)
        timerId = window.setTimeout(poll, POLL_INTERVAL_MS * 2)
      }
    }

    poll()
    return () => {
      stopped = true
      window.clearTimeout(timerId)
    }
  }, [deviceToken, thankYou])

  useEffect(() => {
    if (!thankYou) return undefined
    const timerId = window.setTimeout(() => {
      setThankYou(false)
      setSelections({})
      setTerminal(null)
      setScreenIndex(0)
      setReviewing(false)
      setSubmissionKey('')
      setSubmitError('')
      setLockedPositionIds(new Set())
      setConfirmingPositionExit(false)
      setConfirmingSubmit(false)
      setLimitNotice('')
    }, 5000)
    return () => window.clearTimeout(timerId)
  }, [thankYou])

  const saveToken = (event) => {
    event.preventDefault()
    const nextToken = tokenDraft.trim()
    if (!nextToken) return
    setDeviceToken(nextToken)
    setTokenDraft('')
    setTerminal(null)
    setConnectionError('')
    setShowTokenSetup(false)
  }

  const toggleCandidate = (candidateId) => {
    if (!currentPosition) return
    if (lockedPositionIds.has(currentPosition.id)) return
    if (!currentSelection.includes(candidateId) && currentSelection.length >= currentPosition.max_choices) {
      setLimitNotice(`இந்தப் பதவிக்கு அதிகபட்சம் ${currentPosition.max_choices} வேட்பாளர்களை மட்டுமே தேர்ந்தெடுக்கலாம்.`)
      return
    }
    setLimitNotice('')
    setSelections((previous) => {
      const selected = previous[currentPosition.id] || []
      const nextSelected = selected.includes(candidateId)
        ? selected.filter((id) => id !== candidateId)
        : [...selected, candidateId]
      return { ...previous, [currentPosition.id]: nextSelected }
    })
    setSubmitError('')
  }

  const continueToNext = () => {
    if (!currentPosition || currentSelection.length !== currentPosition.max_choices) return
    if (lockedPositionIds.has(currentPosition.id)) {
      if (screenIndex < positions.length - 1) setScreenIndex((index) => index + 1)
      else setReviewing(true)
      return
    }
    setConfirmingPositionExit(true)
  }

  const confirmPositionExit = () => {
    setLockedPositionIds((previous) => new Set(previous).add(currentPosition.id))
    setConfirmingPositionExit(false)
    if (screenIndex < positions.length - 1) setScreenIndex((index) => index + 1)
    else setReviewing(true)
  }

  const submitBallot = async () => {
    const key = submissionKey || window.crypto.randomUUID()
    setSubmissionKey(key)
    setSubmitting(true)
    setSubmitError('')
    try {
      await boothApi.submitBallot(deviceToken, {
        idempotency_key: key,
        selections: selectionPayload(positions, selections),
      })
      setThankYou(true)
    } catch (error) {
      setSubmitError(errorMessage(error))
    } finally {
      setSubmitting(false)
    }
  }

  if (thankYou) {
    return (
      <main className={`booth-voting-screen booth-thank-you${isRotated ? ' is-rotated' : ''}`} aria-live="polite">
        <div className="booth-success-mark" aria-hidden="true">✓</div>
        <p className="booth-language-label">நன்றி</p>
        <h1>Thank you for voting</h1>
        <p>Your ballot has been submitted securely.</p>
      </main>
    )
  }

  if (!terminal) {
    return (
      <main className="booth-locked-screen">
        <div className="booth-topline">
          <span className="brand-mark brand-mark--small" aria-hidden="true"><span /></span>
          <span>AVC Election · Voting terminal</span>
        </div>
        <div className="booth-locked-content">
          <span className="booth-wait-icon" aria-hidden="true"><span /></span>
          <p className="booth-language-label">தமிழ்</p>
          <h1>Waiting for voter</h1>
          <p>This screen will open when a booth officer assigns a voter.</p>
          <div className="booth-device-status" role="status">
            <span className={`device-status-light${connectionError ? ' is-error' : ''}`} aria-hidden="true" />
            <span>{connectionError || (deviceToken ? 'Terminal connected · waiting for assignment' : 'Voting system setup required')}</span>
          </div>
          {!deviceToken || showTokenSetup ? (
            <form className="booth-token-form" onSubmit={saveToken}>
              <label className="form-field">
                Voting system token
                <input
                  type="password"
                  autoComplete="off"
                  value={tokenDraft}
                  onChange={(event) => setTokenDraft(event.target.value)}
                  placeholder="Paste the token created for this system"
                  required
                />
              </label>
              <button className="button button-primary" type="submit">Connect this terminal</button>
            </form>
          ) : (
            <button className="booth-token-change" type="button" onClick={() => setShowTokenSetup(true)}>
              Change device token
            </button>
          )}
        </div>
      </main>
    )
  }

  if (positions.length !== 7) {
    return (
      <main className="booth-voting-screen">
        <p className="booth-error-banner">This election is not configured with seven voting positions. Please contact the administrator.</p>
      </main>
    )
  }

  if (reviewing) {
    return (
      <main className={`booth-voting-screen${isRotated ? ' is-rotated' : ''}`}>
        <header className="booth-ballot-header">
          <div className="booth-header-brand-group">
            <div className="brand-lockup">
              <span className="brand-mark brand-mark--small" aria-hidden="true"><span /></span>
              <span className="brand-copy"><strong>AVC Election</strong><small>{terminal.election.name}</small></span>
            </div>
          </div>
          <div className="booth-header-actions">
            <RotationButton isRotated={isRotated} onClick={() => setIsRotated((rotated) => !rotated)} />
            <span className="booth-step-badge">Review your choices</span>
          </div>
        </header>
        <section className="booth-review-content">
          <p className="booth-language-label">உங்கள் தேர்வுகளை சரிபார்க்கவும்</p>
          <h1>Review your ballot</h1>
          <p className="booth-review-intro">Check your selections before you submit your ballot.</p>
          <div className="booth-review-list">
            {positions.map((position) => {
              const selectedIds = selections[position.id] || []
              const chosenCandidates = position.candidates.filter((candidate) => selectedIds.includes(candidate.id))
              return (
                <section className="booth-review-position" key={position.id}>
                  <div className="booth-review-position-heading">
                    <div><h2>{position.name_ta}</h2><p>{position.name_en}</p></div>
                  </div>
                  <ul>
                    {chosenCandidates.map((candidate) => (
                      <li key={candidate.id}>{candidate.name_ta}{candidate.name_en ? ` · ${candidate.name_en}` : ''}</li>
                    ))}
                  </ul>
                </section>
              )
            })}
          </div>
          <div className="booth-review-actions">
            <button className="button button-primary booth-submit-ballot" type="button" onClick={() => setConfirmingSubmit(true)} disabled={submitting}>
              {submitting ? 'Submitting ballot…' : 'Submit ballot'}
            </button>
          </div>
          {submitError && <p className="booth-error-banner" role="alert">{submitError}</p>}
        </section>
        {confirmingSubmit ? (
          <ConfirmationDialog
            title="வாக்குச் சீட்டைச் சமர்ப்பிக்கவா?"
            message="சமர்ப்பித்த பிறகு உங்கள் வாக்குகளை மாற்ற முடியாது."
            cancelLabel="ரத்து செய்"
            confirmLabel="சமர்ப்பி"
            onCancel={() => setConfirmingSubmit(false)}
            onConfirm={() => {
              setConfirmingSubmit(false)
              submitBallot()
            }}
          />
        ) : null}
        {limitNotice ? (
          <ConfirmationDialog
            title="தேர்வு வரம்பு"
            message={limitNotice}
            confirmLabel="சரி"
            onConfirm={() => setLimitNotice('')}
          />
        ) : null}
      </main>
    )
  }

  return (
    <main className={`booth-voting-screen${isRotated ? ' is-rotated' : ''}`}>
      <header className="booth-ballot-header">
        <div className="booth-header-brand-group">
          <div className="brand-lockup">
            <span className="brand-mark brand-mark--small" aria-hidden="true"><span /></span>
            <span className="brand-copy"><strong>AVC Election</strong><small>{terminal.election.name}</small></span>
          </div>
        </div>
        <div className="booth-header-actions">
          <RotationButton isRotated={isRotated} onClick={() => setIsRotated((rotated) => !rotated)} />
          <span className="booth-step-badge">Screen {screenIndex + 1} of 7</span>
        </div>
      </header>

      <section className="booth-position-content" aria-labelledby="booth-position-title">
        <h1 id="booth-position-title">{currentPosition.name_ta}</h1>
        <p className="booth-position-instruction">
          இந்தப் பதவிக்கு {currentPosition.max_choices} வேட்பாளரைத் தேர்ந்தெடுக்கவும்.
        </p>
        <div className="booth-candidate-table" role="table" aria-label={currentPosition.name_ta}>
          <div className="booth-candidate-table-header" role="row">
            <span role="columnheader">No.</span>
            <span role="columnheader">Photo</span>
            <span role="columnheader">Name</span>
            <span role="columnheader">Position</span>
            <span role="columnheader">Vote</span>
          </div>
          <div role="rowgroup">
          {currentPosition.candidates.map((candidate, index) => {
            const isSelected = currentSelection.includes(candidate.id)
            const isAtLimit = currentSelection.length >= currentPosition.max_choices
            return (
              <div
                className={`booth-candidate-table-row${isSelected ? ' is-selected' : ''}${!isSelected && isAtLimit ? ' is-limit-reached' : ''}`}
                key={candidate.id}
                role="row"
                aria-selected={isSelected}
                aria-disabled={lockedPositionIds.has(currentPosition.id) || (!isSelected && isAtLimit)}
                tabIndex={lockedPositionIds.has(currentPosition.id) || (!isSelected && isAtLimit) ? -1 : 0}
                onClick={() => toggleCandidate(candidate.id)}
                onKeyDown={(event) => {
                  if (event.currentTarget !== event.target) return
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    toggleCandidate(candidate.id)
                  }
                }}
              >
                <span className="booth-candidate-number" data-label="No." role="cell">{String(index + 1).padStart(2, '0')}</span>
                <span className="booth-candidate-row-photo" data-label="Photo" role="cell">
                  {candidate.photo_url
                    ? <img src={candidate.photo_url} alt="" />
                    : <span aria-hidden="true">{candidate.name_ta.slice(0, 1)}</span>}
                </span>
                <span className="booth-candidate-row-name" data-label="Name" role="cell">
                  <strong>{candidate.name_ta}</strong>
                </span>
                <span className="booth-candidate-row-position" data-label="Position" role="cell">{currentPosition.name_ta}</span>
                <span className="booth-candidate-vote-cell" data-label="Vote" role="cell">
                  <button
                    className={`booth-candidate-vote-button${isSelected ? ' is-selected' : ''}`}
                    type="button"
                    aria-pressed={isSelected}
                    disabled={lockedPositionIds.has(currentPosition.id) || (!isSelected && isAtLimit)}
                    onClick={(event) => {
                      event.stopPropagation()
                      toggleCandidate(candidate.id)
                    }}
                  >
                    {isSelected ? 'தேர்வு ✓' : 'வாக்களி'}
                  </button>
                </span>
              </div>
            )
          })}
          </div>
        </div>
      </section>

      <footer className="booth-ballot-footer">
        <div className="booth-ballot-count" aria-live="polite">
          <strong>{currentSelection.length} / {currentPosition.max_choices}</strong>
          <span>selected for this position · {selectedCount} / {terminal.election.ballot_total} choices</span>
        </div>
        <div className="booth-ballot-actions">
          <button
            className="button button-primary booth-next-button"
            type="button"
            disabled={currentSelection.length !== currentPosition.max_choices}
            onClick={continueToNext}
          >
            {screenIndex === positions.length - 1 ? 'Review ballot' : 'Next position'} <span aria-hidden="true">→</span>
          </button>
        </div>
      </footer>
      {confirmingPositionExit ? (
        <ConfirmationDialog
          title="தேர்வை உறுதிப்படுத்தவும்"
          message="இந்தப் பக்கத்தை விட்டு வெளியேறிய பிறகு, இந்தத் தேர்வை மீண்டும் மாற்ற முடியாது."
          cancelLabel="திரும்பிச் செல்"
          confirmLabel="உறுதிசெய்து தொடரவும்"
          onCancel={() => setConfirmingPositionExit(false)}
          onConfirm={confirmPositionExit}
        />
      ) : null}
      {limitNotice ? (
        <ConfirmationDialog
          title="தேர்வு வரம்பு"
          message={limitNotice}
          confirmLabel="சரி"
          onConfirm={() => setLimitNotice('')}
        />
      ) : null}
    </main>
  )
}
