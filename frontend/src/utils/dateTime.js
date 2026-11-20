const INDIA_TIME_ZONE = 'Asia/Kolkata'

function validDate(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatIstTime(value, includeSeconds = false) {
  const date = validDate(value)
  if (!date) return '—'
  const formatted = new Intl.DateTimeFormat('en-IN', {
    timeZone: INDIA_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    ...(includeSeconds ? { second: '2-digit' } : {}),
  }).format(date)
  return `${formatted} IST`
}

export function formatIstDateTime(value) {
  const date = validDate(value)
  if (!date) return '—'
  const formatted = new Intl.DateTimeFormat('en-IN', {
    timeZone: INDIA_TIME_ZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
  return `${formatted} IST`
}
