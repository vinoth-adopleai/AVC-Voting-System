import { useEffect, useMemo, useState } from 'react'

import { boothApi } from '../../api/boothApi.js'
import agaramMahalImage from '../../logo/agaram_mahal.jpg'
import thankYouImage from '../../logo/thankyou.avif'

const DEVICE_TOKEN_KEY = 'avc-voting-device-token'
const POLL_INTERVAL_MS = 2000
const TAMIL_CHOICE_WORDS = ['', 'ஒரு', 'இரண்டு', 'மூன்று', 'நான்கு', 'ஐந்து']

function tamilChoiceWord(count) {
  return TAMIL_CHOICE_WORDS[count] || String(count)
}

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

function BallotHeader() {
  const electionDay = new Intl.DateTimeFormat('ta-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(new Date())

  return (
    <header className="booth-ballot-header">
      <img className="booth-voting-logo" src={agaramMahalImage} alt="அகரம் மகால்" />
      <div className="booth-voting-masthead">
        <h2>அகரம் வெள்ளாஞ்செட்டியார் சங்கம்</h2>
        <p>பதிவு எண் : S. 14/1957 அகரமகால், அன்னதானப்பட்டி, சேலம் - 636 002</p>
        <p>தேர்தல் நாள் : {electionDay}</p>
      </div>
    </header>
  )
}

function BallotCornerControls({ isRotated, onRotate, onBack, backDisabled = false }) {
  return (
    <>
      <button
        aria-label="முந்தைய பதவிக்குச் செல்லவும்"
        className="booth-corner-hotspot booth-back-hotspot"
        disabled={backDisabled}
        onClick={onBack}
        type="button"
      />
      <button
        aria-label={isRotated ? 'திரையை மீட்டமை' : 'திரையைச் சுழற்று'}
        className="booth-corner-hotspot booth-rotate-hotspot"
        onClick={onRotate}
        type="button"
      />
    </>
  )
}

function ConfirmationDialog({ title, message, confirmLabel, onConfirm }) {
  return (
    <div className="booth-confirmation-backdrop">
      <section className="booth-confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="booth-confirmation-title">
        <h2 id="booth-confirmation-title">{title}</h2>
        <p>{message}</p>
        <div className="booth-confirmation-actions">
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
  const currentYear = Number(new Intl.DateTimeFormat('en', {
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(new Date()))
  const isCommitteePosition = currentPosition?.max_choices === 5
  const currentPositionName = currentPosition?.name_ta?.trim() || ''
  const committeeHeadingName = currentPositionName.endsWith('தொகுதி')
    ? currentPositionName
    : `${currentPositionName} தொகுதி`
  const positionHeading = currentPosition
    ? `${currentYear}-${currentYear + 3} ${isCommitteePosition ? committeeHeadingName : `${currentPositionName} பதவிக்கு`}`
    : ''
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
      setLimitNotice(`இந்தப் பதவிக்கு அதிகபட்சம் ${tamilChoiceWord(currentPosition.max_choices)} வேட்பாளர்களை மட்டுமே தேர்ந்தெடுக்கலாம்.`)
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
    if (screenIndex === positions.length - 1) {
      setConfirmingSubmit(true)
      return
    }
    if (lockedPositionIds.has(currentPosition.id)) {
      setScreenIndex((index) => index + 1)
      return
    }
    setConfirmingPositionExit(true)
  }

  const confirmPositionExit = () => {
    setLockedPositionIds((previous) => new Set(previous).add(currentPosition.id))
    setConfirmingPositionExit(false)
    setScreenIndex((index) => Math.min(positions.length - 1, index + 1))
  }

  const navigateBack = () => {
    if (screenIndex <= 0) return
    const previousPosition = positions[screenIndex - 1]
    if (previousPosition) {
      setLockedPositionIds((previous) => {
        const next = new Set(previous)
        next.delete(previousPosition.id)
        return next
      })
    }
    setScreenIndex((index) => Math.max(0, index - 1))
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
        <img className="booth-thank-you-image" src={thankYouImage} alt="" />
        <h1>வாக்களித்தமைக்கு நன்றி</h1>
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

  return (
    <main className={`booth-voting-screen${isRotated ? ' is-rotated' : ''}`}>
      <BallotHeader />
      <BallotCornerControls
        isRotated={isRotated}
        onRotate={() => setIsRotated((rotated) => !rotated)}
        onBack={navigateBack}
        backDisabled={screenIndex === 0}
      />

      <section className="booth-position-content" aria-labelledby="booth-position-title">
        <h1
          className="booth-position-title--term"
          id="booth-position-title"
        >
          {positionHeading}
        </h1>
        {isCommitteePosition ? <p className="booth-position-category">நிர்வாக குழு உறுப்பினர்கள்</p> : null}
        <p className="booth-position-instruction">
          இந்தப் பதவிக்கு <strong className="booth-instruction-emphasis">{tamilChoiceWord(currentPosition.max_choices)}</strong>{' '}
          {currentPosition.max_choices === 1 ? 'வேட்பாளரை' : 'வேட்பாளர்களை'} தேர்ந்தெடுக்கவும்.
        </p>
        <div className="booth-candidate-table" role="table" aria-label={currentPosition.name_ta}>
          <div className="booth-candidate-table-header" role="row">
            <span role="columnheader">வரிசை எண்</span>
            <span role="columnheader">வேட்பாளர்களின் பெயர்</span>
            <span role="columnheader">புகைப்படம்</span>
            <span role="columnheader">வாக்களிக்க</span>
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
                <span className="booth-candidate-number" data-label="வரிசை எண்" role="cell">{String(index + 1).padStart(2, '0')}</span>
                <span className="booth-candidate-row-name" data-label="வேட்பாளர்களின் பெயர்" role="cell">
                  <strong>{candidate.name_ta}</strong>
                </span>
                <span className="booth-candidate-row-photo" data-label="புகைப்படம்" role="cell">
                  {candidate.photo_url
                    ? <img src={candidate.photo_url} alt="" />
                    : <span aria-hidden="true">{candidate.name_ta.slice(0, 1)}</span>}
                </span>
                <span className="booth-candidate-vote-cell" data-label="வாக்களிக்க" role="cell">
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
                    {isSelected ? 'தேர்ந்தெடுத்தது ✓' : 'வாக்களி'}
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
          <strong>{currentSelection.length} / {tamilChoiceWord(currentPosition.max_choices)}</strong>
          <span>இந்தப் பதவியில் தேர்ந்தெடுத்தவை · {selectedCount} / {terminal.election.ballot_total} தேர்வுகள்</span>
        </div>
        <div className="booth-ballot-actions">
          <button
            className="button button-primary booth-next-button"
            type="button"
            disabled={currentSelection.length !== currentPosition.max_choices || submitting}
            onClick={continueToNext}
          >
            {screenIndex === positions.length - 1
              ? submitting ? 'Submitting ballot…' : 'Submit ballot'
              : 'Next position'} <span aria-hidden="true">→</span>
          </button>
        </div>
      </footer>
      {submitError ? <p className="booth-error-banner" role="alert">{submitError}</p> : null}
      {confirmingPositionExit ? (
        <ConfirmationDialog
          title="தேர்வை உறுதிப்படுத்தவும்"
          message="இந்தப் பக்கத்தை விட்டு வெளியேறிய பிறகு, இந்தத் தேர்வை மீண்டும் மாற்ற முடியாது."
          confirmLabel="உறுதிசெய்து தொடரவும்"
          onConfirm={confirmPositionExit}
        />
      ) : null}
      {confirmingSubmit ? (
        <ConfirmationDialog
          title="வாக்குச் சீட்டைச் சமர்ப்பிக்கவா?"
          message="சமர்ப்பித்த பிறகு உங்கள் வாக்குகளை மாற்ற முடியாது."
          confirmLabel={submitting ? 'சமர்ப்பிக்கிறது…' : 'சமர்ப்பி'}
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
