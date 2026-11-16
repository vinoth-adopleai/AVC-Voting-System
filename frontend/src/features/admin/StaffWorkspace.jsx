import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { adminApi } from '../../api/adminApi.js'
import StatusBadge from '../../components/ui/StatusBadge.jsx'
import { useAuthStore } from '../../stores/authStore.js'

const STAFF_ROLES = [
  { value: 'ADMIN', label: 'Administrator' },
  { value: 'ENTRY_OFFICER', label: 'Entry officer' },
  { value: 'MONITOR_OFFICER', label: 'Booth officer' },
  { value: 'MONITOR_SUPERVISOR', label: 'Booth supervisor' },
  { value: 'AUDITOR', label: 'Auditor' },
]

function getRoleLabel(role) {
  return STAFF_ROLES.find((option) => option.value === role)?.label ?? role
}

export default function StaffWorkspace() {
  const queryClient = useQueryClient()
  const currentUserId = useAuthStore((state) => state.user?.id)
  const [fullName, setFullName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('ENTRY_OFFICER')
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [createSuccess, setCreateSuccess] = useState('')
  const createDialogRef = useRef(null)

  const staffQuery = useQuery({
    queryKey: ['admin', 'staff'],
    queryFn: adminApi.getStaff,
  })

  useEffect(() => {
    const dialog = createDialogRef.current
    if (!dialog) return
    if (isCreateOpen && !dialog.open) dialog.showModal()
    if (!isCreateOpen && dialog.open) dialog.close()
  }, [isCreateOpen])

  const createMutation = useMutation({
    mutationFn: adminApi.createStaff,
    onSuccess: (account) => {
      setFullName('')
      setUsername('')
      setPassword('')
      setRole('ENTRY_OFFICER')
      setIsCreateOpen(false)
      setCreateSuccess(`${account.full_name || account.username} was added as ${getRoleLabel(account.role)}.`)
      queryClient.invalidateQueries({ queryKey: ['admin', 'staff'] })
    },
  })

  const statusMutation = useMutation({
    mutationFn: ({ staffId, isActive }) => adminApi.setStaffActive(staffId, isActive),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'staff'] }),
  })

  function openCreateForm() {
    createMutation.reset()
    setCreateSuccess('')
    setFullName('')
    setUsername('')
    setPassword('')
    setRole('ENTRY_OFFICER')
    setIsCreateOpen(true)
  }

  function closeCreateForm() {
    if (createMutation.isPending) return
    setIsCreateOpen(false)
    setFullName('')
    setUsername('')
    setPassword('')
    createMutation.reset()
  }

  function handleCreate(event) {
    event.preventDefault()
    createMutation.mutate({
      full_name: fullName.trim(),
      username: username.trim(),
      password,
      role,
    })
  }

  const staff = staffQuery.data ?? []

  return (
    <div className="staff-workspace">
      <section className="positions-list-card" aria-labelledby="staff-list-title">
        <div className="positions-list-heading staff-register-heading">
          <div>
            <h2 id="staff-list-title">Staff accounts</h2>
          </div>
          <div className="positions-list-toolbar staff-register-toolbar">
            <span className="positions-count-badge">{staff.length} account{staff.length === 1 ? '' : 's'}</span>
            {staffQuery.isError ? (
              <button className="button button-secondary" onClick={() => staffQuery.refetch()} type="button">Retry</button>
            ) : null}
            <button className="button button-primary positions-add-button" onClick={openCreateForm} type="button">
              Add staff account
            </button>
          </div>
        </div>

        {createSuccess ? <p className="staff-action-success" role="status">{createSuccess}</p> : null}
        {staffQuery.isPending ? (
          <p className="staff-list-message" role="status">Loading staff accounts…</p>
        ) : staffQuery.isError ? (
          <p className="form-error" role="alert">{staffQuery.error.message}</p>
        ) : staff.length ? (
          <div className="staff-register-table">
            <div className="staff-register-header admin-list-header">
              <span>No.</span>
              <span>Staff name</span>
              <span>Username</span>
              <span>Role</span>
              <span>Status</span>
              <span>Action</span>
            </div>
            <ol className="positions-list staff-register-list">
              {staff.map((account, index) => (
                <li className="position-list-item admin-list-row staff-register-row" key={account.id}>
                  <span className="position-order">{String(index + 1).padStart(2, '0')}</span>
                  <div className="position-list-name staff-register-name">
                    <strong>{account.full_name || account.username}</strong>
                  </div>
                  <span className="staff-register-username">{account.username}</span>
                  <StatusBadge className="staff-register-role" tone="neutral">{getRoleLabel(account.role)}</StatusBadge>
                  <StatusBadge className="staff-register-state" tone={account.is_active ? 'success' : 'neutral'}>
                    {account.is_active ? 'Active' : 'Inactive'}
                  </StatusBadge>
                  <div className="staff-register-actions">
                    <button
                      className="staff-status-button"
                      disabled={statusMutation.isPending || (account.is_active && account.id === currentUserId)}
                      onClick={() => statusMutation.mutate({ staffId: account.id, isActive: !account.is_active })}
                      type="button"
                    >
                      {account.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <p className="positions-empty-state">No staff accounts found.</p>
        )}
        {statusMutation.isError ? <p className="form-error" role="alert">{statusMutation.error.message}</p> : null}
      </section>

      <dialog
        className="position-create-dialog staff-account-dialog"
        onCancel={(event) => {
          event.preventDefault()
          closeCreateForm()
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeCreateForm()
        }}
        ref={createDialogRef}
      >
        <form className="position-create-form candidate-two-column-form" onSubmit={handleCreate}>
          <div className="position-create-heading">
            <div>
              <p className="eyebrow">STAFF DETAILS</p>
              <h2>Create a staff account</h2>
            </div>
            <button aria-label="Close staff form" className="position-create-close" onClick={closeCreateForm} type="button">×</button>
          </div>
          <label className="form-field" htmlFor="staff-full-name">
            <span className="position-required">Full name</span>
            <input autoComplete="name" id="staff-full-name" maxLength={120} onChange={(event) => setFullName(event.target.value)} required value={fullName} />
          </label>
          <label className="form-field" htmlFor="staff-username">
            <span className="position-required">Username</span>
            <input autoCapitalize="none" autoComplete="off" id="staff-username" maxLength={64} onChange={(event) => setUsername(event.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,63}" required value={username} />
          </label>
          <label className="form-field" htmlFor="staff-role">
            <span className="position-required">Role</span>
            <select id="staff-role" onChange={(event) => setRole(event.target.value)} required value={role}>
              {STAFF_ROLES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label className="form-field" htmlFor="staff-password">
            <span className="position-required">Initial password (12 characters minimum)</span>
            <input autoComplete="new-password" id="staff-password" maxLength={128} minLength={12} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} />
          </label>
          {createMutation.isError ? <p className="form-error" role="alert">{createMutation.error.message}</p> : null}
          <div className="position-create-actions">
            <button className="button button-secondary" disabled={createMutation.isPending} onClick={closeCreateForm} type="button">Cancel</button>
            <button className="button button-primary" disabled={createMutation.isPending} type="submit">
              {createMutation.isPending ? 'Creating account…' : 'Create staff account'}
            </button>
          </div>
        </form>
      </dialog>

    </div>
  )
}
