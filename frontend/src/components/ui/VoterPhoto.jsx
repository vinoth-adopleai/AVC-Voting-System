import { useState } from 'react'

export function voterPhotoUrl(photo) {
  const path = String(photo ?? '').trim()
  if (!path) return ''
  if (/^https?:\/\//i.test(path) || path.startsWith('/api/')) return path

  const normalizedPath = path.replace(/\\/g, '/').replace(/^\.\//, '')
  if (normalizedPath.startsWith('/media/')) return `/api${normalizedPath}`

  const mediaMarker = normalizedPath.toLowerCase().lastIndexOf('/media/')
  if (mediaMarker >= 0) {
    return `/api/media/${normalizedPath.slice(mediaMarker + '/media/'.length).split('/').map(encodeURIComponent).join('/')}`
  }
  if (normalizedPath.toLowerCase().startsWith('media/')) {
    return `/api/${normalizedPath.split('/').map(encodeURIComponent).join('/')}`
  }
  if (/^[a-z]:\//i.test(normalizedPath) || normalizedPath.startsWith('/')) return ''
  return `/api/media/${normalizedPath.split('/').map(encodeURIComponent).join('/')}`
}

export default function VoterPhoto({ className = 'voter-record-photo', name, photo }) {
  const [failed, setFailed] = useState(false)
  const src = voterPhotoUrl(photo)

  if (!src || failed) return <span className={`${className}-empty`} aria-label="Photo unavailable">—</span>
  return <img className={className} src={src} alt={`${name} photo`} loading="lazy" onError={() => setFailed(true)} />
}
