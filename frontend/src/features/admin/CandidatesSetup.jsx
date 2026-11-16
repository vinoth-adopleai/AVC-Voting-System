import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'

import { adminApi } from '../../api/adminApi.js'
import StatusBadge from '../../components/ui/StatusBadge.jsx'

export default function CandidatesSetup() {
  const queryClient = useQueryClient()
  const [selectedElectionId, setSelectedElectionId] = useState('')
  const [selectedPositionId, setSelectedPositionId] = useState('')
  const [nameTa, setNameTa] = useState('')
  const [nameEn, setNameEn] = useState('')
  const [photoFile, setPhotoFile] = useState(null)
  const [photoPreview, setPhotoPreview] = useState('')
  const photoInputRef = useRef(null)
  const [isAddOpen, setIsAddOpen] = useState(false)
  const addDialogRef = useRef(null)
  const [editingCandidate, setEditingCandidate] = useState(null)
  const [editPositionId, setEditPositionId] = useState('')
  const [editNameTa, setEditNameTa] = useState('')
  const [editNameEn, setEditNameEn] = useState('')
  const [editPhotoFile, setEditPhotoFile] = useState(null)
  const [removeEditPhoto, setRemoveEditPhoto] = useState(false)
  const [editPhotoPreview, setEditPhotoPreview] = useState('')
  const editPhotoInputRef = useRef(null)
  const editDialogRef = useRef(null)

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
  const selectedPosition = positions.find((position) => String(position.id) === selectedPositionId)

  useEffect(() => {
    if (!positions.some((position) => String(position.id) === selectedPositionId)) {
      setSelectedPositionId(positions.length ? String(positions[0].id) : '')
    }
  }, [positions, selectedPositionId])

  useEffect(() => {
    if (!photoFile) {
      setPhotoPreview('')
      return undefined
    }
    const previewUrl = URL.createObjectURL(photoFile)
    setPhotoPreview(previewUrl)
    return () => URL.revokeObjectURL(previewUrl)
  }, [photoFile])

  useEffect(() => {
    if (!editPhotoFile) {
      setEditPhotoPreview('')
      return undefined
    }
    const previewUrl = URL.createObjectURL(editPhotoFile)
    setEditPhotoPreview(previewUrl)
    return () => URL.revokeObjectURL(previewUrl)
  }, [editPhotoFile])

  useEffect(() => {
    const dialog = addDialogRef.current
    if (!dialog) return
    if (isAddOpen && !dialog.open) dialog.showModal()
    if (!isAddOpen && dialog.open) dialog.close()
  }, [isAddOpen])

  useEffect(() => {
    const dialog = editDialogRef.current
    if (!dialog) return
    if (editingCandidate && !dialog.open) dialog.showModal()
    if (!editingCandidate && dialog.open) dialog.close()
  }, [editingCandidate])

  const candidatesQuery = useQuery({
    queryKey: ['admin', 'candidates', selectedPositionId],
    queryFn: () => adminApi.getCandidates(selectedPositionId),
    enabled: Boolean(selectedPositionId),
  })
  const candidates = candidatesQuery.data ?? []

  const addMutation = useMutation({
    mutationFn: adminApi.addCandidate,
    onSuccess: () => {
      setNameTa('')
      setNameEn('')
      setPhotoFile(null)
      if (photoInputRef.current) photoInputRef.current.value = ''
      setIsAddOpen(false)
      queryClient.invalidateQueries({ queryKey: ['admin', 'candidates', selectedPositionId] })
    },
  })

  const statusMutation = useMutation({
    mutationFn: ({ candidateId, isActive }) => adminApi.setCandidateActive(candidateId, isActive),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'candidates', selectedPositionId] }),
  })

  const updateMutation = useMutation({
    mutationFn: ({ candidateId, formData }) => adminApi.updateCandidate(candidateId, formData),
    onSuccess: () => {
      setEditingCandidate(null)
      setEditPhotoFile(null)
      setRemoveEditPhoto(false)
      setSelectedPositionId(editPositionId)
      if (editPhotoInputRef.current) editPhotoInputRef.current.value = ''
      queryClient.invalidateQueries({ queryKey: ['admin', 'candidates'] })
    },
  })

  function clearCandidateDraft() {
    setNameTa('')
    setNameEn('')
    setPhotoFile(null)
    if (photoInputRef.current) photoInputRef.current.value = ''
    addMutation.reset()
  }

  function handleSubmit(event) {
    event.preventDefault()
    const formData = new FormData()
    formData.append('position_id', selectedPositionId)
    formData.append('name_ta', nameTa.trim())
    if (nameEn.trim()) formData.append('name_en', nameEn.trim())
    if (photoFile) formData.append('photo', photoFile)
    addMutation.mutate(formData)
  }

  function openAddForm() {
    addMutation.reset()
    clearCandidateDraft()
    setIsAddOpen(true)
  }

  function closeAddForm() {
    if (addMutation.isPending) return
    setIsAddOpen(false)
    clearCandidateDraft()
  }

  function openCandidateEdit(candidate) {
    updateMutation.reset()
    setEditingCandidate(candidate)
    setEditPositionId(String(candidate.position_id))
    setEditNameTa(candidate.name_ta)
    setEditNameEn(candidate.name_en ?? '')
    setEditPhotoFile(null)
    setRemoveEditPhoto(false)
  }

  function closeCandidateEdit() {
    if (updateMutation.isPending) return
    setEditingCandidate(null)
    setEditPhotoFile(null)
    setRemoveEditPhoto(false)
    updateMutation.reset()
    if (editPhotoInputRef.current) editPhotoInputRef.current.value = ''
  }

  function handleEditSubmit(event) {
    event.preventDefault()
    const formData = new FormData()
    formData.append('position_id', editPositionId)
    formData.append('name_ta', editNameTa.trim())
    if (editNameEn.trim()) formData.append('name_en', editNameEn.trim())
    if (editPhotoFile) formData.append('photo', editPhotoFile)
    if (removeEditPhoto) formData.append('remove_photo', 'true')
    updateMutation.mutate({ candidateId: editingCandidate.id, formData })
  }

  if (electionsQuery.isPending) {
    return <section className="candidate-card" role="status">Loading elections…</section>
  }

  if (electionsQuery.isError) {
    return (
      <section className="candidate-card">
        <p className="form-error" role="alert">{electionsQuery.error.message}</p>
        <button className="button button-primary" onClick={() => electionsQuery.refetch()} type="button">Retry</button>
      </section>
    )
  }

  if (!elections.length) {
    return (
      <section className="candidate-card">
        <p className="candidate-notice">
          Create an election before adding candidates. <Link to="/admin/election">Go to Election setup</Link>
        </p>
      </section>
    )
  }

  if (positionsQuery.isPending) {
    return <section className="candidate-card" role="status">Loading positions…</section>
  }

  if (positionsQuery.isError) {
    return (
      <section className="candidate-card">
        <p className="form-error" role="alert">{positionsQuery.error.message}</p>
        <button className="button button-primary" onClick={() => positionsQuery.refetch()} type="button">Retry</button>
      </section>
    )
  }

  const electionStatus = positionsQuery.data?.election_status ?? selectedElection?.status
  const isLocked = electionStatus !== 'DRAFT'

  function handleCandidateStatus(candidate) {
    statusMutation.mutate({ candidateId: candidate.id, isActive: !candidate.is_active })
  }

  return (
    <div className="candidates-layout">
      <section className="positions-list-card" aria-label="Candidate register">
        <div className="positions-list-heading candidate-register-heading">
          <div>
            {selectedPosition ? <p lang="ta" dir="auto">{selectedPosition.name_ta}</p> : null}
          </div>
          <div className="positions-list-toolbar candidate-register-toolbar">
            <label className="positions-election-picker" htmlFor="candidate-election-picker">
              <span>Election</span>
              <select
                disabled={addMutation.isPending || statusMutation.isPending || updateMutation.isPending}
                id="candidate-election-picker"
                onChange={(event) => {
                  setSelectedElectionId(event.target.value)
                  setSelectedPositionId('')
                  clearCandidateDraft()
                }}
                value={selectedElectionId}
              >
                {elections.map((election) => (
                  <option key={election.id} value={election.id}>{election.name}</option>
                ))}
              </select>
            </label>
            <label className="positions-election-picker" htmlFor="candidate-position-picker">
              <span>Position</span>
              <select
                disabled={!positions.length || addMutation.isPending || statusMutation.isPending || updateMutation.isPending}
                id="candidate-position-picker"
                onChange={(event) => {
                  setSelectedPositionId(event.target.value)
                  clearCandidateDraft()
                }}
                value={selectedPositionId}
              >
                {positions.map((position) => (
                  <option key={position.id} value={position.id}>{position.name_en}</option>
                ))}
              </select>
            </label>
            <span className="positions-count-badge">{candidates.length} added</span>
            <button className="button button-primary positions-add-button" disabled={isLocked || !positions.length} onClick={openAddForm} type="button">
              Add candidate
            </button>
          </div>
        </div>

        {!positions.length ? (
          <p className="positions-empty-state">Add at least one position before adding candidates. <Link to="/admin/positions">Go to Positions</Link></p>
        ) : null}
        {positions.length && isLocked ? (
          <div className="positions-notice" role="status">Candidate setup is locked because this election is {electionStatus.toLowerCase()}.</div>
        ) : null}

        {!positions.length || isLocked ? null : (
          <dialog
            className="position-create-dialog candidate-edit-dialog"
            onCancel={(event) => { event.preventDefault(); closeAddForm() }}
            onClick={(event) => { if (event.target === event.currentTarget) closeAddForm() }}
            ref={addDialogRef}
          >
          <form className="position-create-form candidate-two-column-form candidate-create-form" onSubmit={handleSubmit}>
            <div className="position-create-heading">
              <div>
                <p className="eyebrow">CANDIDATE DETAILS</p>
                <h2 id="candidate-add-title">Add a candidate</h2>
              </div>
              <button aria-label="Close candidate form" className="position-create-close" onClick={closeAddForm} type="button">×</button>
            </div>
            <div className="position-create-context">
              <span>Election</span>
              <strong>{selectedElection?.name}</strong>
            </div>
            <label className="form-field" htmlFor="candidate-position">
              <span className="position-required">Position</span>
              <select
                disabled={addMutation.isPending}
                id="candidate-position"
                onChange={(event) => {
                  setSelectedPositionId(event.target.value)
                  clearCandidateDraft()
                }}
                required
                value={selectedPositionId}
              >
                {positions.map((position) => (
                  <option key={position.id} value={position.id}>
                    {position.name_en} · {position.name_ta}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-field" htmlFor="candidate-name-ta">
              <span className="position-required">Candidate name (Tamil)</span>
              <input
                autoComplete="off"
                id="candidate-name-ta"
                lang="ta"
                maxLength={120}
                onChange={(event) => setNameTa(event.target.value)}
                placeholder="Enter the candidate name in Tamil"
                required
                value={nameTa}
              />
            </label>
            <label className="form-field" htmlFor="candidate-name-en">
              <span className="position-required">Candidate name (English)</span>
              <input
                autoComplete="off"
                id="candidate-name-en"
                maxLength={120}
                onChange={(event) => setNameEn(event.target.value)}
                placeholder="Enter the candidate name in English"
                required
                value={nameEn}
              />
            </label>
            <label className="form-field candidate-photo-field" htmlFor="candidate-photo">
              <span className="position-required">Photo (JPEG, PNG, or WebP; up to 5 MB)</span>
              <input
                accept="image/jpeg,image/png,image/webp"
                id="candidate-photo"
                onChange={(event) => setPhotoFile(event.target.files?.[0] ?? null)}
                required
                ref={photoInputRef}
                type="file"
              />
            </label>
            {photoPreview ? (
              <div className="candidate-photo-preview">
                <img alt="Selected candidate photo preview" src={photoPreview} />
                <span>{photoFile?.name}</span>
              </div>
            ) : null}
            {addMutation.isError ? <p className="form-error" role="alert">{addMutation.error.message}</p> : null}
            <div className="position-create-actions">
              <button className="button button-secondary" disabled={addMutation.isPending} onClick={closeAddForm} type="button">Cancel</button>
              <button className="button button-primary positions-add-button" disabled={addMutation.isPending} type="submit">
                {addMutation.isPending ? 'Adding…' : 'Add candidate'}
              </button>
            </div>
          </form>
          </dialog>
        )}
      {positions.length ? (
        <>
          {candidatesQuery.isPending ? (
            <p className="candidate-notice" role="status">Loading candidates…</p>
          ) : candidatesQuery.isError ? (
            <div>
              <p className="form-error" role="alert">{candidatesQuery.error.message}</p>
              <button className="button button-primary" onClick={() => candidatesQuery.refetch()} type="button">Retry</button>
            </div>
          ) : candidates.length ? (
            <div className="candidate-position-table">
            <div className="admin-list-header candidate-position-header" aria-hidden="true">
              <span>No.</span>
              <span>Photo</span>
              <span>Candidate</span>
              <span>Status</span>
              <span>Action</span>
            </div>
            <ol className="positions-list candidate-position-list">
              {candidates.map((candidate) => (
                <li className={`position-list-item admin-list-row candidate-position-row${candidate.is_active ? '' : ' is-inactive'}`} key={candidate.id}>
                  <span className="position-order">{String(candidate.ballot_no).padStart(2, '0')}</span>
                  {candidate.photo_url ? (
                    <img className="candidate-avatar" alt="" src={candidate.photo_url} />
                  ) : (
                    <span className="candidate-avatar candidate-avatar-empty" aria-hidden="true">♙</span>
                  )}
                  <div className="position-list-name candidate-position-name">
                    <strong>{candidate.name_en || 'English name not provided'}</strong>
                    <span className="position-name-separator" aria-hidden="true">-</span>
                    <span lang="ta" dir="auto">{candidate.name_ta}</span>
                  </div>
                  <StatusBadge tone={candidate.is_active ? 'success' : 'neutral'}>
                    {candidate.is_active ? 'Active' : 'Withdrawn'}
                  </StatusBadge>
                  {!isLocked ? (
                    <div className="candidate-position-actions">
                      <button
                        aria-label={`Edit ${candidate.name_en || candidate.name_ta}`}
                        className="button button-secondary position-update-button"
                        disabled={statusMutation.isPending || updateMutation.isPending}
                        onClick={() => openCandidateEdit(candidate)}
                        type="button"
                      >
                        Edit
                      </button>
                      <button
                        className="candidate-status-button"
                        disabled={statusMutation.isPending || updateMutation.isPending}
                        onClick={() => handleCandidateStatus(candidate)}
                        type="button"
                      >
                        {candidate.is_active ? 'Withdraw' : 'Restore'}
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
            </div>
          ) : (
            <p className="candidate-notice">No candidates have been added to this position.</p>
          )}
          {statusMutation.isError ? <p className="form-error" role="alert">{statusMutation.error.message}</p> : null}
          {updateMutation.isError ? <p className="form-error" role="alert">{updateMutation.error.message}</p> : null}
        </>
      ) : null}
      </section>

      <dialog
        className="position-create-dialog candidate-edit-dialog"
        onCancel={(event) => {
          event.preventDefault()
          closeCandidateEdit()
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeCandidateEdit()
        }}
        ref={editDialogRef}
      >
        {editingCandidate ? (
          <form className="position-create-form candidate-two-column-form" onSubmit={handleEditSubmit}>
            <div className="position-create-heading">
              <div>
                <p className="eyebrow">CANDIDATE {editingCandidate.ballot_no}</p>
                <h2>Update candidate</h2>
              </div>
              <button aria-label="Close candidate form" className="position-create-close" onClick={closeCandidateEdit} type="button">×</button>
            </div>
            <div className="position-create-context">
              <span>Election</span>
              <strong>{selectedElection?.name}</strong>
            </div>
            <label className="form-field" htmlFor="candidate-edit-position">
              <span className="position-required">Position</span>
              <select
                disabled={updateMutation.isPending}
                id="candidate-edit-position"
                onChange={(event) => setEditPositionId(event.target.value)}
                required
                value={editPositionId}
              >
                {positions.map((position) => (
                  <option key={position.id} value={position.id}>{position.name_en} · {position.name_ta}</option>
                ))}
              </select>
            </label>
            <label className="form-field" htmlFor="candidate-edit-name-ta">
              <span className="position-required">Candidate name (Tamil)</span>
              <input
                autoComplete="off"
                autoFocus
                id="candidate-edit-name-ta"
                lang="ta"
                maxLength={120}
                onChange={(event) => setEditNameTa(event.target.value)}
                required
                value={editNameTa}
              />
            </label>
            <label className="form-field" htmlFor="candidate-edit-name-en">
              <span>Candidate name (English, optional)</span>
              <input
                autoComplete="off"
                id="candidate-edit-name-en"
                maxLength={120}
                onChange={(event) => setEditNameEn(event.target.value)}
                value={editNameEn}
              />
            </label>
            <label className="form-field candidate-photo-field" htmlFor="candidate-edit-photo">
              <span>photo (JPEG, PNG, or WebP; up to 5 MB)</span>
              <input
                accept="image/jpeg,image/png,image/webp"
                id="candidate-edit-photo"
                onChange={(event) => {
                  setEditPhotoFile(event.target.files?.[0] ?? null)
                  setRemoveEditPhoto(false)
                }}
                ref={editPhotoInputRef}
                type="file"
              />
            </label>
            {(editPhotoPreview || (editingCandidate.photo_url && !removeEditPhoto && !editPhotoFile)) ? (
              <div className="candidate-photo-preview">
                <img alt="Candidate photo preview" src={editPhotoPreview || editingCandidate.photo_url} />
                <span>{editPhotoFile?.name || 'Current photo'}</span>
              </div>
            ) : null}
            {editingCandidate.photo_url || editPhotoFile ? (
              <label className="candidate-remove-photo" htmlFor="candidate-remove-photo">
                <input
                  checked={removeEditPhoto}
                  disabled={Boolean(editPhotoFile)}
                  id="candidate-remove-photo"
                  onChange={(event) => setRemoveEditPhoto(event.target.checked)}
                  type="checkbox"
                />
                Remove photo
              </label>
            ) : null}
            {updateMutation.isError ? <p className="form-error" role="alert">{updateMutation.error.message}</p> : null}
            <div className="position-create-actions">
              <button className="button button-secondary" disabled={updateMutation.isPending} onClick={closeCandidateEdit} type="button">Cancel</button>
              <button className="button button-primary" disabled={updateMutation.isPending} type="submit">
                {updateMutation.isPending ? 'Updating…' : 'Update candidate'}
              </button>
            </div>
          </form>
        ) : null}
      </dialog>
    </div>
  )
}
