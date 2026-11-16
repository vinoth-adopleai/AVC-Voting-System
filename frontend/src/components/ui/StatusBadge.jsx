export default function StatusBadge({ tone = 'neutral', children, className = '' }) {
  return (
    <span className={`status-badge status-badge--${tone} ${className}`.trim()}>
      <span className="status-badge-dot" aria-hidden="true" />
      {children}
    </span>
  )
}
