import { useTranslation } from 'react-i18next'

import EmptyState from '../../components/ui/EmptyState.jsx'
import PageHeader from '../../components/ui/PageHeader.jsx'

export default function AuditorHome() {
  const { t } = useTranslation()

  return (
    <>
      <PageHeader
        eyebrow="REPORTING AND REVIEW"
        title={t('auditor.title')}
        description={t('auditor.description')}
      />
      <EmptyState
        title={t('auditor.readyTitle')}
        description={t('auditor.readyDescription')}
      />
    </>
  )
}
