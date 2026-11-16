import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { systemApi } from '../../api/systemApi.js'
import EmptyState from '../../components/ui/EmptyState.jsx'
import PageHeader from '../../components/ui/PageHeader.jsx'

const checklist = [
  { key: 'setupElection', path: 'election', number: '01' },
  { key: 'setupPositions', path: 'positions', number: '02' },
  { key: 'setupCandidates', path: 'candidates', number: '03' },
  { key: 'setupVoters', path: 'voters', number: '04' },
  { key: 'setupDevices', path: 'systems', number: '05' },
]

export default function AdminHome() {
  const { t } = useTranslation()
  const healthQuery = useQuery({
    queryKey: ['system', 'health'],
    queryFn: systemApi.health,
    refetchInterval: 30_000,
  })
  const databaseConnected = healthQuery.data?.database === 'connected'
  const healthLabel = databaseConnected
    ? t('home.databaseConnected')
    : healthQuery.isPending
      ? t('home.checkingDatabase')
      : t('home.databaseUnavailable')

  return (
    <>
      <PageHeader
        eyebrow={t('home.electionOverview')}
        title={t('home.electionOverview')}
        description="Prepare the election and keep operations on track."
        actions={
          <span className={`setup-status-pill ${databaseConnected ? 'is-healthy' : ''}`} role="status">
            <span aria-hidden="true" />
            {healthLabel}
          </span>
        }
      />

      <section className="overview-grid" aria-label="Election overview">
        <div className="overview-panel overview-panel--primary">
          <div className="overview-panel-orbit" aria-hidden="true" />
          <div className="overview-panel-content">
            <span className="panel-kicker">ELECTION SETUP</span>
            <h2>{t('home.setupTitle')}</h2>
            <p>{t('home.setupDescription')}</p>
            <Link className="button button-light" to="/admin/election">
              {t('home.startSetup')}
              <span aria-hidden="true">→</span>
            </Link>
          </div>
          <div className="overview-panel-graphic" aria-hidden="true">
            <div className="graphic-ring graphic-ring--one" />
            <div className="graphic-ring graphic-ring--two" />
            <div className="graphic-center">
              <span className="graphic-check">✓</span>
            </div>
            <span className="graphic-dot graphic-dot--one" />
            <span className="graphic-dot graphic-dot--two" />
            <span className="graphic-dot graphic-dot--three" />
          </div>
        </div>

        <section className="checklist-card" aria-labelledby="checklist-title">
          <div className="card-heading-row">
            <div>
              <p className="eyebrow">GETTING STARTED</p>
              <h2 id="checklist-title">{t('home.setupNext')}</h2>
            </div>
          </div>
          <ol className="setup-checklist">
            {checklist.map((item) => (
              <li key={item.key}>
                <Link to={`/admin/${item.path}`}>
                  <span className="checklist-number">{item.number}</span>
                  <span className="checklist-label">{t(`home.${item.key}`)}</span>
                  <span className="checklist-arrow" aria-hidden="true">↗</span>
                </Link>
              </li>
            ))}
          </ol>
          <p className="checklist-footnote">
            Use these sections to configure the election. Progress tracking will be connected to the setup API.
          </p>
        </section>
      </section>

      <section className="workspace-preview">
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">LIVE OPERATIONS</p>
            <h2>Election activity</h2>
          </div>
          <span className="muted-caption">Available after election setup</span>
        </div>
        <EmptyState
          title="Your election activity will appear here"
          description="Turnout, voter progress, and booth status will appear when the election operations APIs are connected."
        />
      </section>
    </>
  )
}
