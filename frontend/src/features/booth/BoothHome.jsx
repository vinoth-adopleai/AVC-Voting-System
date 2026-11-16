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
    if (!currentSelection.includes(candidateId) && currentSelection.length >= currentPosition.max_choices) {
      window.alert(`You can select only ${currentPosition.max_choices} candidate(s) for this position.`)
      return
    }
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
    if (screenIndex < positions.length - 1) setScreenIndex((index) => index + 1)
    else setReviewing(true)
  }

  const submitBallot = async () => {
    if (!window.confirm('Confirm and submit these choices? A submitted ballot cannot be changed.')) return
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
      <main className="booth-voting-screen booth-thank-you" aria-live="polite">
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
      <main className="booth-voting-screen">
        <header className="booth-ballot-header">
          <div className="brand-lockup">
            <span className="brand-mark brand-mark--small" aria-hidden="true"><span /></span>
            <span className="brand-copy"><strong>AVC Election</strong><small>{terminal.election.name}</small></span>
          </div>
          <span className="booth-step-badge">Review your choices</span>
        </header>
        <section className="booth-review-content">
          <p className="booth-language-label">உங்கள் தேர்வுகளை சரிபார்க்கவும்</p>
          <h1>Review your ballot</h1>
          <p className="booth-review-intro">Check your selections before you submit your ballot.</p>
          <div className="booth-review-list">
            {positions.map((position, index) => {
              const selectedIds = selections[position.id] || []
              const chosenCandidates = position.candidates.filter((candidate) => selectedIds.includes(candidate.id))
              return (
                <section className="booth-review-position" key={position.id}>
                  <div className="booth-review-position-heading">
                    <div><h2>{position.name_ta}</h2><p>{position.name_en}</p></div>
                    <button className="button button-secondary" type="button" onClick={() => { setScreenIndex(index); setReviewing(false) }}>
                      Edit
                    </button>
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
            <button className="button button-secondary" type="button" onClick={() => { setReviewing(false); setScreenIndex(positions.length - 1) }}>
              Back
            </button>
            <button className="button button-primary booth-submit-ballot" type="button" onClick={submitBallot} disabled={submitting}>
              {submitting ? 'Submitting ballot…' : 'Confirm and submit ballot'}
            </button>
          </div>
          {submitError && <p className="booth-error-banner" role="alert">{submitError}</p>}
        </section>
      </main>
    )
  }

  return (
    <main className="booth-voting-screen">
      <header className="booth-ballot-header">
        <div className="brand-lockup">
          <span className="brand-mark brand-mark--small" aria-hidden="true"><span /></span>
          <span className="brand-copy"><strong>AVC Election</strong><small>{terminal.election.name}</small></span>
        </div>
        <span className="booth-step-badge">Screen {screenIndex + 1} of 7</span>
      </header>

      <section className="booth-position-content" aria-labelledby="booth-position-title">
        <p className="booth-language-label">{currentPosition.name_ta}</p>
        <h1 id="booth-position-title">{currentPosition.name_en}</h1>
        <p className="booth-position-instruction">
          Select {currentPosition.max_choices} {currentPosition.max_choices === 1 ? 'candidate' : 'candidates'} for this position.
          <span> · இந்த பதவிக்கு {currentPosition.max_choices} வேட்பாளரைத் தேர்ந்தெடுக்கவும்.</span>
        </p>
        <div className="booth-candidate-grid">
          {currentPosition.candidates.map((candidate) => {
            const isSelected = currentSelection.includes(candidate.id)
            return (
              <button
                className={`booth-candidate-card${isSelected ? ' is-selected' : ''}`}
                key={candidate.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => toggleCandidate(candidate.id)}
              >
                <span className="booth-candidate-photo">
                  {candidate.photo_url
                    ? <img src={candidate.photo_url} alt="" />
                    : <span aria-hidden="true">{candidate.name_ta.slice(0, 1)}</span>}
                </span>
                <span className="booth-candidate-name-ta">{candidate.name_ta}</span>
                {candidate.name_en && <span className="booth-candidate-name-en">{candidate.name_en}</span>}
                <span className="booth-candidate-check" aria-hidden="true">{isSelected ? '✓' : ''}</span>
              </button>
            )
          })}
        </div>
      </section>

      <footer className="booth-ballot-footer">
        <div className="booth-ballot-count" aria-live="polite">
          <strong>{currentSelection.length} / {currentPosition.max_choices}</strong>
          <span>selected for this position · {selectedCount} / {terminal.election.ballot_total} choices</span>
        </div>
        <div className="booth-ballot-actions">
          {screenIndex > 0 && (
            <button className="button button-secondary" type="button" onClick={() => setScreenIndex((index) => index - 1)}>
              Back
            </button>
          )}
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
    </main>
  )
}
