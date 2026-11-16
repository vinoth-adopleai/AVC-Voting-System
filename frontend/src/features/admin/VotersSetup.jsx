import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'

import { adminApi } from '../../api/adminApi.js'
import StatusBadge from '../../components/ui/StatusBadge.jsx'
import VoterPhoto from '../../components/ui/VoterPhoto.jsx'

const PAGE_SIZE = 50
const MAX_CSV_BYTES = 10 * 1024 * 1024
const FILE_PREVIEW_ROW_LIMIT = 5
const FILE_PREVIEW_COLUMN_LIMIT = 8

function makeImportForm(electionId, file) {
  const formData = new FormData()
  formData.append('election_id', electionId)
  formData.append('file', file)
  return formData
}

function parseCsvSample(text) {
  const records = []
  let record = []
  let value = ''
  let insideQuotes = false

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (insideQuotes) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"'
        index += 1
      } else if (character === '"') {
        insideQuotes = false
      } else {
        value += character
      }
      continue
    }

    if (character === '"' && value === '') {
      insideQuotes = true
    } else if (character === ',') {
      record.push(value)
      value = ''
    } else if (character === '\n' || character === '\r') {
      record.push(value)
      if (record.some((cell) => cell.trim())) records.push(record)
      record = []
      value = ''
      if (character === '\r' && text[index + 1] === '\n') index += 1
    } else {
      value += character
    }
  }

  if (insideQuotes) return { error: 'The CSV contains an unclosed quoted value.' }
  if (value || record.length) {
    record.push(value)
    if (record.some((cell) => cell.trim())) records.push(record)
  }
  if (!records.length) return { error: 'The selected CSV has no rows to preview.' }

  const headers = records[0].map((header, index) => (index === 0 ? header.replace(/^\uFEFF/, '') : header).trim())
  if (headers.some((header) => !header)) return { error: 'One or more column headers are blank.' }
  return { headers, rows: records.slice(1, FILE_PREVIEW_ROW_LIMIT + 1) }
}

function statusTone(status) {
  if (status === 'ELIGIBLE') return 'success'
  if (status === 'VOTED') return 'neutral'
  return 'warning'
}

function voterPhotoUrl(photo) {
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

export default function VotersSetup() {
  const queryClient = useQueryClient()
  const [selectedElectionId, setSelectedElectionId] = useState('')
  const [csvFile, setCsvFile] = useState(null)
  const [fileSample, setFileSample] = useState(null)
  const [importSummary, setImportSummary] = useState(null)
  const [page, setPage] = useState(1)
  const fileInputRef = useRef(null)

  const electionsQuery = useQuery({
    queryKey: ['admin', 'elections'],
    queryFn: adminApi.getElections,
  })
  const elections = electionsQuery.data ?? []
  const selectedElection = useMemo(
    () => elections.find((election) => String(election.id) === selectedElectionId),
    [elections, selectedElectionId],
  )

  useEffect(() => {
    if (!selectedElectionId && elections.length) {
      setSelectedElectionId(String(elections[0].id))
    }
  }, [elections, selectedElectionId])

  useEffect(() => {
    if (!csvFile) {
      setFileSample(null)
      return undefined
    }
    if (csvFile.size > MAX_CSV_BYTES) {
      setFileSample({ error: 'CSV files must be 10 MB or smaller.' })
      return undefined
    }

    let cancelled = false
    csvFile.text()
      .then((text) => {
        if (!cancelled) setFileSample(parseCsvSample(text))
      })
      .catch(() => {
        if (!cancelled) setFileSample({ error: 'Could not read this file. Select a UTF-8 CSV file and try again.' })
      })
    return () => { cancelled = true }
  }, [csvFile])

  const votersQuery = useQuery({
    queryKey: ['admin', 'voters', selectedElectionId, page],
    queryFn: () => adminApi.getVoters(selectedElectionId, page, PAGE_SIZE),
    enabled: Boolean(selectedElectionId),
    placeholderData: (previousData) => previousData,
  })

  const importMutation = useMutation({
    mutationFn: adminApi.importVoters,
    onSuccess: (result) => {
      setImportSummary(result)
      setCsvFile(null)
      setFileSample(null)
      setPage(1)
      if (fileInputRef.current) fileInputRef.current.value = ''
      queryClient.invalidateQueries({ queryKey: ['admin', 'voters', selectedElectionId] })
    },
  })

  function resetFileState() {
    setCsvFile(null)
    setFileSample(null)
    setImportSummary(null)
    importMutation.reset()
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function handleSubmit(event) {
    event.preventDefault()
    if (!csvFile || !selectedElectionId || csvFile.size > MAX_CSV_BYTES) return
    setImportSummary(null)
    importMutation.mutate(makeImportForm(selectedElectionId, csvFile))
  }

  if (electionsQuery.isPending) {
    return <section className="voter-import-card" role="status">Loading elections…</section>
  }
  if (electionsQuery.isError) {
    return (
      <section className="voter-import-card">
        <p className="form-error" role="alert">{electionsQuery.error.message}</p>
        <button className="button button-primary" onClick={() => electionsQuery.refetch()} type="button">Retry</button>
      </section>
    )
  }
  if (!elections.length) {
    return (
      <section className="voter-import-card">
        <p className="candidate-notice">
          Create an election before importing voters. <Link to="/admin/election">Go to Election setup</Link>
        </p>
      </section>
    )
  }

  const isLocked = selectedElection?.status !== 'DRAFT'
  const voters = votersQuery.data?.items ?? []
  const totalPages = Math.max(1, Math.ceil((votersQuery.data?.total ?? 0) / PAGE_SIZE))
  const rejectedRows = importMutation.error?.detail?.preview?.rejected_rows ?? []

  return (
    <div className="voters-layout">
      <section className="voter-import-card voter-import-card--compact voter-workspace-card" aria-label="Voter import and records">
        <form className="voter-import-row" onSubmit={handleSubmit}>
          <label className="form-field voter-election-field" htmlFor="voter-election">
            <span>Election name</span>
            <select
              disabled={importMutation.isPending}
              id="voter-election"
              onChange={(event) => {
                setSelectedElectionId(event.target.value)
                setPage(1)
                resetFileState()
              }}
              value={selectedElectionId}
            >
              {elections.map((election) => (
                <option key={election.id} value={election.id}>{election.name}</option>
              ))}
            </select>
          </label>

          <label className="form-field voter-file-field" htmlFor="voter-csv-file">
            <span>Voter CSV file</span>
            <input
              accept=".csv,text/csv"
              disabled={isLocked || importMutation.isPending}
              id="voter-csv-file"
              onChange={(event) => {
                setCsvFile(event.target.files?.[0] ?? null)
                setFileSample(null)
                setImportSummary(null)
                importMutation.reset()
              }}
              ref={fileInputRef}
              required
              type="file"
            />
          </label>

          <button className="button button-primary voter-import-button" disabled={isLocked || !csvFile || csvFile.size > MAX_CSV_BYTES || importMutation.isPending} type="submit">
            {importMutation.isPending ? 'Importing…' : 'Import voters'}
          </button>
        </form>
        {isLocked ? <p className="candidate-notice">Voters can only be imported while the selected election is a draft.</p> : null}

        {csvFile ? <p className="voter-selected-file">Selected: {csvFile.name}</p> : null}
        {fileSample?.error ? <p className="form-error" role="alert">{fileSample.error}</p> : null}
        {csvFile && fileSample && !fileSample.error ? (
          <div className="voter-file-sample" aria-live="polite">
            <div className="voter-file-sample-heading">
              <strong>File preview</strong>
              <span>First {FILE_PREVIEW_ROW_LIMIT} data rows</span>
            </div>
            <div className="voter-table-wrap">
              <table className="voter-review-table">
                <thead>
                  <tr>
                    {fileSample.headers.slice(0, FILE_PREVIEW_COLUMN_LIMIT).map((header, index) => (
                      <th key={`${header}-${index}`}>{header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {fileSample.rows.length ? fileSample.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {fileSample.headers.slice(0, FILE_PREVIEW_COLUMN_LIMIT).map((header, columnIndex) => (
                        <td key={`${header}-${columnIndex}`} title={row[columnIndex] ?? ''}>{row[columnIndex] || '—'}</td>
                      ))}
                    </tr>
                  )) : (
                    <tr><td colSpan={Math.min(fileSample.headers.length, FILE_PREVIEW_COLUMN_LIMIT)}>The CSV contains headers but no data rows.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {importMutation.isError ? <p className="form-error" role="alert">{importMutation.error.message}</p> : null}
        {rejectedRows.length ? (
          <div className="voter-import-errors" role="alert">
            <strong>Rows were not imported</strong>
            <ul>
              {rejectedRows.slice(0, 20).map((row) => (
                <li key={`${row.row_number}-${row.serial_no}`}>
                  Row {row.row_number}{row.serial_no ? ` (${row.serial_no})` : ''}: {row.errors.join('; ')}
                </li>
              ))}
            </ul>
            {rejectedRows.length > 20 ? <p>Showing 20 of {rejectedRows.length} rejected rows.</p> : null}
          </div>
        ) : null}
        {importSummary ? (
          <p className="voter-import-success" role="status">
            {importSummary.imported_count.toLocaleString()} voters imported.
            {importSummary.rejected_count ? ` ${importSummary.rejected_count.toLocaleString()} invalid or duplicate rows skipped.` : ''}
          </p>
        ) : null}
      <div className="voter-list-card">
        {votersQuery.isError ? (
          <p className="form-error" role="alert">{votersQuery.error.message}</p>
        ) : (
          <>
            <div className="voter-table-wrap voter-records-wrap" aria-busy={votersQuery.isFetching}>
              <div className="voter-record-list" role="table" aria-label="Voter records">
                <div className="voter-record-header" role="rowgroup">
                  <div className="voter-record-row admin-list-header" role="row">
                    <span role="columnheader">Serial number</span>
                    <span role="columnheader">Photo</span>
                    <span role="columnheader">Name</span>
                    <span role="columnheader">Father / husband</span>
                    <span role="columnheader">Age</span>
                    <span role="columnheader">Gender</span>
                    <span role="columnheader">Address</span>
                    <span role="columnheader">Status</span>
                  </div>
                </div>
                <div role="rowgroup">
                  {votersQuery.isPending ? (
                    <div className="voter-record-empty" role="row">Loading voter records…</div>
                  ) : voters.length ? voters.map((voter) => (
                    <div className="voter-record-row admin-list-row" key={voter.id} role="row">
                      <span data-label="Serial number" role="cell">{voter.serial_no}</span>
                      <span className="voter-record-photo-cell" data-label="Photo" role="cell"><VoterPhoto name={voter.name} photo={voter.photo} /></span>
                      <strong data-label="Name" role="cell">{voter.name}</strong>
                      <span data-label="Father / husband" role="cell">{voter.father_husband_name || '—'}</span>
                      <span data-label="Age" role="cell">{voter.age ?? '—'}</span>
                      <span data-label="Gender" role="cell">{voter.gender || '—'}</span>
                      <span className="voter-record-address" data-label="Address" role="cell" title={voter.address || ''}>{voter.address || '—'}</span>
                      <span data-label="Status" role="cell"><StatusBadge tone={statusTone(voter.status)}>{voter.status}</StatusBadge></span>
                    </div>
                  )) : (
                    <div className="voter-record-empty" role="row">No voters have been imported for this election.</div>
                  )}
                </div>
              </div>
            </div>

            <div className="voter-pagination">
              <span>Page {page} of {totalPages}</span>
              <div>
                <button className="button button-secondary" disabled={page <= 1 || votersQuery.isFetching} onClick={() => setPage((current) => current - 1)} type="button">Previous</button>
                <button className="button button-secondary" disabled={page >= totalPages || votersQuery.isFetching} onClick={() => setPage((current) => current + 1)} type="button">Next</button>
              </div>
            </div>
          </>
        )}
      </div>
      </section>
    </div>
  )
}
