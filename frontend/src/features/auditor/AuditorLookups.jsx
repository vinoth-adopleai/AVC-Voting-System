import { useTranslation } from 'react-i18next'

import EmptyState from '../../components/ui/EmptyState.jsx'
import PageHeader from '../../components/ui/PageHeader.jsx'

export default function AuditorLookups() {
  const { t } = useTranslation()

  return (
    <>
      <PageHeader
        eyebrow="AUDIT CONTROLS"
        title={t('navigation.lookups')}
        description="Approved voter and candidate lookups are recorded for audit."
      />
      <EmptyState
        title="No lookup is in progress"
        description="The lookup form and reason capture will be available when the auditor API is connected."
      />
    </>
  )
}
