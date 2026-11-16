export default function EmptyState({ icon, title, description, action }) {
  return (
    <section className="empty-state" aria-live="polite">
      <div className="empty-state-icon" aria-hidden="true">
        {icon ?? <span className="empty-state-dot" />}
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      {action ? <div className="empty-state-action">{action}</div> : null}
    </section>
  )
}
