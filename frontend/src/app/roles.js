const homeByRole = {
  ADMIN: '/admin',
  GATE1_OFFICER: '/entry',
  ENTRY_OFFICER: '/entry',
  MONITOR_OFFICER: '/monitor',
  MONITOR_SUPERVISOR: '/monitor',
  AUDITOR: '/auditor',
  VOTING_SYSTEM: '/booth',
}

export function getHomePath(role) {
  return homeByRole[role] ?? '/login'
}

export function getRoleLabel(role) {
  const labels = {
    ADMIN: 'Administrator',
    GATE1_OFFICER: 'Entry officer',
    ENTRY_OFFICER: 'Entry officer',
    MONITOR_OFFICER: 'Booth officer',
    MONITOR_SUPERVISOR: 'Booth supervisor',
    AUDITOR: 'Auditor',
    VOTING_SYSTEM: 'Voting terminal',
  }

  return labels[role] ?? 'Staff member'
}
