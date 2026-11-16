export default function PageHeader({ actions }) {
  return actions ? <div className="page-header-actions-only">{actions}</div> : null
}
