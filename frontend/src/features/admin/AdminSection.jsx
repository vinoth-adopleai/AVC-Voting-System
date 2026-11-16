import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'

import EmptyState from '../../components/ui/EmptyState.jsx'
import PageHeader from '../../components/ui/PageHeader.jsx'
import ElectionSetup from './ElectionSetup.jsx'
import PositionsSetup from './PositionsSetup.jsx'
import CandidatesSetup from './CandidatesSetup.jsx'
import VotersSetup from './VotersSetup.jsx'
import StaffWorkspace from './StaffWorkspace.jsx'
import SystemsWorkspace from './SystemsWorkspace.jsx'

const sectionConfig = {
  election: { key: 'election', description: '' },
  positions: { key: 'positions', description: '' },
  candidates: { key: 'candidates', description: 'Manage candidates, names, and profile photos.' },
  voters: { key: 'voters', description: '' },
  staff: { key: 'staff', description: 'Create staff accounts and assign election roles.' },
  systems: { key: 'systems', description: '' },
  exceptions: { key: 'exceptions', description: 'Review and process election exceptions with reasons.' },
  reports: { key: 'reports', description: 'Review turnout and election results.' },
  audit: { key: 'audit', description: 'Search the record of election actions.' },
}

export default function AdminSection() {
  const { section = '' } = useParams()
  const { t } = useTranslation()
  const config = sectionConfig[section]

  if (!config) {
    return (
      <EmptyState
        title="Section not found"
        description="Choose a section from the navigation to continue."
      />
    )
  }

  const title = t(`navigation.${config.key}`)

  return (
    <>
      <PageHeader
        title={title}
        description={config.description}
      />
      {section === 'election' ? (
        <ElectionSetup />
      ) : section === 'positions' ? (
        <PositionsSetup />
      ) : section === 'candidates' ? (
        <CandidatesSetup />
      ) : section === 'voters' ? (
        <VotersSetup />
      ) : section === 'staff' ? (
        <StaffWorkspace />
      ) : section === 'systems' ? (
        <SystemsWorkspace />
      ) : (
          <section className="section-workspace-card">
            <span className="section-workspace-icon" aria-hidden="true">✦</span>
            <div>
              <span className="panel-kicker">{t('section.coming')}</span>
              <h2>{title}</h2>
              <p>{t('section.description', { section: title })}</p>
            </div>
            <span className="section-workspace-tag">Ready for implementation</span>
          </section>
      )}
    </>
  )
}
