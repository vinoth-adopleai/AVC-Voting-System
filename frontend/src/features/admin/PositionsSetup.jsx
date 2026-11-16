import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'

import { adminApi } from '../../api/adminApi.js'

function nextPositionOrder(positions) {
  const usedOrders = new Set(positions.map((position) => position.display_order))
  return Array.from({ length: 7 }, (_, index) => index + 1)
    .find((slot) => !usedOrders.has(slot)) ?? null
}

export default function PositionsSetup() {
  const queryClient = useQueryClient()
  const [selectedElectionId, setSelectedElectionId] = useState('')
  const [nameTa, setNameTa] = useState('')
  const [nameEn, setNameEn] = useState('')
  const [minChoices, setMinChoices] = useState('1')
  const [maxChoices, setMaxChoices] = useState('1')
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [editingPosition, setEditingPosition] = useState(null)
  const [successMessage, setSuccessMessage] = useState('')
  const createDialogRef = useRef(null)

  const electionsQuery = useQuery({
    queryKey: ['admin', 'elections'],
    queryFn: adminApi.getElections,
  })
  const elections = electionsQuery.data ?? []
  const selectedElection = useMemo(
    () => elections.find((election) => String(election.id) === selectedElectionId),
    [elections, selectedElectionId],
  )

  useEffect(() => {
    if (!selectedElectionId && elections.length) {
      setSelectedElectionId(String(elections[0].id))
    }
  }, [elections, selectedElectionId])

  const positionsQuery = useQuery({
    queryKey: ['admin', 'positions', selectedElectionId],
    queryFn: () => adminApi.getPositions(selectedElectionId),
    enabled: Boolean(selectedElectionId),
  })
  const positions = positionsQuery.data?.positions ?? []
  const nextOrder = nextPositionOrder(positions)

  useEffect(() => {
    setMinChoices('1')
    setMaxChoices(nextOrder && nextOrder <= 3 ? '1' : '5')
  }, [selectedElectionId, nextOrder])

  useEffect(() => {
    const dialog = createDialogRef.current
    if (!dialog) return
    if (isCreateOpen && !dialog.open) dialog.showModal()
    if (!isCreateOpen && dialog.open) dialog.close()
  }, [isCreateOpen])

  const addMutation = useMutation({
    mutationFn: adminApi.addPosition,
    onSuccess: () => {
      setNameTa('')
      setNameEn('')
      setSuccessMessage('Position added.')
      setEditingPosition(null)
      setIsCreateOpen(false)
      queryClient.invalidateQueries({ queryKey: ['admin', 'positions', selectedElectionId] })
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ positionId, payload }) => adminApi.updatePosition(positionId, payload),
    onSuccess: () => {
      setSuccessMessage('Position updated.')
      setEditingPosition(null)
      setIsCreateOpen(false)
      queryClient.invalidateQueries({ queryKey: ['admin', 'positions', selectedElectionId] })
    },
  })

  function handleSubmit(event) {
    event.preventDefault()
    const payload = {
      name_ta: nameTa.trim(),
      name_en: nameEn.trim(),
      min_choices: Number(minChoices),
      max_choices: Number(maxChoices),
    }
    if (editingPosition) {
      updateMutation.mutate({ positionId: editingPosition.id, payload })
    } else {
      addMutation.mutate({ election_id: Number(selectedElectionId), ...payload })
    }
  }

  function openCreateForm() {
    addMutation.reset()
    updateMutation.reset()
    setEditingPosition(null)
    setNameEn('')
    setNameTa('')
    setMinChoices('1')
    setMaxChoices(nextOrder && nextOrder <= 3 ? '1' : '5')
    setSuccessMessage('')
    setIsCreateOpen(true)
  }

  function openUpdateForm(position) {
    addMutation.reset()
    updateMutation.reset()
    setEditingPosition(position)
    setNameEn(position.name_en)
    setNameTa(position.name_ta)
    setMinChoices(String(position.min_choices))
    setMaxChoices(String(position.max_choices))
    setSuccessMessage('')
    setIsCreateOpen(true)
  }

  if (electionsQuery.isPending) {
    return <section className="positions-setup-card" role="status">Loading elections…</section>
  }

  if (electionsQuery.isError) {
    return (
      <section className="positions-setup-card">
        <p className="form-error" role="alert">{electionsQuery.error.message}</p>
        <button className="button button-primary" onClick={() => electionsQuery.refetch()} type="button">
          Retry
        </button>
      </section>
    )
  }

  if (!elections.length) {
    return (
      <section className="positions-setup-card">
        <p className="positions-notice">
          Create an election before adding positions. <Link to="/admin/election">Go to Election setup</Link>
        </p>
      </section>
    )
  }

  if (positionsQuery.isPending) {
    return <section className="positions-setup-card" role="status">Loading positions…</section>
  }

  if (positionsQuery.isError) {
    return (
      <section className="positions-setup-card">
        <p className="form-error" role="alert">{positionsQuery.error.message}</p>
        <button className="button button-primary" onClick={() => positionsQuery.refetch()} type="button">
          Retry
        </button>
      </section>
    )
  }

  const electionStatus = positionsQuery.data?.election_status ?? selectedElection?.status
  const isLocked = electionStatus !== 'DRAFT'

  return (
    <div className="positions-setup-layout">
      <section className="positions-list-card" aria-labelledby="positions-list-title">
        <div className="positions-list-heading">
          <div>
            <h2 id="positions-list-title">Positions for {selectedElection?.name}</h2>
          </div>
          <div className="positions-list-toolbar">
            <label className="positions-election-picker" htmlFor="position-election-picker">
              <span>Election</span>
              <select
                id="position-election-picker"
                onChange={(event) => {
                  setSelectedElectionId(event.target.value)
                  setSuccessMessage('')
                  addMutation.reset()
                  updateMutation.reset()
                }}
                value={selectedElectionId}
              >
                {elections.map((election) => (
                  <option key={election.id} value={election.id}>
                    {election.name}
                  </option>
                ))}
              </select>
            </label>
            <span className="positions-count-badge">{positions.length} / 7 added</span>
            <button
              className="button button-primary positions-add-button"
              disabled={isLocked || nextOrder === null}
              onClick={openCreateForm}
              type="button"
            >
              Add position
            </button>
          </div>
        </div>

        {isLocked ? (
          <div className="positions-notice" role="status">Position setup is locked because this election is {electionStatus.toLowerCase()}.</div>
        ) : null}
        {nextOrder === null ? (
          <div className="positions-notice" role="status">All seven positions have been added to this election.</div>
        ) : null}
        {successMessage ? <p className="positions-success" role="status">{successMessage}</p> : null}

        {positions.length ? (
          <>
          <div className="admin-list-header position-list-header" aria-hidden="true">
            <span>No.</span>
            <span>Position</span>
            <span>Vote limit</span>
            <span>Action</span>
          </div>
          <ol className="positions-list">
            {positions
              .slice()
              .sort((left, right) => left.display_order - right.display_order)
              .map((position, index) => (
                <li className="position-list-item admin-list-row" key={position.id}>
                  <span className="position-order">{String(index + 1).padStart(2, '0')}</span>
                  <div className="position-list-name">
                    <strong>{position.name_en}</strong>
                    <span className="position-name-separator" aria-hidden="true">-</span>
                    <span lang="ta" dir="auto">{position.name_ta}</span>
                  </div>
                  <span className="position-choice-limit">
                    {position.min_choices === position.max_choices
                      ? `${position.max_choices} vote${position.max_choices === 1 ? '' : 's'}`
                      : `${position.min_choices}–${position.max_choices} votes`}
                  </span>
                  <button
                    aria-label={`Update ${position.name_en}`}
                    className="button button-secondary position-update-button"
                    disabled={isLocked}
                    onClick={() => openUpdateForm(position)}
                    type="button"
                  >
                    Update
                  </button>
                </li>
              ))}
          </ol>
          </>
        ) : (
          <p className="positions-empty-state">No positions yet. Add the first position above.</p>
        )}
      </section>

      <dialog
        className="position-create-dialog"
        onCancel={(event) => {
          event.preventDefault()
          setIsCreateOpen(false)
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) setIsCreateOpen(false)
        }}
        ref={createDialogRef}
      >
        <form className="position-create-form" onSubmit={handleSubmit}>
          <div className="position-create-heading">
            <div>
              <p className="eyebrow">{editingPosition ? `POSITION ${String(editingPosition.display_order).padStart(2, '0')}` : `POSITION ${String(nextOrder).padStart(2, '0')} OF 7`}</p>
              <h2>{editingPosition ? 'Update Election position' : 'Add Election position'}</h2>
            </div>
            <button aria-label="Close position form" className="position-create-close" onClick={() => setIsCreateOpen(false)} type="button">×</button>
          </div>

          <div className="position-create-context">
            <span>{editingPosition ? 'Updating in' : 'Adding to'}</span>
            <strong>{selectedElection?.name}</strong>
          </div>

          <div className="position-create-names">
            <label className="form-field" htmlFor="position-name-en">
              <span className="position-required">Position name (English)</span>
              <input
                autoComplete="off"
                autoFocus
                id="position-name-en"
                maxLength={120}
                onChange={(event) => setNameEn(event.target.value)}
                placeholder="For example, President"
                required
                value={nameEn}
              />
            </label>
            <label className="form-field" htmlFor="position-name-ta">
              <span className="position-required">Position name (Tamil)</span>
              <input
                autoComplete="off"
                id="position-name-ta"
                lang="ta"
                maxLength={120}
                onChange={(event) => setNameTa(event.target.value)}
                placeholder="Enter the position name in Tamil"
                required
                value={nameTa}
              />
            </label>
          </div>

          <fieldset className="position-vote-limits">
            <legend>Vote limits</legend>
            <label className="form-field" htmlFor="position-min-choices">
              <span className="position-required">Minimum votes</span>
              <input
                id="position-min-choices"
                max={maxChoices || 5}
                min="1"
                onChange={(event) => setMinChoices(event.target.value)}
                required
                type="number"
                value={minChoices}
              />
            </label>
            <label className="form-field" htmlFor="position-max-choices">
              <span className="position-required">Maximum votes</span>
              <input
                id="position-max-choices"
                max="5"
                min={minChoices || 1}
                onChange={(event) => setMaxChoices(event.target.value)}
                required
                type="number"
                value={maxChoices}
              />
            </label>
          </fieldset>

          {editingPosition && updateMutation.isError ? <p className="form-error" role="alert">{updateMutation.error.message}</p> : null}
          {!editingPosition && addMutation.isError ? <p className="form-error" role="alert">{addMutation.error.message}</p> : null}
          <div className="position-create-actions">
            <button className="button button-secondary" onClick={() => setIsCreateOpen(false)} type="button">Cancel</button>
            <button className="button button-primary positions-add-button" disabled={addMutation.isPending || updateMutation.isPending} type="submit">
              {updateMutation.isPending ? 'Updating…' : addMutation.isPending ? 'Adding…' : editingPosition ? 'Update position' : 'Add position'}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  )
}
