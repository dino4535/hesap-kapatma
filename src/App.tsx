import { type ReactNode, useEffect, useMemo, useState } from 'react'
import {
  completeMutabakat,
  createUserAsAdmin,
  deleteDataByDateDepot,
  deleteDataByImportFile,
  findManimDekont,
  fetchManimReceipts,
  fetchImportJobStatus,
  fetchImportFiles,
  fetchMutabakat,
  fetchPositionData,
  fetchPositions,
  fetchPositionRepresentatives,
  fetchUsers,
  importSalesFiles,
  deletePositionRepresentative,
  saveMutabakat,
  savePositionRepresentative,
  saveInvoiceAllocationsSql,
  savePaymentAllocationsSql,
  type ManimDekontCandidate,
  type ManimReceiptRow,
  type MutabakatAdjustment,
  type MutabakatMode,
  type MutabakatRecord,
  type ImportFileRow,
  type ImportResultFile,
  type PositionRow,
  type PositionRepresentativeRow,
  type UserRow,
} from './data/api'
import { clearSessionUser, loadSessionUser, saveSessionUser, type SessionUser } from './data/local'
import { transferAmount, type Allocation, allocationAmountForType, computePaymentKey, getInvoiceAllocations, getPaymentAllocations, invoiceTotalAmount } from './domain/allocations'
import { formatDateTr, formatMoney } from './domain/format'
import type { Collection, Invoice } from './domain/models'
import { PAYMENT_TYPES, normalizePaymentType, type PaymentType, paymentTypeLabel } from './domain/paymentTypes'

type StatusType = 'success' | 'error' | 'info'

function sumAllocations(allocs: Allocation[]) {
  return allocs.reduce((s, a) => s + (a.amount ?? 0), 0)
}

function allocationSummary(allocs: Allocation[]) {
  return allocs
    .filter((a) => (a.amount ?? 0) > 0)
    .map((a) => `${paymentTypeLabel(a.type)}: ${formatMoney(a.amount)}`)
    .join(' / ')
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function formatDateTimeTr(value?: string) {
  if (!value) return '-'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString('tr-TR')
}

function isPlainVadeliTahsilat(formCode?: string, formDescription?: string) {
  const code = (formCode ?? '').trim().toUpperCase()
  const desc = (formDescription ?? '').trim().toLocaleLowerCase('tr-TR')
  return code === 'VADETAH' || desc === 'vadeli tahsilat'
}

type SqlCollectionRow = Collection & { paymentKey?: string }

function depotLabel(depotCode?: string) {
  if (!depotCode) return ''
  if (depotCode === 'DIST2K') return 'İzmir'
  if (depotCode === 'DIST28') return 'Salihli'
  if (depotCode === 'DIST2F') return 'Manisa'
  return depotCode
}

const BANKNOTES = [200, 100, 50, 20, 10, 5, 1] as const
type Banknote = (typeof BANKNOTES)[number]

const BANKS = ['Ziraat', 'İş Bankası', 'Garanti', 'Yapı Kredi', 'Akbank', 'VakıfBank', 'Halkbank', 'QNB', 'DenizBank'] as const

function LoginPage(props: { onLogin: (user: SessionUser) => void }) {
  const [userId, setUserId] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  return (
    <div className="page">
      <div className="login-card">
        <h2>Giriş</h2>
        <div className="form">
          <label>Kullanıcı</label>
          <input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="kullanıcı adı" />
          <label>Şifre</label>
          <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="şifre" type="password" />
          <button
            className="btn btn-primary"
            type="button"
            onClick={async () => {
              const v = userId.trim()
              if (!v || !password) return
              setLoading(true)
              setError(null)
              try {
                const res = await fetch('/api/auth/login', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ userName: v, password }),
                })
                if (!res.ok) {
                  const text = await res.text().catch(() => '')
                  throw new Error(text || `HTTP ${res.status}`)
                }
                const json = (await res.json()) as { ok: boolean; userName: string; isAdmin?: boolean }
                if (!json.ok) throw new Error('Giriş başarısız')
                props.onLogin({ userName: json.userName, isAdmin: Boolean(json.isAdmin) })
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Giriş sırasında hata oluştu')
              } finally {
                setLoading(false)
              }
            }}
          >
            {loading ? 'Giriş yapılıyor...' : 'Giriş Yap'}
          </button>
          <div className="upload-status error">{error ?? ''}</div>
        </div>
      </div>
    </div>
  )
}

function Modal(props: { title: string; open: boolean; onClose: () => void; children: ReactNode; size?: 'default' | 'wide' }) {
  if (!props.open) return null
  return (
    <div className="modal-backdrop" onClick={props.onClose} role="presentation">
      <div
        className={props.size === 'wide' ? 'modal modal-wide' : 'modal'}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-header">
          <div className="modal-title">{props.title}</div>
          <button className="modal-close" type="button" onClick={props.onClose}>
            ×
          </button>
        </div>
        {props.children}
      </div>
    </div>
  )
}

function AllocationEditor(props: {
  editorKey: string
  title: string
  total: number
  allocations: Allocation[]
  onChange: (next: Allocation[]) => void
}) {
  const [from, setFrom] = useState<PaymentType>('HAVALE')
  const [to, setTo] = useState<PaymentType>('NAKIT')
  const [amount, setAmount] = useState<number>(0)

  useEffect(() => {
    const positive = props.allocations
      .filter((a) => (Number(a.amount) || 0) > 0)
      .sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0))
    const source = (positive[0]?.type ?? 'NAKIT') as PaymentType
    const target = (PAYMENT_TYPES.find((t) => t !== source) ?? source) as PaymentType
    setFrom(source)
    setTo(target)
    setAmount(0)
  }, [props.editorKey, props.allocations])

  const onApply = () => {
    props.onChange(transferAmount(props.allocations, from, to, amount))
    setAmount(0)
  }

  return (
    <div className="allocation-editor">
      <div className="allocation-summary">
        <div>Toplam: {formatMoney(props.total)}</div>
        <div>Dağıtım: {formatMoney(sumAllocations(props.allocations))}</div>
      </div>

      <table className="mini-table">
        <thead>
          <tr>
            <th>Tip</th>
            <th>Tutar</th>
          </tr>
        </thead>
        <tbody>
          {props.allocations.map((a) => (
            <tr key={a.type}>
              <td>{paymentTypeLabel(a.type)}</td>
              <td>{formatMoney(a.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="transfer">
        <div className="transfer-row">
          <label>Kaynak</label>
          <select value={from} onChange={(e) => setFrom(e.target.value as PaymentType)}>
            {PAYMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {paymentTypeLabel(t)}
              </option>
            ))}
          </select>
        </div>
        <div className="transfer-row">
          <label>Hedef</label>
          <select value={to} onChange={(e) => setTo(e.target.value as PaymentType)}>
            {PAYMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {paymentTypeLabel(t)}
              </option>
            ))}
          </select>
        </div>
        <div className="transfer-row">
          <label>Tutar</label>
          <input type="number" value={amount || ''} onChange={(e) => setAmount(Number(e.target.value))} />
        </div>
        <button className="btn btn-primary" type="button" onClick={onApply}>
          Uygula
        </button>
      </div>
    </div>
  )
}

export default function App() {
  const [currentUser, setCurrentUser] = useState<SessionUser | null>(() => loadSessionUser())
  const [status, setStatus] = useState<{ type: StatusType; message: string } | null>(null)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [fileInputKey, setFileInputKey] = useState(0)
  const [uploadDepotMap, setUploadDepotMap] = useState<Record<string, string>>({})
  const [uploadBulkDepot, setUploadBulkDepot] = useState('')
  const [importJobFiles, setImportJobFiles] = useState<ImportResultFile[]>([])
  const [page, setPage] = useState<'main' | 'mutabakat' | 'position-representative' | 'user-admin'>('main')
  const [selectedPosition, setSelectedPosition] = useState<string | null>(null)
  const [detailSearch, setDetailSearch] = useState('')

  const [importFiles, setImportFiles] = useState<ImportFileRow[]>([])
  const [selectedDate, setSelectedDate] = useState<string>('')
  const [selectedDepot, setSelectedDepot] = useState<string>('')

  const [positions, setPositions] = useState<PositionRow[]>([])
  const [positionsLoading, setPositionsLoading] = useState(false)

  const [repMappings, setRepMappings] = useState<PositionRepresentativeRow[]>([])
  const [repMappingsLoading, setRepMappingsLoading] = useState(false)
  const [repSearch, setRepSearch] = useState('')
  const [repPositionCode, setRepPositionCode] = useState('')
  const [repName, setRepName] = useState('')
  const [repPositions, setRepPositions] = useState<PositionRow[]>([])
  const [allRepMappings, setAllRepMappings] = useState<PositionRepresentativeRow[]>([])

  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [collections, setCollections] = useState<SqlCollectionRow[]>([])
  const [invoiceAllocations, setInvoiceAllocations] = useState<Record<string, Allocation[]>>({})
  const [paymentAllocations, setPaymentAllocations] = useState<Record<string, Allocation[]>>({})

  const [positionTab, setPositionTab] = useState<'faturalar' | 'tahsilatlar'>('faturalar')
  const [typeFilter, setTypeFilter] = useState<PaymentType | null>(null)
  const [editingInvoice, setEditingInvoice] = useState<Invoice | null>(null)
  const [editingPayment, setEditingPayment] = useState<{ collection: Collection; key: string } | null>(null)
  const [mutabakatRecord, setMutabakatRecord] = useState<MutabakatRecord | null>(null)
  const [mutabakatMode, setMutabakatMode] = useState<MutabakatMode>('NAKIT')
  const [banknoteCounts, setBanknoteCounts] = useState<Record<Banknote, number>>({ 200: 0, 100: 0, 50: 0, 20: 0, 10: 0, 5: 0, 1: 0 })
  const [bankName, setBankName] = useState('')
  const [yatanTutar, setYatanTutar] = useState<number>(0)
  const [manimDekontNo, setManimDekontNo] = useState('')
  const [autoDekontNo, setAutoDekontNo] = useState<string | null>(null)
  const [bankReceiptDateTime, setBankReceiptDateTime] = useState<string>('')
  const [bankExplanation, setBankExplanation] = useState<string>('')
  const [manimDekontCandidates, setManimDekontCandidates] = useState<ManimDekontCandidate[]>([])
  const [manimReceipts, setManimReceipts] = useState<ManimReceiptRow[]>([])
  const [manimReceiptSearch, setManimReceiptSearch] = useState('')
  const [mutabakatAdjustments, setMutabakatAdjustments] = useState<MutabakatAdjustment[]>([])
  const [mutabakatStep, setMutabakatStep] = useState<0 | 1 | 2>(0)
  const [mutabakatCorrectionsTab, setMutabakatCorrectionsTab] = useState<'faturalar' | 'tahsilatlar'>('faturalar')
  const [mutabakatCorrectionsSearch, setMutabakatCorrectionsSearch] = useState('')

  const [adminUsers, setAdminUsers] = useState<UserRow[]>([])
  const [adminUsersLoading, setAdminUsersLoading] = useState(false)
  const [newUserName, setNewUserName] = useState('')
  const [newUserPassword, setNewUserPassword] = useState('')
  const [newUserIsAdmin, setNewUserIsAdmin] = useState(false)
  const [adminStatus, setAdminStatus] = useState<{ type: StatusType; message: string } | null>(null)
  const [adminDeleteDate, setAdminDeleteDate] = useState('')
  const [adminDeleteDepot, setAdminDeleteDepot] = useState('')
  const [adminDeleteFileName, setAdminDeleteFileName] = useState('')

  useEffect(() => {
    if (!currentUser) return
    fetchImportFiles()
      .then((r) => {
        if (!r.ok) throw new Error(r.message || 'Import listesi alınamadı')
        setImportFiles(r.files)
        if (r.files.length > 0 && (!selectedDate || !selectedDepot)) {
          const first = r.files.find((f) => (f.fileDate ?? '').trim() && (f.depotCode ?? '').trim()) ?? r.files[0]
          setSelectedDate((first.fileDate ?? '').trim())
          setSelectedDepot((first.depotCode ?? '').trim())
        }
      })
      .catch((e) => {
        setStatus({ type: 'error', message: e instanceof Error ? e.message : 'Import listesi alınamadı' })
        setImportFiles([])
      })
  }, [currentUser, selectedDate, selectedDepot])

  useEffect(() => {
    if (!currentUser?.isAdmin) return
    if (page !== 'user-admin') return
    if (importFiles.length === 0) return
    if (!adminDeleteDate) {
      const first = importFiles.find((f) => (f.fileDate ?? '').trim()) ?? importFiles[0]
      setAdminDeleteDate((first.fileDate ?? '').trim())
    }
    if (!adminDeleteFileName) {
      const firstName = (importFiles[0]?.fileName ?? '').trim()
      if (firstName) setAdminDeleteFileName(firstName)
    }
  }, [currentUser?.isAdmin, page, importFiles, adminDeleteDate, adminDeleteFileName])

  useEffect(() => {
    if (!currentUser || !currentUser.isAdmin) return
    if (page !== 'user-admin') return
    setAdminUsersLoading(true)
    setAdminStatus(null)
    fetchUsers({ userName: currentUser.userName })
      .then((r) => {
        if (!r.ok) throw new Error(r.message || 'Kullanıcı listesi alınamadı')
        setAdminUsers(r.users)
      })
      .catch((e) => {
        setAdminStatus({ type: 'error', message: e instanceof Error ? e.message : 'Kullanıcı listesi alınamadı' })
        setAdminUsers([])
      })
      .finally(() => setAdminUsersLoading(false))
  }, [currentUser, page])

  useEffect(() => {
    if (!currentUser) {
      setAllRepMappings([])
      return
    }
    fetchPositionRepresentatives({ userName: currentUser.userName })
      .then((r) => {
        if (!r.ok) throw new Error(r.message || 'Temsilci eşleme listesi alınamadı')
        setAllRepMappings(r.mappings)
      })
      .catch(() => {
        setAllRepMappings([])
      })
  }, [currentUser])

  const selectedDataset = useMemo(() => {
    return { date: selectedDate || null, depot: selectedDepot || null }
  }, [selectedDate, selectedDepot])

  const dateOptions = useMemo(() => {
    const seen = new Set<string>()
    const dates: string[] = []
    for (const f of importFiles) {
      const d = (f.fileDate ?? '').trim()
      if (!d || seen.has(d)) continue
      seen.add(d)
      dates.push(d)
    }
    dates.sort((a, b) => b.localeCompare(a))
    return dates
  }, [importFiles])

  const depotOptions = useMemo(() => {
    const d = selectedDate.trim()
    if (!d) return []
    const seen = new Set<string>()
    const depots: string[] = []
    for (const f of importFiles) {
      if ((f.fileDate ?? '').trim() !== d) continue
      const depot = (f.depotCode ?? '').trim()
      if (!depot || seen.has(depot)) continue
      seen.add(depot)
      depots.push(depot)
    }
    depots.sort((a, b) => depotLabel(a).localeCompare(depotLabel(b)))
    return depots
  }, [importFiles, selectedDate])

  const allDepotOptions = useMemo(() => {
    const seen = new Set<string>()
    const depots: string[] = []
    for (const f of importFiles) {
      const depot = (f.depotCode ?? '').trim()
      if (!depot || seen.has(depot)) continue
      seen.add(depot)
      depots.push(depot)
    }
    depots.sort((a, b) => depotLabel(a).localeCompare(depotLabel(b)))
    return depots
  }, [importFiles])

  const adminDeleteDepotOptions = useMemo(() => {
    const d = adminDeleteDate.trim()
    if (!d) return []
    const seen = new Set<string>()
    const depots: string[] = []
    for (const f of importFiles) {
      if ((f.fileDate ?? '').trim() !== d) continue
      const depot = (f.depotCode ?? '').trim()
      if (!depot || seen.has(depot)) continue
      seen.add(depot)
      depots.push(depot)
    }
    depots.sort((a, b) => depotLabel(a).localeCompare(depotLabel(b)))
    return depots
  }, [importFiles, adminDeleteDate])

  const adminImportFileOptions = useMemo(() => {
    const list = [...importFiles].filter((f) => (f.fileName ?? '').trim())
    list.sort((a, b) => String(b.importedAt ?? '').localeCompare(String(a.importedAt ?? '')))
    return list
  }, [importFiles])

  useEffect(() => {
    const d = adminDeleteDate.trim()
    if (!d) {
      if (adminDeleteDepot) setAdminDeleteDepot('')
      return
    }
    if (adminDeleteDepotOptions.length === 0) {
      if (adminDeleteDepot) setAdminDeleteDepot('')
      return
    }
    if (!adminDeleteDepot || !adminDeleteDepotOptions.includes(adminDeleteDepot)) {
      setAdminDeleteDepot(adminDeleteDepotOptions[0])
    }
  }, [adminDeleteDate, adminDeleteDepotOptions, adminDeleteDepot])

  useEffect(() => {
    if (!selectedDate.trim()) {
      if (selectedDepot) setSelectedDepot('')
      return
    }
    if (depotOptions.length === 0) {
      if (selectedDepot) setSelectedDepot('')
      return
    }
    if (!selectedDepot || !depotOptions.includes(selectedDepot)) {
      setSelectedDepot(depotOptions[0])
    }
  }, [selectedDate, depotOptions, selectedDepot])

  useEffect(() => {
    if (!currentUser) return
    if (!selectedDataset.date || !selectedDataset.depot) {
      setPositions([])
      setPositionsLoading(false)
      return
    }
    setPositionsLoading(true)
    fetchPositions({ date: selectedDataset.date, depot: selectedDataset.depot })
      .then((r) => {
        if (!r.ok) throw new Error(r.message || 'Pozisyonlar alınamadı')
        setPositions(r.positions)
      })
      .catch((e) => {
        setStatus({ type: 'error', message: e instanceof Error ? e.message : 'Pozisyonlar alınamadı' })
        setPositions([])
      })
      .finally(() => setPositionsLoading(false))
  }, [currentUser, selectedDataset.date, selectedDataset.depot])

  useEffect(() => {
    if (!currentUser) return
    if (!selectedPosition) return
    setStatus({ type: 'info', message: 'Pozisyon verisi alınıyor...' })
    fetchPositionData(selectedPosition, { date: selectedDataset.date, depot: selectedDataset.depot })
      .then((r) => {
        if (!r.ok) throw new Error(r.message || 'Pozisyon verisi alınamadı')
        const inv = r.invoices as Invoice[]
        const col = r.collections as SqlCollectionRow[]

        const invAlloc = Object.fromEntries(
          Object.entries(r.invoiceAllocations ?? {}).map(([k, v]) => [k, (Array.isArray(v) ? (v as Allocation[]) : [])]),
        ) as Record<string, Allocation[]>
        const payAlloc = Object.fromEntries(
          Object.entries(r.paymentAllocations ?? {}).map(([k, v]) => [k, (Array.isArray(v) ? (v as Allocation[]) : [])]),
        ) as Record<string, Allocation[]>

        setInvoices(inv)
        setCollections(col)
        setInvoiceAllocations(invAlloc)
        setPaymentAllocations(payAlloc)
        setStatus(null)
      })
      .catch((e) => {
        setInvoices([])
        setCollections([])
        setInvoiceAllocations({})
        setPaymentAllocations({})
        setStatus({ type: 'error', message: e instanceof Error ? e.message : 'Pozisyon verisi alınamadı' })
      })
  }, [currentUser, selectedPosition, selectedDataset.date, selectedDataset.depot])

  useEffect(() => {
    if (!selectedPosition || !selectedDataset.date || !selectedDataset.depot) {
      setMutabakatRecord(null)
      return
    }
    fetchMutabakat({ date: selectedDataset.date, depot: selectedDataset.depot, position: selectedPosition })
      .then((r) => {
        if (!r.ok) throw new Error(r.message || 'Mutabakat bilgisi alınamadı')
        setMutabakatRecord(r.record)
      })
      .catch(() => {
        setMutabakatRecord(null)
      })
  }, [selectedPosition, selectedDataset.date, selectedDataset.depot])

  useEffect(() => {
    if (!currentUser) return
    if (page !== 'position-representative') return
    setRepMappingsLoading(true)
    Promise.all([fetchPositionRepresentatives({ userName: currentUser.userName }), fetchPositions()])
      .then(([m, p]) => {
        if (!m.ok) throw new Error(m.message || 'Eşleme listesi alınamadı')
        if (!p.ok) throw new Error(p.message || 'Pozisyon listesi alınamadı')
        setRepMappings(m.mappings)
        setRepPositions(p.positions)
      })
      .catch((e) => {
        setStatus({ type: 'error', message: e instanceof Error ? e.message : 'Eşleme listesi alınamadı' })
        setRepMappings([])
        setRepPositions([])
      })
      .finally(() => setRepMappingsLoading(false))
  }, [currentUser, page])

  const filteredRepMappings = useMemo(() => {
    const q = repSearch.trim().toLowerCase()
    if (!q) return repMappings
    return repMappings.filter((m) => `${m.positionCode} ${m.representativeName}`.toLowerCase().includes(q))
  }, [repMappings, repSearch])

  const selectedRepresentativeName = useMemo(() => {
    if (!selectedPosition) return ''
    const row = allRepMappings.find((m) => m.positionCode === selectedPosition)
    return (row?.representativeName ?? '').trim()
  }, [allRepMappings, selectedPosition])

  const onLogin = (user: SessionUser) => {
    saveSessionUser(user)
    setCurrentUser(user)
  }

  const onLogout = () => {
    clearSessionUser()
    setCurrentUser(null)
    setSelectedPosition(null)
    setPage('main')
    setStatus(null)
  }

  useEffect(() => {
    if (selectedFiles.length === 0) {
      setUploadDepotMap({})
      setUploadBulkDepot('')
      return
    }
    setUploadDepotMap((prev) => {
      const next: Record<string, string> = {}
      for (const f of selectedFiles) {
        next[f.name] = (prev[f.name] ?? '').trim()
      }
      return next
    })
  }, [selectedFiles])

  const onUpload = async () => {
    if (!currentUser) return
    if (selectedFiles.length === 0) {
      setStatus({ type: 'error', message: 'Lütfen bir JSON dosyası seçin' })
      return
    }

    const missing = selectedFiles
      .map((f) => f.name)
      .filter((name) => !(uploadDepotMap[name] ?? '').trim())
    if (missing.length > 0) {
      setStatus({ type: 'error', message: `Depo seçimi zorunlu: ${missing.join(', ')}` })
      return
    }

    setStatus({ type: 'info', message: `Yükleme kuyruğa alınıyor: ${selectedFiles.length} dosya` })
    setImportJobFiles([])
    try {
      const started = await importSalesFiles(selectedFiles, uploadDepotMap)
      if (!started.ok || !started.jobId) throw new Error(started.message || 'Import kuyruğa alınamadı')

      let finished: Awaited<ReturnType<typeof fetchImportJobStatus>>['job'] | undefined
      for (let i = 0; i < 2400; i += 1) {
        const statusRes = await fetchImportJobStatus(started.jobId)
        if (!statusRes.ok || !statusRes.job) throw new Error(statusRes.message || 'Import durumu alınamadı')
        const job = statusRes.job
        setImportJobFiles(job.files ?? [])
        if (job.status === 'queued' || job.status === 'running') {
          const done = (job.files ?? []).reduce((s, f) => {
            return s + (f.positions ?? []).reduce((p, x) => p + x.processedInvoices + x.processedCollections, 0)
          }, 0)
          const total = (job.files ?? []).reduce((s, f) => {
            return s + (f.positions ?? []).reduce((p, x) => p + x.totalInvoices + x.totalCollections, 0)
          }, 0)
          const percent = total > 0 ? Math.round((done * 100) / total) : 0
          const current = job.currentFileName ? ` (${job.currentFileName})` : ''
          setStatus({
            type: 'info',
            message: `Import çalışıyor: ${percent}% - ${job.processedFiles}/${job.totalFiles} dosya${current}`,
          })
          await new Promise((resolve) => window.setTimeout(resolve, 1500))
          continue
        }
        finished = job
        break
      }
      if (!finished) throw new Error('Import zaman aşımına uğradı, lütfen job durumunu kontrol edin')
      if (finished.status === 'failed') throw new Error(finished.errorMessage || 'Import başarısız')

      const imported = finished.files.filter((f) => !f.skipped)
      const skippedFileCount = finished.files.length - imported.length
      const skippedPositionsCount = finished.files.reduce((s, f) => s + (f.skippedPositions?.length ?? 0), 0)
      const invoiceCount = imported.reduce((a, f) => a + f.invoiceCount, 0)
      const paymentCount = imported.reduce((a, f) => a + f.paymentCount, 0)
      setStatus({
        type: 'success',
        message:
          `SQL Server’a aktarıldı: ${invoiceCount} fatura, ${paymentCount} tahsilat` +
          (skippedFileCount > 0 || skippedPositionsCount > 0
            ? ` (Atlandı: ${skippedFileCount} dosya, ${skippedPositionsCount} pozisyon)`
            : ''),
      })
      const list = await fetchImportFiles()
      if (list.ok) {
        setImportFiles(list.files)
        const firstImported = imported[0]
        if (firstImported?.fileDate) {
          setSelectedDate((firstImported.fileDate ?? '').trim())
          setSelectedDepot((firstImported.depotCode ?? '').trim())
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Import sırasında hata oluştu'
      setStatus({ type: 'error', message: msg })
    }

    setSelectedFiles([])
    setUploadDepotMap({})
    setUploadBulkDepot('')
    setFileInputKey((k) => k + 1)
  }

  const positionInvoices = useMemo(() => invoices, [invoices])
  const positionCollections = useMemo(() => collections, [collections])

  const emptyTotals = () => Object.fromEntries(PAYMENT_TYPES.map((t) => [t, 0])) as Record<PaymentType, number>

  const totalsByTypeInvoices = useMemo(() => {
    const totals = emptyTotals()
    for (const inv of positionInvoices) {
      const allocs = getInvoiceAllocations(inv, invoiceAllocations)
      for (const t of PAYMENT_TYPES) totals[t] += allocationAmountForType(allocs, t)
    }
    return totals
  }, [positionInvoices, invoiceAllocations])

  const totalsByTypePayments = useMemo(() => {
    const totals = emptyTotals()
    for (const c of positionCollections) {
      const key = c.paymentKey ?? computePaymentKey(c.invoiceCode ?? '', c)
      const allocs = getPaymentAllocations(key, c, paymentAllocations)
      for (const t of PAYMENT_TYPES) totals[t] += allocationAmountForType(allocs, t)
    }
    return totals
  }, [positionCollections, paymentAllocations])

  const invoiceTotal = useMemo(() => positionInvoices.reduce((s, i) => s + invoiceTotalAmount(i), 0), [positionInvoices])
  const discountTotalAll = useMemo(() => positionInvoices.reduce((s, i) => s + (i.totalDiscount ?? 0), 0), [positionInvoices])
  const paymentTotal = useMemo(() => positionCollections.reduce((s, c) => s + (c.amount ?? 0), 0), [positionCollections])

  const havaleInvoicesByBayi = useMemo(() => {
    const totals = new Map<string, number>()
    for (const inv of positionInvoices) {
      const amount = allocationAmountForType(getInvoiceAllocations(inv, invoiceAllocations), 'HAVALE')
      if (amount <= 0) continue
      const name = (inv.customer.registeredName ?? '').trim() || '-'
      totals.set(name, (totals.get(name) ?? 0) + amount)
    }
    return Array.from(totals.entries())
      .map(([bayi, total]) => ({ bayi, total }))
      .sort((a, b) => a.bayi.localeCompare(b.bayi, 'tr', { sensitivity: 'base' }))
  }, [positionInvoices, invoiceAllocations])

  const vadeliTahsilatHavaleleriByBayi = useMemo(() => {
    const totals = new Map<string, number>()
    for (const c of positionCollections) {
      const key = c.paymentKey ?? computePaymentKey(c.invoiceCode ?? '', c)
      const allocs = getPaymentAllocations(key, c, paymentAllocations)
      const amount = allocationAmountForType(allocs, 'VADETAHHAV')
      if (amount <= 0) continue
      const name = (c.customer.registeredName ?? '').trim() || '-'
      totals.set(name, (totals.get(name) ?? 0) + amount)
    }
    return Array.from(totals.entries())
      .map(([bayi, total]) => ({ bayi, total }))
      .sort((a, b) => a.bayi.localeCompare(b.bayi, 'tr', { sensitivity: 'base' }))
  }, [positionCollections, paymentAllocations])

  const invoiceNakitGrossTotal = useMemo(() => {
    let total = 0
    for (const inv of positionInvoices) {
      for (const p of inv.payments ?? []) {
        if (normalizePaymentType(p.paymentFormCode, p.paymentFormDescription) !== 'NAKIT') continue
        total += Number(p.amount) || 0
      }
    }
    return total
  }, [positionInvoices])

  const collectionVadeliTahsilatAmountTotal = useMemo(() => {
    let total = 0
    for (const c of positionCollections) {
      if (!isPlainVadeliTahsilat(c.paymentFormCode, c.paymentFormDescription)) continue
      total += c.amount ?? 0
    }
    return total
  }, [positionCollections])

  const summaryTotals = useMemo(() => {
    if (!selectedPosition) return null

    const invoiceNakit = invoiceNakitGrossTotal
    const invoiceHavale = totalsByTypeInvoices.HAVALE
    const collectionVadeliTahsilat = collectionVadeliTahsilatAmountTotal
    const collectionVadeliTahsilatHavale = totalsByTypePayments.VADETAHHAV

    const havaleTutari = invoiceHavale
    const nakitTutari = invoiceNakit
    const rutToplam = havaleTutari + nakitTutari

    const vadeliSatisTutari = totalsByTypeInvoices.VADELI
    const genelToplam = rutToplam + vadeliSatisTutari

    const torbaTutari = nakitTutari + collectionVadeliTahsilat

    return {
      havaleTutari,
      nakitTutari,
      nakitToplam: nakitTutari,
      vadeliTahsilatHavale: collectionVadeliTahsilatHavale,
      toplam: rutToplam,
      iskontoToplam: discountTotalAll,
      toplamTahsilat: paymentTotal,
      vadeliSatisTutari,
      genelToplam,
      torbaTutari,
      toplamSatisTutari: invoiceTotal,
    }
  }, [
    selectedPosition,
    invoiceNakitGrossTotal,
    collectionVadeliTahsilatAmountTotal,
    totalsByTypeInvoices,
    totalsByTypePayments,
    discountTotalAll,
    paymentTotal,
    invoiceTotal,
  ])

  const detailInvoices = useMemo(() => {
    if (!selectedPosition) return []
    const q = detailSearch.trim().toLowerCase()
    const byType = typeFilter
      ? positionInvoices.filter((inv) => allocationAmountForType(getInvoiceAllocations(inv, invoiceAllocations), typeFilter) > 0)
      : positionInvoices
    if (!q) return byType
    return byType.filter((inv) => {
      const hay = [
        inv.customer.registeredName,
        inv.customer.taxNumber ?? '',
        inv.code,
        inv.legalNumber ?? '',
        inv.position.code,
      ]
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [selectedPosition, positionInvoices, typeFilter, invoiceAllocations, detailSearch])

  const detailPayments = useMemo(() => {
    if (!selectedPosition) return []
    const q = detailSearch.trim().toLowerCase()
    const rows: Array<{ key: string; c: Collection; allocs: Allocation[] }> = []
    for (const c of positionCollections) {
      const key = c.paymentKey ?? computePaymentKey(c.invoiceCode ?? '', c)
      const allocs = getPaymentAllocations(key, c, paymentAllocations)
      if (typeFilter && allocationAmountForType(allocs, typeFilter) <= 0) continue
      if (q) {
        const hay = [
          c.customer.registeredName,
          c.customer.taxNumber ?? '',
          c.invoiceCode ?? '',
          c.code ?? '',
          c.paymentFormDescription ?? '',
          c.paymentFormCode ?? '',
        ]
          .join(' ')
          .toLowerCase()
        if (!hay.includes(q)) continue
      }
      rows.push({ key, c, allocs })
    }
    return rows
  }, [selectedPosition, positionCollections, typeFilter, paymentAllocations, detailSearch])

  const mutabakatInvoicesForEdit = useMemo(() => {
    if (!selectedPosition) return []
    const q = mutabakatCorrectionsSearch.trim().toLowerCase()
    if (!q) return positionInvoices
    return positionInvoices.filter((inv) => {
      const hay = [inv.customer.registeredName, inv.customer.taxNumber ?? '', inv.code, inv.legalNumber ?? '', inv.position.code].join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [selectedPosition, positionInvoices, mutabakatCorrectionsSearch])

  const mutabakatPaymentsForEdit = useMemo(() => {
    if (!selectedPosition) return []
    const q = mutabakatCorrectionsSearch.trim().toLowerCase()
    const rows: Array<{ key: string; c: Collection; allocs: Allocation[] }> = []
    for (const c of positionCollections) {
      const key = c.paymentKey ?? computePaymentKey(c.invoiceCode ?? '', c)
      const allocs = getPaymentAllocations(key, c, paymentAllocations)
      if (q) {
        const hay = [c.customer.registeredName, c.customer.taxNumber ?? '', c.invoiceCode ?? '', c.code ?? '', c.paymentFormDescription ?? '', c.paymentFormCode ?? '']
          .join(' ')
          .toLowerCase()
        if (!hay.includes(q)) continue
      }
      rows.push({ key, c, allocs })
    }
    return rows
  }, [selectedPosition, positionCollections, paymentAllocations, mutabakatCorrectionsSearch])

  const openMutabakat = () => {
    setPage('mutabakat')
    setMutabakatStep(0)
    setMutabakatCorrectionsTab('faturalar')
    setMutabakatCorrectionsSearch('')
    if (
      mutabakatRecord &&
      mutabakatRecord.sourceFileDate === selectedDataset.date &&
      mutabakatRecord.depotCode === selectedDataset.depot &&
      mutabakatRecord.positionCode === selectedPosition
    ) {
      const hasCash = mutabakatRecord.cashJson != null
      const hasBank =
        (Number(mutabakatRecord.bankDepositAmount) || 0) > 0 ||
        !!(mutabakatRecord.bankName ?? '').trim() ||
        !!(mutabakatRecord.dekontNo ?? '').trim()

      setMutabakatMode(hasCash && hasBank ? 'KARMA' : hasBank ? 'BANKA' : 'NAKIT')

      const cash = (mutabakatRecord.cashJson ?? {}) as { banknoteCounts?: Record<string, unknown> }
      const bn = cash.banknoteCounts ?? {}
      if (hasCash) {
        setBanknoteCounts({
          200: Number(bn['200'] ?? 0),
          100: Number(bn['100'] ?? 0),
          50: Number(bn['50'] ?? 0),
          20: Number(bn['20'] ?? 0),
          10: Number(bn['10'] ?? 0),
          5: Number(bn['5'] ?? 0),
          1: Number(bn['1'] ?? 0),
        })
      } else {
        setBanknoteCounts({ 200: 0, 100: 0, 50: 0, 20: 0, 10: 0, 5: 0, 1: 0 })
      }
      setBankName(mutabakatRecord.bankName ?? '')
      setYatanTutar(mutabakatRecord.bankDepositAmount ?? 0)
      setManimDekontNo(mutabakatRecord.dekontNo ?? '')
      setBankReceiptDateTime(mutabakatRecord.bankReceiptDateTime ?? '')
      setBankExplanation(mutabakatRecord.bankExplanation ?? '')
      setMutabakatAdjustments(mutabakatRecord.adjustments ?? [])
      return
    }

    setMutabakatMode('NAKIT')
    setBanknoteCounts({ 200: 0, 100: 0, 50: 0, 20: 0, 10: 0, 5: 0, 1: 0 })
    setBankName('')
    setYatanTutar(0)
    setManimDekontNo('')
    setBankReceiptDateTime('')
    setBankExplanation('')
    setMutabakatAdjustments([])
  }

  const torbaTutari = summaryTotals?.torbaTutari ?? 0
  const cashTotal = BANKNOTES.reduce((s, d) => s + d * (banknoteCounts[d] ?? 0), 0)
  const adjustmentTotal = mutabakatAdjustments.reduce((s, a) => s + (Number(a.amount) || 0), 0)
  const cashEnabled = mutabakatMode === 'NAKIT' || mutabakatMode === 'KARMA'
  const bankEnabled = mutabakatMode === 'BANKA' || mutabakatMode === 'KARMA'
  const enteredTotal = (cashEnabled ? cashTotal : 0) + (bankEnabled ? Number(yatanTutar) || 0 : 0)
  const mutabakatFark = enteredTotal + adjustmentTotal - torbaTutari

  const validatePaymentInputs = () => {
    if (bankEnabled) {
      if (!bankName) {
        setStatus({ type: 'error', message: 'Lütfen banka seçin' })
        return false
      }
      if ((Number(yatanTutar) || 0) <= 0) {
        setStatus({ type: 'error', message: 'Lütfen yatan tutarı girin' })
        return false
      }
    }
    if (enteredTotal <= 0) {
      setStatus({ type: 'error', message: 'Girilen toplam 0 olamaz' })
      return false
    }
    return true
  }

  const mutabakatSaved =
    mutabakatRecord &&
    mutabakatRecord.sourceFileDate === selectedDataset.date &&
    mutabakatRecord.depotCode === selectedDataset.depot &&
    mutabakatRecord.positionCode === selectedPosition
      ? mutabakatRecord
      : null

  useEffect(() => {
    if (!currentUser) return
    if (!bankEnabled) return
    if (mutabakatSaved?.status === 'COMPLETED') return

    const bank = bankName.trim()
    const date = selectedDataset.date
    const amount = Number(yatanTutar) || 0
    const lookupAmount = amount > 0 ? amount : !cashEnabled ? torbaTutari : 0
    if (!bank || !date || lookupAmount <= 0) return

    const handle = window.setTimeout(() => {
      setManimDekontCandidates([])
      findManimDekont({ userName: currentUser.userName, bankName: bank, date, amount: lookupAmount })
        .then((r) => {
          if (!r.ok) {
            setStatus({ type: 'error', message: r.message || 'Manim dekont sorgusu başarısız' })
            return
          }
          const receiptNo = (r.match?.receiptNo ?? '').trim()
          if (receiptNo) {
            if (manimDekontNo.trim() && manimDekontNo.trim() !== (autoDekontNo ?? '')) return
            setManimDekontNo(receiptNo)
            setAutoDekontNo(receiptNo)
            setBankReceiptDateTime(String(r.match?.receiptDate ?? '').trim())
            setBankExplanation(String(r.match?.explanation ?? '').trim())
            if ((Number(yatanTutar) || 0) <= 0 && !cashEnabled) setYatanTutar(Number(r.match?.amount) || lookupAmount)
            setManimDekontCandidates([])
            return
          }
          const list = Array.isArray(r.candidates) ? r.candidates : []
          setManimDekontCandidates(list)
        })
        .catch((e) => {
          const msg = e instanceof Error ? e.message : 'Manim dekont sorgusu başarısız'
          setStatus({ type: 'error', message: msg })
        })
    }, 350)

    return () => window.clearTimeout(handle)
  }, [currentUser, bankEnabled, mutabakatSaved?.status, bankName, selectedDataset.date, yatanTutar, manimDekontNo, autoDekontNo, cashEnabled, torbaTutari])

  useEffect(() => {
    if (!currentUser) return
    if (!bankEnabled) {
      setManimReceipts([])
      return
    }
    const bank = bankName.trim()
    const date = selectedDataset.date
    if (!bank || !date) {
      setManimReceipts([])
      return
    }
    if (mutabakatSaved?.status === 'COMPLETED') return

    const handle = window.setTimeout(() => {
      setManimReceipts([])
      fetchManimReceipts({ userName: currentUser.userName, bankName: bank, date })
        .then((r) => {
          if (!r.ok) {
            setStatus({ type: 'error', message: r.message || 'Manim hareket listesi alınamadı' })
            return
          }
          setManimReceipts(Array.isArray(r.receipts) ? r.receipts : [])
        })
        .catch((e) => {
          const msg = e instanceof Error ? e.message : 'Manim hareket listesi alınamadı'
          setStatus({ type: 'error', message: msg })
        })
    }, 350)

    return () => window.clearTimeout(handle)
  }, [currentUser, bankEnabled, bankName, selectedDataset.date, mutabakatSaved?.status])

  const filteredManimReceipts = useMemo(() => {
    const q = manimReceiptSearch.trim().toLocaleLowerCase('tr-TR')
    if (!q) return manimReceipts
    return manimReceipts.filter((r) => {
      const hay = `${r.receiptNo ?? ''} ${r.receiptDate ?? ''} ${r.amount ?? ''} ${r.direction ?? ''} ${r.bankAccountLabel ?? ''} ${r.explanation ?? ''}`.toLocaleLowerCase(
        'tr-TR',
      )
      return hay.includes(q)
    })
  }, [manimReceipts, manimReceiptSearch])

  const addMutabakatAdjustment = () => {
    const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
    setMutabakatAdjustments((prev) => prev.concat([{ id, type: 'ACIK', description: '', amount: 0 }]))
  }

  const saveMutabakatData = async () => {
    if (!currentUser) return
    if (!selectedDataset.date || !selectedDataset.depot || !selectedPosition) return
    if (!summaryTotals) return
    if (mutabakatSaved?.status === 'COMPLETED') {
      setStatus({ type: 'error', message: 'Bu pozisyon için mutabakat tamamlanmış. Değişiklik yapılamaz.' })
      return
    }
    if (bankEnabled) {
      if (!bankName) {
        setStatus({ type: 'error', message: 'Lütfen banka seçin' })
        return
      }
      if ((Number(yatanTutar) || 0) <= 0) {
        setStatus({ type: 'error', message: 'Lütfen yatan tutarı girin' })
        return
      }
    }
    if (enteredTotal <= 0) {
      setStatus({ type: 'error', message: 'Girilen toplam 0 olamaz' })
      return
    }

    setStatus({ type: 'info', message: 'Mutabakat kaydediliyor...' })
    const cleanAdjustments = mutabakatAdjustments.map((a) => ({
      id: String(a.id),
      type: a.type,
      description: (a.description ?? '').trim(),
      amount: Number(a.amount) || 0,
    }))
    const r = await saveMutabakat({
      userName: currentUser.userName,
      record: {
        sourceFileDate: selectedDataset.date,
        depotCode: selectedDataset.depot,
        positionCode: selectedPosition,
        mode: mutabakatMode,
        torbaTutari,
        enteredAmount: enteredTotal,
        cashJson: cashEnabled ? { banknoteCounts } : undefined,
        bankName: bankEnabled ? bankName : undefined,
        bankDepositAmount: bankEnabled ? (Number(yatanTutar) || 0) : undefined,
        dekontNo: bankEnabled ? manimDekontNo : undefined,
        bankExplanation: bankEnabled ? bankExplanation : undefined,
        bankReceiptDateTime: bankEnabled ? bankReceiptDateTime : undefined,
        adjustments: cleanAdjustments,
      },
    })
    if (!r.ok || !r.record) {
      setStatus({ type: 'error', message: r.message || 'Mutabakat kaydedilemedi' })
      return
    }
    setMutabakatRecord(r.record)
    setStatus({
      type: 'success',
      message: Math.abs(Number(r.record.diffAmount) || 0) < 0.01 ? 'Mutabakat kaydedildi (Fark 0: Mutabakatı Tamamla aktif)' : 'Mutabakat kaydedildi',
    })
  }

  const completeMutabakatData = async () => {
    if (!currentUser) return
    if (!mutabakatSaved) return
    if (mutabakatSaved.status === 'COMPLETED') return
    if (Math.abs(mutabakatFark) >= 0.01) {
      setStatus({ type: 'error', message: 'Fark sıfır değil. Mutabakat tamamlanamaz.' })
      return
    }

    setStatus({ type: 'info', message: 'Mutabakat tamamlanıyor...' })
    const r = await completeMutabakat({
      userName: currentUser.userName,
      sourceFileDate: mutabakatSaved.sourceFileDate,
      depotCode: mutabakatSaved.depotCode,
      positionCode: mutabakatSaved.positionCode,
    })
    if (!r.ok || !r.record) {
      setStatus({ type: 'error', message: r.message || 'Mutabakat tamamlanamadı' })
      return
    }
    setMutabakatRecord(r.record)
    setPositions((prev) =>
      prev.map((p) => (p.code === r.record!.positionCode ? { ...p, mutabakatStatus: 'COMPLETED' } : p)),
    )
    setStatus({ type: 'success', message: 'Mutabakat tamamlandı' })
  }

  const printMutabakatPdf = () => {
    if (!mutabakatSaved || mutabakatSaved.status !== 'COMPLETED') {
      setStatus({ type: 'error', message: 'PDF için önce mutabakat tamamlanmalı' })
      return
    }

    const rec = mutabakatSaved
    const completedAt = formatDateTimeTr(rec.completedAt || rec.updatedAt)
    const completedBy = (rec.completedBy || rec.updatedBy || currentUser?.userName || '').trim() || '-'
    const repName = selectedRepresentativeName.trim() || '-'

    const cashCounts = (rec.cashJson ?? {}) as { banknoteCounts?: Record<string, unknown> }
    const bn = cashCounts.banknoteCounts ?? {}
    const cashRows = BANKNOTES.map((d) => ({ denom: d, count: Number(bn[String(d)] ?? 0) || 0 })).filter((r) => r.count > 0)
    const cashTotal = cashRows.reduce((s, r) => s + r.denom * r.count, 0)

    const adjustments = rec.adjustments ?? []
    const adjustTotal = adjustments.reduce((s, a) => s + (Number(a.amount) || 0), 0)

    const metaDate = rec.sourceFileDate ? formatDateTr(rec.sourceFileDate) : '-'
    const metaDepot = depotLabel(rec.depotCode) || rec.depotCode || '-'
    const metaPosition = rec.positionCode || '-'

    const hasCash = rec.cashJson != null
    const hasBank = (Number(rec.bankDepositAmount) || 0) > 0 || !!(rec.bankName ?? '').trim() || !!(rec.dekontNo ?? '').trim()
    const modeLabel = hasCash && hasBank ? 'Karma' : hasBank ? 'Bankaya Yatan' : 'Nakit'
    const money = (n: number | null | undefined) => formatMoney(Number(n) || 0)

    const limitByOther = (rows: { bayi: string; total: number }[], maxRows: number) => {
      if (rows.length <= maxRows) return { rows, other: null as null | { bayi: string; total: number } }
      const keep = Math.max(1, maxRows - 1)
      const head = rows.slice(0, keep)
      const rest = rows.slice(keep)
      const restTotal = rest.reduce((s, r) => s + (Number(r.total) || 0), 0)
      return {
        rows: head,
        other: { bayi: `Diğer (${rest.length} bayi)`, total: restTotal },
      }
    }

    const limitedHavale = limitByOther(havaleInvoicesByBayi, 14)
    const limitedVadeli = limitByOther(vadeliTahsilatHavaleleriByBayi, 14)

    const havaleRowsHtml =
      havaleInvoicesByBayi.length === 0
        ? `<tr><td colspan="2" class="empty">Kayıt yok</td></tr>`
        : `${limitedHavale.rows
            .map((r) => `<tr><td>${escapeHtml(r.bayi)}</td><td class="num">${escapeHtml(money(r.total))}</td></tr>`)
            .join('')}${
            limitedHavale.other
              ? `<tr><td>${escapeHtml(limitedHavale.other.bayi)}</td><td class="num">${escapeHtml(money(limitedHavale.other.total))}</td></tr>`
              : ''
          }`

    const vadeliRowsHtml =
      vadeliTahsilatHavaleleriByBayi.length === 0
        ? `<tr><td colspan="2" class="empty">Kayıt yok</td></tr>`
        : `${limitedVadeli.rows
            .map((r) => `<tr><td>${escapeHtml(r.bayi)}</td><td class="num">${escapeHtml(money(r.total))}</td></tr>`)
            .join('')}${
            limitedVadeli.other
              ? `<tr><td>${escapeHtml(limitedVadeli.other.bayi)}</td><td class="num">${escapeHtml(money(limitedVadeli.other.total))}</td></tr>`
              : ''
          }`

    const adjustmentRowsHtml =
      adjustments.length === 0
        ? `<tr><td colspan="3" class="empty">Kayıt yok</td></tr>`
        : adjustments
            .map(
              (a) =>
                `<tr><td>${escapeHtml(a.type)}</td><td>${escapeHtml((a.description ?? '').trim())}</td><td class="num">${escapeHtml(
                  money(Number(a.amount) || 0),
                )}</td></tr>`,
            )
            .join('')

    const cashRowsHtml =
      !hasCash
        ? ''
        : cashRows.length === 0
          ? `<tr><td colspan="3" class="empty">Kayıt yok</td></tr>`
          : cashRows
              .map((r) => `<tr><td class="num">${r.denom}</td><td class="num">${r.count}</td><td class="num">${escapeHtml(money(r.denom * r.count))}</td></tr>`)
              .join('')

    const bankInfoHtml =
      !hasBank
        ? ''
        : `
<div class="section">
  <div class="section-title">Bankaya Yatan Bilgileri</div>
  <div class="kv2">
    <div class="kv">
      <div class="k">Banka</div><div class="v">${escapeHtml((rec.bankName ?? '').trim() || '-')}</div>
      <div class="k">Yatan Tutar</div><div class="v">${escapeHtml(money(rec.bankDepositAmount ?? 0))}</div>
      <div class="k">Manim Dekont No</div><div class="v">${escapeHtml((rec.dekontNo ?? '').trim() || '-')}</div>
    </div>
    <div class="kv">
      <div class="k">İşlem Tarihi</div><div class="v">${escapeHtml(formatDateTimeTr((rec.bankReceiptDateTime ?? '').trim() || '-'))}</div>
      <div class="k">Ödeme Açıklaması</div><div class="v">${escapeHtml((rec.bankExplanation ?? '').trim() || '-')}</div>
    </div>
  </div>
</div>
`

    const cashInfoHtml =
      !hasCash
        ? ''
        : `
<div class="section">
  <div class="section-title">Nakit Banknot Dökümü</div>
  <table>
    <thead><tr><th class="num">Banknot</th><th class="num">Adet</th><th class="num">Tutar</th></tr></thead>
    <tbody>${cashRowsHtml}</tbody>
    <tfoot><tr><td colspan="2" class="num">Toplam</td><td class="num">${escapeHtml(money(cashTotal))}</td></tr></tfoot>
  </table>
</div>
`

    const html = `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Mutabakat Çıktısı</title>
  <style>
    @page { size: A4; margin: 6mm; }
    html, body { padding: 0; margin: 0; }
    body { font-family: Arial, Helvetica, sans-serif; color: #1a202c; font-size: 10px; line-height: 1.15; }
    .page { width: 210mm; margin: 0 auto; padding: 0; box-sizing: border-box; }
    .sheet { padding: 6mm; box-sizing: border-box; transform-origin: top left; }
    .header { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: start; margin-bottom: 6px; }
    .title { font-size: 12px; font-weight: 700; }
    .sub { color: #4a5568; font-size: 9px; margin-top: 2px; }
    .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 10px; font-size: 9px; }
    .meta .k { color: #718096; }
    .meta .v { font-weight: 700; }
    .badge { display: inline-block; padding: 3px 8px; border-radius: 999px; background: #c6f6d5; color: #22543d; font-size: 10px; font-weight: 700; }
    .print-actions { max-width: 210mm; margin: 10px auto 0; padding: 0 12mm; box-sizing: border-box; display: flex; gap: 10px; align-items: center; }
    .print-btn { border: 1px solid #2d3748; background: #2d3748; color: #fff; padding: 8px 10px; border-radius: 8px; font-size: 12px; cursor: pointer; }
    .print-note { color: #718096; font-size: 12px; }
    .section { margin-top: 7px; }
    .section-title { font-size: 10px; font-weight: 700; margin-bottom: 4px; }
    .kv { display: grid; grid-template-columns: 100px 1fr; gap: 3px 8px; font-size: 9px; }
    .kv2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .kv .k { color: #718096; }
    .kv .v { font-weight: 700; }
    table { width: 100%; border-collapse: collapse; font-size: 9px; }
    th, td { border: 1px solid #e2e8f0; padding: 3px 5px; vertical-align: top; }
    th { background: #f7fafc; text-align: left; }
    td.num, th.num { text-align: right; white-space: nowrap; }
    tfoot td { font-weight: 700; background: #f7fafc; }
    .empty { text-align: center; color: #718096; }
    .signatures { margin-top: 8px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .sig { border: 1px solid #e2e8f0; border-radius: 8px; padding: 6px; min-height: 52px; }
    .sig-title { font-size: 9px; font-weight: 700; margin-bottom: 4px; }
    .sig-line { margin-top: 24px; border-top: 1px solid #2d3748; padding-top: 4px; font-size: 9px; color: #4a5568; }
    @media (max-width: 520px) {
      .page { padding: 12px; }
      .header { flex-direction: column; }
      .meta { grid-template-columns: 1fr; }
      .kv { grid-template-columns: 1fr; }
      .signatures { grid-template-columns: 1fr; }
    }
    @media print {
      .print-actions { display: none; }
      .page { padding: 0; }
      .sig { break-inside: avoid; }
      table { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="print-actions">
    <button class="print-btn" type="button" onclick="manualPrint()">Yazdır / PDF</button>
    <div class="print-note">Otomatik pencere gelmezse bu butona basın.</div>
  </div>
  <div class="page">
    <div class="sheet">
    <div class="header">
      <div>
        <div class="title">Mutabakat Çıktısı</div>
        <div class="sub">Tarih/Saat: ${escapeHtml(completedAt)} | Hesap Kapatma: ${escapeHtml(completedBy)}</div>
        <div class="sub">Temsilci: ${escapeHtml(repName)}</div>
      </div>
      <div class="badge">TAMAMLANDI</div>
    </div>

    <div class="meta">
      <div class="k">Tarih</div><div class="v">${escapeHtml(metaDate)}</div>
      <div class="k">Depo</div><div class="v">${escapeHtml(metaDepot)}</div>
      <div class="k">Pozisyon</div><div class="v">${escapeHtml(metaPosition)}</div>
      <div class="k">Mutabakat Tipi</div><div class="v">${escapeHtml(modeLabel)}</div>
    </div>

    <div class="section">
      <div class="section-title">Özet</div>
      <div class="kv">
        <div class="k">Torba Tutarı</div><div class="v">${escapeHtml(money(rec.torbaTutari))}</div>
        <div class="k">Girilen Tutar</div><div class="v">${escapeHtml(money(rec.enteredAmount))}</div>
        <div class="k">Düzeltme Toplamı</div><div class="v">${escapeHtml(money(adjustTotal))}</div>
        <div class="k">Fark</div><div class="v">${escapeHtml(money(rec.diffAmount))}</div>
      </div>
    </div>

    ${bankInfoHtml}
    ${cashInfoHtml}

    <div class="section">
      <div class="section-title">Temsilci Açık / Hatalı Tahsilat / Diğer</div>
      <table>
        <thead><tr><th>Tip</th><th>Açıklama</th><th class="num">Tutar</th></tr></thead>
        <tbody>${adjustmentRowsHtml}</tbody>
      </table>
    </div>

    <div class="section">
      <div class="section-title">Havale Ödeme Tipli Faturalar (Bayi Bazında)</div>
      <table>
        <thead><tr><th>Bayi</th><th class="num">Toplam</th></tr></thead>
        <tbody>${havaleRowsHtml}</tbody>
      </table>
    </div>

    <div class="section">
      <div class="section-title">Vadeli Tahsilat Havaleleri (Bayi Bazında)</div>
      <table>
        <thead><tr><th>Bayi</th><th class="num">Toplam</th></tr></thead>
        <tbody>${vadeliRowsHtml}</tbody>
      </table>
    </div>

    <div class="signatures">
      <div class="sig">
        <div class="sig-title">Temsilci İmza</div>
        <div class="sig-line">${escapeHtml(repName)}</div>
      </div>
      <div class="sig">
        <div class="sig-title">Hesap Kapatma İmza</div>
        <div class="sig-line">${escapeHtml(completedBy)}</div>
      </div>
    </div>
    </div>
  </div>

  <script>
    function fitToOnePage() {
      var sheet = document.querySelector('.sheet');
      if (!sheet) return 1;
      sheet.style.transform = 'scale(1)';
      var rect = sheet.getBoundingClientRect();
      var w = rect.width;
      var h = rect.height;
      var targetW = 794;
      var targetH = 1122;
      var scale = Math.min(1, targetW / w, targetH / h);
      scale = Math.max(0.45, scale);
      sheet.style.transform = 'scale(' + scale + ')';
      return scale;
    }
    function manualPrint() {
      fitToOnePage();
      try { window.focus(); } catch (e) {}
      try { window.print(); } catch (e) {}
    }
    window.addEventListener('load', function () {
      setTimeout(function () { manualPrint(); }, 500);
    });
  </script>
</body>
</html>`

    const blob = new Blob([html], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    const w = window.open(url, '_blank')
    if (!w) {
      setStatus({ type: 'error', message: 'Popup engellendi. Lütfen popup izni verin.' })
      return
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  const updateInvoiceAllocations = (invoiceCode: string, next: Allocation[]) => {
    if (!currentUser) return
    setStatus({ type: 'info', message: 'Kaydediliyor...' })
    saveInvoiceAllocationsSql({ userName: currentUser.userName, invoiceCode, allocations: next })
      .then((r) => {
        if (!r.ok) throw new Error(r.message || 'Kaydetme başarısız')
        setInvoiceAllocations((prev) => ({ ...prev, [invoiceCode]: next }))
        setStatus(null)
      })
      .catch((e) => {
        setStatus({ type: 'error', message: e instanceof Error ? e.message : 'Kaydetme sırasında hata' })
      })
  }

  const updatePaymentAllocations = (paymentKey: string, next: Allocation[]) => {
    if (!currentUser) return
    setStatus({ type: 'info', message: 'Kaydediliyor...' })
    savePaymentAllocationsSql({ userName: currentUser.userName, paymentKey, allocations: next })
      .then((r) => {
        if (!r.ok) throw new Error(r.message || 'Kaydetme başarısız')
        setPaymentAllocations((prev) => ({ ...prev, [paymentKey]: next }))
        setStatus(null)
      })
      .catch((e) => {
        setStatus({ type: 'error', message: e instanceof Error ? e.message : 'Kaydetme sırasında hata' })
      })
  }

  if (!currentUser) return <LoginPage onLogin={onLogin} />

  const pageTitle =
    page === 'mutabakat'
      ? 'Mutabakat'
      : page === 'position-representative'
        ? 'Pozisyon - Temsilci'
        : page === 'user-admin'
          ? 'Kullanıcı Yönetimi'
        : selectedPosition
          ? `Pozisyon: ${selectedPosition}`
          : 'Pozisyon Hesabı'

  const pageMeta = [selectedDataset.date ? formatDateTr(selectedDataset.date) : '', selectedDataset.depot ? depotLabel(selectedDataset.depot) : ''].filter(Boolean).join(' • ')

  return (
    <div className="app-shell">
      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar-header">
            <div className="sidebar-brand">Hesap Kapatma</div>
            <div className="sidebar-user">
              {currentUser.userName}
              {currentUser.isAdmin ? ' (Admin)' : ''}
            </div>
          </div>

          <nav className="sidebar-nav">
            <button
              className={`nav-item ${page === 'main' ? 'active' : ''}`}
              type="button"
              onClick={() => {
                setPage('main')
              }}
            >
              Pozisyon Hesabı
            </button>
            <button
              className={`nav-item ${page === 'mutabakat' ? 'active' : ''}`}
              type="button"
              onClick={() => {
                setPage('mutabakat')
                setMutabakatStep(0)
              }}
            >
              Mutabakat
            </button>
            <button
              className={`nav-item ${page === 'position-representative' ? 'active' : ''}`}
              type="button"
              onClick={() => {
                setSelectedPosition(null)
                setTypeFilter(null)
                setPositionTab('faturalar')
                setDetailSearch('')
                setPage('position-representative')
              }}
            >
              Pozisyon - Temsilci
            </button>
            {currentUser.isAdmin ? (
              <button
                className={`nav-item ${page === 'user-admin' ? 'active' : ''}`}
                type="button"
                onClick={() => {
                  setPage('user-admin')
                }}
              >
                Kullanıcılar
              </button>
            ) : null}
          </nav>

          <div className="sidebar-footer">
            {pageMeta ? <div className="sidebar-meta">{pageMeta}</div> : null}
            <button className="btn btn-secondary" type="button" onClick={onLogout}>
              Çıkış
            </button>
          </div>
        </aside>

        <main className="main">
          <div className="main-header">
            <div className="main-header-left">
              <div className="main-title">{pageTitle}</div>
              <div className="main-subtitle">
                {page === 'position-representative'
                  ? 'Pozisyona göre temsilci tanımlama'
                  : page === 'mutabakat'
                    ? 'Mutabakat akışı'
                    : page === 'user-admin'
                      ? 'Kullanıcı ekleme ve listeleme'
                      : ''}
              </div>
            </div>
            <div className="main-header-right">
              {selectedPosition ? (
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => {
                    if (page === 'mutabakat') {
                      setPage('main')
                      setTypeFilter(null)
                      setDetailSearch('')
                      return
                    }
                    setSelectedPosition(null)
                    setTypeFilter(null)
                    setPositionTab('faturalar')
                  }}
                >
                  {page === 'mutabakat' ? 'Pozisyon Detayı' : 'Pozisyonlara Dön'}
                </button>
              ) : null}
            </div>
          </div>

          <div className="app-container">
            {page === 'position-representative' ? (
        <>
          <div className="header">
            <h1>Pozisyon - Temsilci Eşleme</h1>
            <p>Pozisyona göre temsilci tanımlama</p>
            {status ? <div className={`upload-status ${status.type}`}>{status.message}</div> : null}
          </div>

          <div className="upload-section">
            <div className="upload-box" style={{ gap: 10, alignItems: 'end' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 220 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: '#4a5568' }}>Pozisyon</label>
                <input list="positionCodes" value={repPositionCode} onChange={(e) => setRepPositionCode(e.target.value)} placeholder="Pozisyon kodu" />
                <datalist id="positionCodes">
                  {repPositions.map((p) => (
                    <option key={p.code} value={p.code} />
                  ))}
                </datalist>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 260 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: '#4a5568' }}>Temsilci</label>
                <input value={repName} onChange={(e) => setRepName(e.target.value)} placeholder="Temsilci adı" />
              </div>
              <button
                className="btn btn-primary"
                type="button"
                onClick={async () => {
                  const pc = repPositionCode.trim()
                  const rn = repName.trim()
                  if (!pc || !rn) {
                    setStatus({ type: 'error', message: 'Pozisyon ve temsilci zorunlu' })
                    return
                  }
                  setStatus({ type: 'info', message: 'Kaydediliyor...' })
                  const r = await savePositionRepresentative({ userName: currentUser.userName, positionCode: pc, representativeName: rn })
                  if (!r.ok || !r.mapping) {
                    setStatus({ type: 'error', message: r.message || 'Kaydedilemedi' })
                    return
                  }
                  setRepMappings((prev) => {
                    const next = prev.filter((x) => x.positionCode !== r.mapping!.positionCode)
                    next.push(r.mapping!)
                    next.sort((a, b) => a.positionCode.localeCompare(b.positionCode))
                    return next
                  })
                  setRepPositionCode('')
                  setRepName('')
                  setStatus({ type: 'success', message: 'Kaydedildi' })
                }}
              >
                Kaydet
              </button>
            </div>
          </div>

          <div className="table-section">
            <div className="table-header">
              <span className="table-title">Eşlemeler</span>
              <div className="actions"></div>
            </div>
            <div className="table-search">
              <input value={repSearch} onChange={(e) => setRepSearch(e.target.value)} placeholder="Ara (pozisyon / temsilci)" />
              <button className="btn btn-secondary" type="button" onClick={() => setRepSearch('')} disabled={!repSearch.trim()}>
                Temizle
              </button>
            </div>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Pozisyon</th>
                    <th>Temsilci</th>
                    <th>Güncelleyen</th>
                    <th>Güncelleme Tarihi</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {repMappingsLoading ? (
                    <tr>
                      <td colSpan={5} style={{ textAlign: 'center', color: '#718096' }}>
                        Yükleniyor...
                      </td>
                    </tr>
                  ) : filteredRepMappings.length === 0 ? (
                    <tr>
                      <td colSpan={5} style={{ textAlign: 'center', color: '#718096' }}>
                        Kayıt yok
                      </td>
                    </tr>
                  ) : (
                    filteredRepMappings.map((m) => (
                      <tr key={m.positionCode}>
                        <td>{m.positionCode}</td>
                        <td>{m.representativeName}</td>
                        <td>{m.updatedBy ?? '-'}</td>
                        <td>{m.updatedAt ? formatDateTr(m.updatedAt.slice(0, 10)) : '-'}</td>
                        <td>
                          <button
                            className="btn btn-secondary"
                            type="button"
                            onClick={() => {
                              setRepPositionCode(m.positionCode)
                              setRepName(m.representativeName)
                            }}
                          >
                            Düzenle
                          </button>
                          <button
                            className="btn btn-secondary"
                            type="button"
                            onClick={async () => {
                              setStatus({ type: 'info', message: 'Siliniyor...' })
                              const r = await deletePositionRepresentative({ userName: currentUser.userName, positionCode: m.positionCode })
                              if (!r.ok) {
                                setStatus({ type: 'error', message: r.message || 'Silinemedi' })
                                return
                              }
                              setRepMappings((prev) => prev.filter((x) => x.positionCode !== m.positionCode))
                              setStatus({ type: 'success', message: 'Silindi' })
                            }}
                          >
                            Sil
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : page === 'user-admin' ? (
        <>
          <div className="header">
            <h1>Kullanıcı Yönetimi</h1>
            <p>Admin kullanıcılar yeni kullanıcı ekleyebilir.</p>
            {adminStatus ? <div className={`upload-status ${adminStatus.type}`}>{adminStatus.message}</div> : null}
          </div>

          {!currentUser.isAdmin ? (
            <div className="upload-section">
              <div className="upload-box" style={{ justifyContent: 'space-between' }}>
                <div style={{ color: '#4a5568' }}>Bu sayfa sadece admin kullanıcılar içindir.</div>
                <button className="btn btn-secondary" type="button" onClick={() => setPage('main')}>
                  Geri
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="upload-section">
                <div className="upload-box" style={{ gap: 10, alignItems: 'end' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 220 }}>
                    <label style={{ fontSize: 12, fontWeight: 700, color: '#4a5568' }}>Kullanıcı Adı</label>
                    <input value={newUserName} onChange={(e) => setNewUserName(e.target.value)} placeholder="kullanıcı adı" />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 220 }}>
                    <label style={{ fontSize: 12, fontWeight: 700, color: '#4a5568' }}>Şifre</label>
                    <input value={newUserPassword} onChange={(e) => setNewUserPassword(e.target.value)} placeholder="şifre" type="password" />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 140 }}>
                    <label style={{ fontSize: 12, fontWeight: 700, color: '#4a5568' }}>Yetki</label>
                    <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: '#2d3748', fontSize: 13 }}>
                      <input type="checkbox" checked={newUserIsAdmin} onChange={(e) => setNewUserIsAdmin(e.target.checked)} />
                      Admin
                    </label>
                  </div>
                  <button
                    className="btn btn-primary"
                    type="button"
                    onClick={async () => {
                      const u = newUserName.trim()
                      const p = newUserPassword
                      if (!u || !p) {
                        setAdminStatus({ type: 'error', message: 'Kullanıcı adı ve şifre zorunlu' })
                        return
                      }
                      setAdminStatus({ type: 'info', message: 'Kullanıcı oluşturuluyor...' })
                      const r = await createUserAsAdmin({
                        userName: currentUser.userName,
                        newUserName: u,
                        password: p,
                        isAdmin: newUserIsAdmin,
                      })
                      if (!r.ok) {
                        setAdminStatus({ type: 'error', message: r.message || 'Kullanıcı oluşturulamadı' })
                        return
                      }
                      setNewUserName('')
                      setNewUserPassword('')
                      setNewUserIsAdmin(false)
                      const list = await fetchUsers({ userName: currentUser.userName })
                      if (list.ok) setAdminUsers(list.users)
                      setAdminStatus({ type: 'success', message: 'Kullanıcı oluşturuldu' })
                    }}
                  >
                    Ekle
                  </button>
                </div>
              </div>

              <div className="table-section">
                <div className="table-header">
                  <span className="table-title">Kullanıcılar</span>
                  <div className="actions"></div>
                </div>
                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr>
                        <th>Kullanıcı</th>
                        <th>Admin</th>
                        <th>Aktif</th>
                        <th>Oluşturma</th>
                      </tr>
                    </thead>
                    <tbody>
                      {adminUsersLoading ? (
                        <tr>
                          <td colSpan={4} style={{ textAlign: 'center', color: '#718096' }}>
                            Yükleniyor...
                          </td>
                        </tr>
                      ) : adminUsers.length === 0 ? (
                        <tr>
                          <td colSpan={4} style={{ textAlign: 'center', color: '#718096' }}>
                            Kayıt yok
                          </td>
                        </tr>
                      ) : (
                        adminUsers.map((u) => (
                          <tr key={u.userName}>
                            <td>{u.userName}</td>
                            <td>{u.isAdmin ? 'Evet' : 'Hayır'}</td>
                            <td>{u.isActive ? 'Evet' : 'Hayır'}</td>
                            <td>{u.createdAt ? formatDateTimeTr(u.createdAt) : '-'}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="table-section">
                <div className="table-header">
                  <span className="table-title">Veri Silme</span>
                  <div className="actions"></div>
                </div>
                <div className="upload-section">
                  <div className="upload-box" style={{ gap: 10, alignItems: 'end', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 180 }}>
                      <label style={{ fontSize: 12, fontWeight: 700, color: '#4a5568' }}>Tarih</label>
                      <select value={adminDeleteDate} onChange={(e) => setAdminDeleteDate(e.target.value)}>
                        <option value="">Seçiniz</option>
                        {dateOptions.map((d) => (
                          <option key={d} value={d}>
                            {formatDateTr(d)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 180 }}>
                      <label style={{ fontSize: 12, fontWeight: 700, color: '#4a5568' }}>Depo</label>
                      <select value={adminDeleteDepot} disabled={!adminDeleteDate.trim() || adminDeleteDepotOptions.length === 0} onChange={(e) => setAdminDeleteDepot(e.target.value)}>
                        <option value="">Seçiniz</option>
                        {adminDeleteDepotOptions.map((d) => (
                          <option key={d} value={d}>
                            {depotLabel(d)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      className="btn btn-secondary"
                      type="button"
                      onClick={async () => {
                        if (!adminDeleteDate.trim() || !adminDeleteDepot.trim()) {
                          setAdminStatus({ type: 'error', message: 'Tarih ve depo zorunlu' })
                          return
                        }
                        const ok = window.confirm(`${formatDateTr(adminDeleteDate)} • ${depotLabel(adminDeleteDepot)} için tüm veriler silinsin mi?`)
                        if (!ok) return
                        setAdminStatus({ type: 'info', message: 'Siliniyor...' })
                        const r = await deleteDataByDateDepot({
                          userName: currentUser.userName,
                          date: adminDeleteDate.trim(),
                          depot: adminDeleteDepot.trim(),
                        })
                        if (!r.ok) {
                          setAdminStatus({ type: 'error', message: r.message || 'Silinemedi' })
                          return
                        }
                        const list = await fetchImportFiles()
                        if (list.ok) setImportFiles(list.files)
                        setSelectedPosition(null)
                        setAdminStatus({ type: 'success', message: 'Silindi' })
                      }}
                    >
                      Tarih + Depo Sil
                    </button>
                  </div>

                  <div className="upload-box" style={{ gap: 10, alignItems: 'end', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 420 }}>
                      <label style={{ fontSize: 12, fontWeight: 700, color: '#4a5568' }}>Yükleme (Dosya)</label>
                      <select value={adminDeleteFileName} onChange={(e) => setAdminDeleteFileName(e.target.value)}>
                        <option value="">Seçiniz</option>
                        {adminImportFileOptions.map((f) => (
                          <option key={f.fileName} value={f.fileName}>
                            {(f.fileName ?? '').trim()} • {(f.importedAt ? formatDateTimeTr(f.importedAt) : '-')} • {(f.fileDate ? formatDateTr(f.fileDate) : '-')} • {(f.depotCode ? depotLabel(f.depotCode) : '-')}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      className="btn btn-secondary"
                      type="button"
                      onClick={async () => {
                        const name = adminDeleteFileName.trim()
                        if (!name) {
                          setAdminStatus({ type: 'error', message: 'Dosya seçimi zorunlu' })
                          return
                        }
                        const ok = window.confirm(`${name} için tüm veriler silinsin mi?`)
                        if (!ok) return
                        setAdminStatus({ type: 'info', message: 'Siliniyor...' })
                        const r = await deleteDataByImportFile({ userName: currentUser.userName, fileName: name })
                        if (!r.ok) {
                          setAdminStatus({ type: 'error', message: r.message || 'Silinemedi' })
                          return
                        }
                        const list = await fetchImportFiles()
                        if (list.ok) setImportFiles(list.files)
                        setSelectedPosition(null)
                        setAdminStatus({ type: 'success', message: 'Silindi' })
                      }}
                    >
                      Yüklemeye Göre Sil
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </>
      ) : page === 'mutabakat' ? (
        <>
          <div className="header">
            <h1>Mutabakat</h1>
            <p>{selectedPosition ? `${selectedPosition} • ${selectedDataset.date ? formatDateTr(selectedDataset.date) : '-'} • ${selectedDataset.depot ? depotLabel(selectedDataset.depot) : '-'}` : 'Lütfen önce pozisyon seçin'}</p>
            {status ? <div className={`upload-status ${status.type}`}>{status.message}</div> : null}
          </div>

          {!selectedPosition ? (
            <div className="upload-section">
              <div className="upload-box" style={{ justifyContent: 'space-between' }}>
                <div style={{ color: '#4a5568' }}>Mutabakat için önce pozisyon seçmelisiniz.</div>
                <button className="btn btn-primary" type="button" onClick={() => setPage('main')}>
                  Pozisyon Seç
                </button>
              </div>
            </div>
          ) : (
            <div className="flow">
              <div className="flow-steps">
                <button className={`flow-step ${mutabakatStep === 0 ? 'active' : ''}`} type="button" onClick={() => setMutabakatStep(0)}>
                  1. Düzeltmeler
                </button>
                <button className={`flow-step ${mutabakatStep === 1 ? 'active' : ''}`} type="button" onClick={() => setMutabakatStep(1)}>
                  2. Ödeme
                </button>
                <button
                  className={`flow-step ${mutabakatStep === 2 ? 'active' : ''}`}
                  type="button"
                  onClick={() => {
                    if (mutabakatStep === 0) {
                      setStatus({ type: 'info', message: 'Önce ödeme adımını tamamlayın' })
                      setMutabakatStep(1)
                      return
                    }
                    if (!validatePaymentInputs()) return
                    setMutabakatStep(2)
                  }}
                >
                  3. Özet & İşlemler
                </button>
              </div>

              <div className="flow-body">
                {mutabakatStep === 0 ? (
                  <div className="mutabakat">
                    <div className="mutabakat-section-title">Düzeltme Kayıtları</div>
                    <div className="mutabakat-actions">
                      <button className="btn btn-secondary" type="button" onClick={addMutabakatAdjustment} disabled={mutabakatSaved?.status === 'COMPLETED'}>
                        Kayıt Ekle
                      </button>
                      <div className="mutabakat-hint">{Math.abs(mutabakatFark) < 0.01 ? 'Fark 0. Mutabakatı tamamla aktif.' : ''}</div>
                    </div>
                    <table className="mini-table">
                      <thead>
                        <tr>
                          <th>Tip</th>
                          <th>Açıklama</th>
                          <th>Tutar</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {mutabakatAdjustments.length === 0 ? (
                          <tr>
                            <td colSpan={4} style={{ textAlign: 'center', color: '#718096' }}>
                              Kayıt yok
                            </td>
                          </tr>
                        ) : (
                          mutabakatAdjustments.map((a) => (
                            <tr key={a.id}>
                              <td>
                                <select
                                  value={a.type}
                                  onChange={(e) => setMutabakatAdjustments((prev) => prev.map((x) => (x.id === a.id ? { ...x, type: e.target.value as MutabakatAdjustment['type'] } : x)))}
                                  disabled={mutabakatSaved?.status === 'COMPLETED'}
                                >
                                  <option value="ACIK">Temsilci Açığı</option>
                                  <option value="HATALI_TAHSILAT">Hatalı Tahsilat</option>
                                  <option value="DIGER">Diğer</option>
                                </select>
                              </td>
                              <td>
                                <input
                                  value={a.description ?? ''}
                                  onChange={(e) => setMutabakatAdjustments((prev) => prev.map((x) => (x.id === a.id ? { ...x, description: e.target.value } : x)))}
                                  disabled={mutabakatSaved?.status === 'COMPLETED'}
                                />
                              </td>
                              <td>
                                <input
                                  type="number"
                                  value={a.amount || ''}
                                  onChange={(e) => setMutabakatAdjustments((prev) => prev.map((x) => (x.id === a.id ? { ...x, amount: Number(e.target.value || 0) } : x)))}
                                  disabled={mutabakatSaved?.status === 'COMPLETED'}
                                />
                              </td>
                              <td>
                                <button
                                  className="btn btn-secondary"
                                  type="button"
                                  onClick={() => setMutabakatAdjustments((prev) => prev.filter((x) => x.id !== a.id))}
                                  disabled={mutabakatSaved?.status === 'COMPLETED'}
                                >
                                  Sil
                                </button>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>

                    <div className="mutabakat-section-title">Fatura ve Tahsilatlar</div>
                    <div className="tabs">
                      <button className={`tab ${mutabakatCorrectionsTab === 'faturalar' ? 'active' : ''}`} type="button" onClick={() => setMutabakatCorrectionsTab('faturalar')}>
                        Tüm Faturalar
                      </button>
                      <button className={`tab ${mutabakatCorrectionsTab === 'tahsilatlar' ? 'active' : ''}`} type="button" onClick={() => setMutabakatCorrectionsTab('tahsilatlar')}>
                        Tüm Tahsilatlar
                      </button>
                    </div>

                    <div className="table-search">
                      <input value={mutabakatCorrectionsSearch} onChange={(e) => setMutabakatCorrectionsSearch(e.target.value)} placeholder="Ara (müşteri, vergi no, fatura no...)" />
                      <button className="btn btn-secondary" type="button" onClick={() => setMutabakatCorrectionsSearch('')} disabled={!mutabakatCorrectionsSearch.trim()}>
                        Temizle
                      </button>
                    </div>

                    {mutabakatCorrectionsTab === 'faturalar' ? (
                      <table className="mini-table">
                        <thead>
                          <tr>
                            <th>Müşteri</th>
                            <th>Vergi No</th>
                            <th>Fatura</th>
                            <th>Tutar</th>
                            <th>Ödeme Tipi</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {mutabakatInvoicesForEdit.length === 0 ? (
                            <tr>
                              <td colSpan={6} style={{ textAlign: 'center', color: '#718096' }}>
                                Kayıt yok
                              </td>
                            </tr>
                          ) : (
                            mutabakatInvoicesForEdit.map((inv) => {
                              const total = invoiceTotalAmount(inv)
                              const allocs = getInvoiceAllocations(inv, invoiceAllocations)
                              return (
                                <tr key={inv.code}>
                                  <td>{inv.customer.registeredName}</td>
                                  <td>{inv.customer.taxNumber ?? '-'}</td>
                                  <td>{inv.code}</td>
                                  <td>{formatMoney(total)}</td>
                                  <td>{allocationSummary(allocs)}</td>
                                  <td>
                                    <button className="btn btn-secondary" type="button" onClick={() => setEditingInvoice(inv)}>
                                      Düzenle
                                    </button>
                                  </td>
                                </tr>
                              )
                            })
                          )}
                        </tbody>
                      </table>
                    ) : (
                      <table className="mini-table">
                        <thead>
                          <tr>
                            <th>Müşteri</th>
                            <th>Vergi No</th>
                            <th>Fatura</th>
                            <th>Tutar</th>
                            <th>Ödeme Tipi</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {mutabakatPaymentsForEdit.length === 0 ? (
                            <tr>
                              <td colSpan={6} style={{ textAlign: 'center', color: '#718096' }}>
                                Kayıt yok
                              </td>
                            </tr>
                          ) : (
                            mutabakatPaymentsForEdit.map((r) => (
                              <tr key={r.key}>
                                <td>{r.c.customer.registeredName}</td>
                                <td>{r.c.customer.taxNumber ?? '-'}</td>
                                <td>{r.c.invoiceCode ?? '-'}</td>
                                <td>{formatMoney(r.c.amount ?? 0)}</td>
                                <td>{allocationSummary(r.allocs)}</td>
                                <td>
                                  <button className="btn btn-secondary" type="button" onClick={() => setEditingPayment({ collection: r.c, key: r.key })}>
                                    Düzenle
                                  </button>
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    )}
                  </div>
                ) : mutabakatStep === 1 ? (
                  <div className="mutabakat">
                    <div className="mutabakat-meta">
                      <div className="mutabakat-meta-row">
                        <div className="mutabakat-label">Tarih</div>
                        <div className="mutabakat-value">{selectedDataset.date ? formatDateTr(selectedDataset.date) : '-'}</div>
                      </div>
                      <div className="mutabakat-meta-row">
                        <div className="mutabakat-label">Depo</div>
                        <div className="mutabakat-value">{selectedDataset.depot ? depotLabel(selectedDataset.depot) : '-'}</div>
                      </div>
                      <div className="mutabakat-meta-row">
                        <div className="mutabakat-label">Pozisyon</div>
                        <div className="mutabakat-value">{selectedPosition ?? '-'}</div>
                      </div>
                      <div className="mutabakat-meta-row">
                        <div className="mutabakat-label">Torba Tutarı</div>
                        <div className="mutabakat-value">{formatMoney(torbaTutari)}</div>
                      </div>
                    </div>

                    <div className="mutabakat-choice">
                      <label className="mutabakat-radio">
                        <input
                          type="checkbox"
                          checked={cashEnabled}
                          disabled={mutabakatSaved?.status === 'COMPLETED'}
                          onChange={(e) => {
                            const nextCash = e.target.checked
                            const nextBank = bankEnabled
                            if (!nextCash && !nextBank) return
                            setMutabakatMode(nextCash && nextBank ? 'KARMA' : nextCash ? 'NAKIT' : 'BANKA')
                          }}
                        />
                        <span>Nakit</span>
                      </label>
                      <label className="mutabakat-radio">
                        <input
                          type="checkbox"
                          checked={bankEnabled}
                          disabled={mutabakatSaved?.status === 'COMPLETED'}
                          onChange={(e) => {
                            const nextBank = e.target.checked
                            const nextCash = cashEnabled
                            if (!nextCash && !nextBank) return
                            setMutabakatMode(nextCash && nextBank ? 'KARMA' : nextCash ? 'NAKIT' : 'BANKA')
                          }}
                        />
                        <span>Bankaya Yatan</span>
                      </label>
                    </div>

                    {cashEnabled ? (
                      <>
                        <div className="mutabakat-section-title">Banknot Döküm Listesi</div>
                        <table className="mini-table">
                          <thead>
                            <tr>
                              <th>Banknot</th>
                              <th>Adet</th>
                              <th>Tutar</th>
                            </tr>
                          </thead>
                          <tbody>
                            {BANKNOTES.map((d) => {
                              const count = banknoteCounts[d] ?? 0
                              const total = d * count
                              return (
                                <tr key={d}>
                                  <td>{d}</td>
                                  <td>
                                    <input
                                      type="number"
                                      min={0}
                                      value={count || ''}
                                      disabled={mutabakatSaved?.status === 'COMPLETED'}
                                      onChange={(e) => {
                                        const next = Math.max(0, Number(e.target.value || 0))
                                        setBanknoteCounts((prev) => ({ ...prev, [d]: next }))
                                      }}
                                    />
                                  </td>
                                  <td>{formatMoney(total)}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </>
                    ) : null}

                    {bankEnabled ? (
                      <>
                        <div className="mutabakat-section-title">Bankaya Yatan</div>
                        <div className="mutabakat-form">
                          <div className="mutabakat-field">
                            <label>Banka</label>
                            <select value={bankName} onChange={(e) => setBankName(e.target.value)} disabled={mutabakatSaved?.status === 'COMPLETED'}>
                              <option value="">Seçiniz</option>
                              {BANKS.map((b) => (
                                <option key={b} value={b}>
                                  {b}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="mutabakat-field">
                            <label>Yatan Tutar</label>
                            <input
                              type="number"
                              value={yatanTutar || ''}
                              disabled={mutabakatSaved?.status === 'COMPLETED'}
                              onChange={(e) => setYatanTutar(Number(e.target.value || 0))}
                            />
                          </div>
                          <div className="mutabakat-field">
                            <label>Manim Dekont No</label>
                            <input
                              value={manimDekontNo}
                              disabled={mutabakatSaved?.status === 'COMPLETED'}
                              onChange={(e) => {
                                setManimDekontNo(e.target.value)
                                setAutoDekontNo(null)
                              }}
                            />
                          </div>
                          <div className="mutabakat-field">
                            <label>Ödeme Açıklaması</label>
                            <input value={bankExplanation} readOnly />
                          </div>
                          <div className="mutabakat-field">
                            <label>İşlem Tarihi</label>
                            <input value={bankReceiptDateTime ? formatDateTimeTr(bankReceiptDateTime) : ''} readOnly />
                          </div>
                          {manimDekontCandidates.length > 0 ? (
                            <div className="mutabakat-field">
                              <label>Yakın Tutarlar</label>
                              <select
                                value=""
                                disabled={mutabakatSaved?.status === 'COMPLETED'}
                                onChange={(e) => {
                                  const receiptNo = e.target.value
                                  if (!receiptNo) return
                                  const selected = manimDekontCandidates.find((x) => x.receiptNo === receiptNo) ?? null
                                  if (selected) {
                                    setYatanTutar(Number(selected.amount) || 0)
                                    setBankReceiptDateTime(String(selected.receiptDate ?? '').trim())
                                    setBankExplanation(String(selected.explanation ?? '').trim())
                                  }
                                  setManimDekontNo(receiptNo)
                                  setAutoDekontNo(receiptNo)
                                  setManimDekontCandidates([])
                                }}
                              >
                                <option value="">Seçiniz</option>
                                {manimDekontCandidates.map((c) => (
                                  <option key={`${c.receiptNo}|${c.receiptDate}`} value={c.receiptNo}>
                                    {[
                                      c.receiptNo,
                                      formatMoney(c.amount),
                                      `fark ${formatMoney(c.amountDiff)}`,
                                      c.dayDiff === 0 ? 'aynı gün' : '+/-1 gün',
                                      (c.bankAccountLabel ?? '').trim(),
                                      (c.explanation ?? '').trim(),
                                    ]
                                      .filter((x) => String(x ?? '').trim())
                                      .join(' • ')}
                                  </option>
                                ))}
                              </select>
                            </div>
                          ) : null}
                        </div>
                      </>
                    ) : null}

                    {bankEnabled ? (
                      <>
                        <div className="mutabakat-section-title">Manim Hareketleri</div>
                        <div className="mutabakat-form">
                          <div className="mutabakat-field" style={{ gridColumn: '1 / -1' }}>
                            <label>Arama</label>
                            <input value={manimReceiptSearch} onChange={(e) => setManimReceiptSearch(e.target.value)} placeholder="Dekont no / açıklama / tutar" />
                          </div>
                        </div>
                        <table className="mini-table">
                          <thead>
                            <tr>
                              <th>Tarih</th>
                              <th>Dekont</th>
                              <th>Tutar</th>
                              <th>Hesap</th>
                              <th>Açıklama</th>
                              <th></th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredManimReceipts.length === 0 ? (
                              <tr>
                                <td colSpan={6} style={{ textAlign: 'center', color: '#718096' }}>
                                  Kayıt yok
                                </td>
                              </tr>
                            ) : (
                              filteredManimReceipts.slice(0, 50).map((r) => (
                                <tr key={`${r.receiptNo}|${r.receiptDate}|${r.amount}`}>
                                  <td>{formatDateTimeTr(r.receiptDate)}</td>
                                  <td>{r.receiptNo}</td>
                                  <td>{formatMoney(Number(r.amount) || 0)}</td>
                                  <td>{(r.bankAccountLabel ?? '').trim() || '-'}</td>
                                  <td>{(r.explanation ?? '').trim() || '-'}</td>
                                  <td style={{ textAlign: 'right' }}>
                                    <button
                                      className="btn btn-secondary"
                                      type="button"
                                      disabled={mutabakatSaved?.status === 'COMPLETED'}
                                      onClick={() => {
                                        setYatanTutar(Number(r.amount) || 0)
                                        setManimDekontNo(String(r.receiptNo ?? '').trim())
                                        setAutoDekontNo(String(r.receiptNo ?? '').trim())
                                        setBankReceiptDateTime(String(r.receiptDate ?? '').trim())
                                        setBankExplanation(String(r.explanation ?? '').trim())
                                        setManimDekontCandidates([])
                                      }}
                                    >
                                      Seç
                                    </button>
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </>
                    ) : null}

                    <div className="mutabakat-totals">
                      <div>Girilen Toplam: {formatMoney(enteredTotal)}</div>
                      <div>Düzeltme: {formatMoney(adjustmentTotal)}</div>
                      <div>Fark: {formatMoney(mutabakatFark)}</div>
                    </div>
                  </div>
                ) : (
                  <div className="mutabakat">
                    <div className="mutabakat-section-title">Özet</div>
                    <div className="mutabakat-meta">
                      <div className="mutabakat-meta-row">
                        <div className="mutabakat-label">Torba Tutarı</div>
                        <div className="mutabakat-value">{formatMoney(torbaTutari)}</div>
                      </div>
                      <div className="mutabakat-meta-row">
                        <div className="mutabakat-label">Nakit Toplam</div>
                        <div className="mutabakat-value">{cashEnabled ? formatMoney(cashTotal) : '-'}</div>
                      </div>
                      <div className="mutabakat-meta-row">
                        <div className="mutabakat-label">Bankaya Yatan</div>
                        <div className="mutabakat-value">{bankEnabled ? formatMoney(Number(yatanTutar) || 0) : '-'}</div>
                      </div>
                      <div className="mutabakat-meta-row">
                        <div className="mutabakat-label">Girilen Toplam</div>
                        <div className="mutabakat-value">{formatMoney(enteredTotal)}</div>
                      </div>
                      <div className="mutabakat-meta-row">
                        <div className="mutabakat-label">Düzeltme</div>
                        <div className="mutabakat-value">{formatMoney(adjustmentTotal)}</div>
                      </div>
                      <div className="mutabakat-meta-row">
                        <div className="mutabakat-label">Fark</div>
                        <div className="mutabakat-value">{formatMoney(mutabakatFark)}</div>
                      </div>
                    </div>

                    <div className="mutabakat-actions">
                      <button
                        className="btn btn-primary"
                        type="button"
                        onClick={saveMutabakatData}
                        disabled={!selectedDataset.date || !selectedDataset.depot || !selectedPosition || !summaryTotals || mutabakatSaved?.status === 'COMPLETED'}
                      >
                        Kaydet
                      </button>
                      <button
                        className="btn btn-secondary"
                        type="button"
                        onClick={completeMutabakatData}
                        disabled={!mutabakatSaved || mutabakatSaved.status === 'COMPLETED' || Math.abs(mutabakatFark) >= 0.01}
                      >
                        Mutabakatı Tamamla
                      </button>
                      <button className="btn btn-secondary" type="button" onClick={printMutabakatPdf} disabled={!mutabakatSaved || mutabakatSaved.status !== 'COMPLETED'}>
                        PDF Çıktı Al (A4)
                      </button>
                      <div className="mutabakat-status">{mutabakatSaved ? (mutabakatSaved.status === 'COMPLETED' ? 'Durum: Tamamlandı' : 'Durum: Taslak') : 'Durum: Kayıt yok'}</div>
                    </div>

                    <details className="mutabakat-details">
                      <summary>Ödeme Tipi Değişen Faturalar</summary>
                      <table className="mini-table">
                        <thead>
                          <tr>
                            <th>Bayi</th>
                            <th>Fatura</th>
                            <th>Dağılım</th>
                          </tr>
                        </thead>
                        <tbody>
                          {positionInvoices.filter((inv) => Array.isArray(invoiceAllocations[inv.code]) && (invoiceAllocations[inv.code]?.length ?? 0) > 0).length === 0 ? (
                            <tr>
                              <td colSpan={3} style={{ textAlign: 'center', color: '#718096' }}>
                                Kayıt yok
                              </td>
                            </tr>
                          ) : (
                            positionInvoices
                              .filter((inv) => Array.isArray(invoiceAllocations[inv.code]) && (invoiceAllocations[inv.code]?.length ?? 0) > 0)
                              .map((inv) => (
                                <tr key={inv.code}>
                                  <td>{inv.customer.registeredName}</td>
                                  <td>{inv.code}</td>
                                  <td>{allocationSummary(getInvoiceAllocations(inv, invoiceAllocations))}</td>
                                </tr>
                              ))
                          )}
                        </tbody>
                      </table>
                    </details>

                    <details className="mutabakat-details">
                      <summary>Ödeme Tipi Değişen Tahsilatlar</summary>
                      <table className="mini-table">
                        <thead>
                          <tr>
                            <th>Bayi</th>
                            <th>Fatura</th>
                            <th>Dağılım</th>
                          </tr>
                        </thead>
                        <tbody>
                          {positionCollections.filter((c) => {
                            const key = c.paymentKey ?? computePaymentKey(c.invoiceCode ?? '', c)
                            return Array.isArray(paymentAllocations[key]) && (paymentAllocations[key]?.length ?? 0) > 0
                          }).length === 0 ? (
                            <tr>
                              <td colSpan={3} style={{ textAlign: 'center', color: '#718096' }}>
                                Kayıt yok
                              </td>
                            </tr>
                          ) : (
                            positionCollections
                              .filter((c) => {
                                const key = c.paymentKey ?? computePaymentKey(c.invoiceCode ?? '', c)
                                return Array.isArray(paymentAllocations[key]) && (paymentAllocations[key]?.length ?? 0) > 0
                              })
                              .map((c) => {
                                const key = c.paymentKey ?? computePaymentKey(c.invoiceCode ?? '', c)
                                return (
                                  <tr key={key}>
                                    <td>{c.customer.registeredName}</td>
                                    <td>{c.invoiceCode ?? '-'}</td>
                                    <td>{allocationSummary(getPaymentAllocations(key, c, paymentAllocations))}</td>
                                  </tr>
                                )
                              })
                          )}
                        </tbody>
                      </table>
                    </details>

                    <details className="mutabakat-details">
                      <summary>Havale Tipli Faturalar</summary>
                      <table className="mini-table">
                        <thead>
                          <tr>
                            <th>Bayi</th>
                            <th>Tutar</th>
                          </tr>
                        </thead>
                        <tbody>
                          {havaleInvoicesByBayi.length === 0 ? (
                            <tr>
                              <td colSpan={2} style={{ textAlign: 'center', color: '#718096' }}>
                                Kayıt yok
                              </td>
                            </tr>
                          ) : (
                            havaleInvoicesByBayi.map((r) => (
                              <tr key={r.bayi}>
                                <td>{r.bayi}</td>
                                <td>{formatMoney(r.total)}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </details>

                    <details className="mutabakat-details">
                      <summary>Vadeli Tahsilat Havaleleri</summary>
                      <table className="mini-table">
                        <thead>
                          <tr>
                            <th>Bayi</th>
                            <th>Tutar</th>
                          </tr>
                        </thead>
                        <tbody>
                          {vadeliTahsilatHavaleleriByBayi.length === 0 ? (
                            <tr>
                              <td colSpan={2} style={{ textAlign: 'center', color: '#718096' }}>
                                Kayıt yok
                              </td>
                            </tr>
                          ) : (
                            vadeliTahsilatHavaleleriByBayi.map((r) => (
                              <tr key={r.bayi}>
                                <td>{r.bayi}</td>
                                <td>{formatMoney(r.total)}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </details>
                  </div>
                )}
              </div>

              <div className="flow-footer">
                <button className="btn btn-secondary" type="button" onClick={() => setMutabakatStep((s) => (s === 0 ? 0 : ((s - 1) as 0 | 1 | 2)))} disabled={mutabakatStep === 0}>
                  Geri
                </button>
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => {
                    if (mutabakatStep === 1 && !validatePaymentInputs()) return
                    setMutabakatStep((s) => (s === 2 ? 2 : ((s + 1) as 0 | 1 | 2)))
                  }}
                  disabled={mutabakatStep === 2}
                >
                  İleri
                </button>
              </div>
            </div>
          )}
        </>
      ) : !selectedPosition ? (
        <>
          <div className="header">
            <h1>Hesap Kapatma</h1>
            <p>Kullanıcı bazlı ekran</p>
          </div>

          <div className="filters">
            <div className="filter-group">
              <label>Tarih</label>
              <select
                value={selectedDate}
                onChange={(e) => {
                  setSelectedDate(e.target.value)
                  setSelectedPosition(null)
                  setTypeFilter(null)
                  setPositionTab('faturalar')
                }}
              >
                <option value="">Seçiniz</option>
                {dateOptions.map((d) => (
                  <option key={d} value={d}>
                    {formatDateTr(d)}
                  </option>
                ))}
              </select>
            </div>
            <div className="filter-group">
              <label>Depo</label>
              <select
                value={selectedDepot}
                disabled={!selectedDate.trim() || depotOptions.length === 0}
                onChange={(e) => {
                  setSelectedDepot(e.target.value)
                  setSelectedPosition(null)
                  setTypeFilter(null)
                  setPositionTab('faturalar')
                }}
              >
                <option value="">Seçiniz</option>
                {depotOptions.map((d) => (
                  <option key={d} value={d}>
                    {depotLabel(d)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="upload-section">
            <div className="upload-box">
              <input
                key={fileInputKey}
                type="file"
                accept=".json"
                multiple
                onChange={(e) => setSelectedFiles(Array.from(e.target.files ?? []))}
              />
              <button className="btn btn-primary" type="button" onClick={onUpload}>
                JSON Yükle (SQL)
              </button>
            </div>
            {selectedFiles.length > 0 ? (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 240 }}>
                    <label style={{ fontSize: 12, fontWeight: 700, color: '#4a5568' }}>Tüm dosyalar için depo</label>
                    <input
                      list="depot-list"
                      value={uploadBulkDepot}
                      onChange={(e) => setUploadBulkDepot(e.target.value)}
                      placeholder="depo kodu"
                    />
                  </div>
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={() => {
                      const value = uploadBulkDepot.trim()
                      if (!value) return
                      setUploadDepotMap(Object.fromEntries(selectedFiles.map((f) => [f.name, value])))
                    }}
                  >
                    Tümüne Uygula
                  </button>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {selectedFiles.map((f) => (
                    <div key={f.name} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <div style={{ flex: 1, minWidth: 240, color: '#2d3748' }}>{f.name}</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 180 }}>
                        <label style={{ fontSize: 12, fontWeight: 700, color: '#4a5568' }}>Depo</label>
                        <input
                          list="depot-list"
                          value={uploadDepotMap[f.name] ?? ''}
                          onChange={(e) => setUploadDepotMap((prev) => ({ ...prev, [f.name]: e.target.value }))}
                          placeholder="depo kodu"
                        />
                      </div>
                    </div>
                  ))}
                </div>

                <datalist id="depot-list">
                  {allDepotOptions.map((d) => (
                    <option key={d} value={d}>
                      {depotLabel(d)}
                    </option>
                  ))}
                </datalist>
              </div>
            ) : null}
            {importJobFiles.length > 0 ? (
              <div style={{ marginTop: 10, border: '1px solid #e2e8f0', borderRadius: 10, padding: 10, background: '#fff' }}>
                <div style={{ fontWeight: 700, color: '#2d3748', marginBottom: 8 }}>Import Pozisyon Durumu</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {importJobFiles.map((f) => (
                    <div key={f.fileName} style={{ border: '1px solid #edf2f7', borderRadius: 8, padding: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                        <div style={{ fontWeight: 700, color: '#2d3748' }}>{f.fileName}</div>
                        <div style={{ color: '#4a5568', fontWeight: 700 }}>%{f.progressPercent ?? 0}</div>
                      </div>
                      <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {(f.positions ?? []).map((p) => {
                          const done = p.processedInvoices + p.processedCollections
                          const total = p.totalInvoices + p.totalCollections
                          const isDone = p.status === 'imported'
                          const isSkipped = p.status === 'skipped'
                          return (
                            <div
                              key={`${f.fileName}-${p.positionCode}`}
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                gap: 10,
                                flexWrap: 'wrap',
                                padding: '4px 6px',
                                borderRadius: 6,
                                background: isDone ? '#f0fff4' : isSkipped ? '#fffaf0' : '#f7fafc',
                                color: '#2d3748',
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span>{p.positionCode}</span>
                                {isDone ? <span style={{ color: '#2f855a', fontWeight: 700 }}>✓</span> : null}
                                {isSkipped ? <span style={{ color: '#b7791f', fontWeight: 700 }}>⏭</span> : null}
                              </div>
                              <div style={{ color: '#4a5568', fontSize: 12 }}>
                                %{p.progressPercent} ({done}/{total})
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <div className={`upload-status ${status?.type ?? ''}`}>{status?.message ?? ''}</div>
          </div>

          <div className="position-list">
            {positionsLoading ? (
              <div className="empty">Pozisyonlar yükleniyor...</div>
            ) : !selectedDataset.date ? (
              <div className="empty">Önce tarih seçin.</div>
            ) : !selectedDataset.depot ? (
              <div className="empty">Önce depo seçin.</div>
            ) : positions.length === 0 ? (
              <div className="empty">Önce JSON yükleyin.</div>
            ) : (
              positions.map((p) => (
                <div
                  key={p.code}
                  className={`card ${p.mutabakatStatus === 'COMPLETED' ? 'completed' : ''}`}
                  onClick={() => {
                    setSelectedPosition(p.code)
                    setTypeFilter(null)
                    setPositionTab('faturalar')
                  }}
                >
                  <div className="card-header">
                    <div>
                      <div className="card-title">Pozisyon</div>
                      <div className="card-code">{p.code}</div>
                    </div>
                    <div className="card-title">{p.invoiceCount} fatura</div>
                  </div>
                  <div className="card-title">{p.description ?? ''}</div>
                  <div className="card-title">Torba: {formatMoney(Number(p.torbaTutari ?? 0))}</div>
                </div>
              ))
            )}
          </div>
        </>
      ) : (
        <>
          <div className="header">
            <h1>{selectedPosition}</h1>
            <p>Pozisyon hesabı</p>
            {status ? <div className={`upload-status ${status.type}`}>{status.message}</div> : null}
          </div>

          <div className="table-section">
            <div className="tabs">
              <button
                className={`tab ${positionTab === 'faturalar' ? 'active' : ''}`}
                type="button"
                onClick={() => {
                  setPositionTab('faturalar')
                  setTypeFilter(null)
                  setDetailSearch('')
                }}
              >
                Faturalar
              </button>
              <button
                className={`tab ${positionTab === 'tahsilatlar' ? 'active' : ''}`}
                type="button"
                onClick={() => {
                  setPositionTab('tahsilatlar')
                  setTypeFilter(null)
                  setDetailSearch('')
                }}
              >
                Tahsilatlar
              </button>
            </div>

            <div className="table-header">
              <span className="table-title">{positionTab === 'faturalar' ? 'Özet (Faturalar)' : 'Özet (Tahsilatlar)'}</span>
              <div className="actions">
                <button className="btn btn-secondary" type="button" onClick={openMutabakat} disabled={!summaryTotals}>
                  Mutabakat Ekranı
                </button>
              </div>
            </div>

            <div className="table-scroll">
              {summaryTotals ? (
                <div className="summary-table">
                  <div
                    className="summary-row clickable"
                    onClick={() => {
                      setPositionTab('faturalar')
                      setTypeFilter('HAVALE')
                    }}
                  >
                    <div>HAVALE</div>
                    <div>{formatMoney(summaryTotals.havaleTutari)}</div>
                  </div>
                  {summaryTotals.iskontoToplam > 0 ? (
                    <div className="summary-row">
                      <div>İSKONTO TOPLAMI</div>
                      <div>{formatMoney(summaryTotals.iskontoToplam)}</div>
                    </div>
                  ) : null}
                  <div
                    className="summary-row clickable"
                    onClick={() => {
                      setPositionTab('faturalar')
                      setTypeFilter('NAKIT')
                    }}
                  >
                    <div>NAKİT TOPLAM</div>
                    <div>{formatMoney(summaryTotals.nakitToplam)}</div>
                  </div>
                  <div
                    className="summary-row clickable"
                    onClick={() => {
                      setPositionTab('tahsilatlar')
                      setTypeFilter('VADETAHHAV')
                    }}
                  >
                    <div>VADELİ TAHSİLAT HAVALE</div>
                    <div>{formatMoney(summaryTotals.vadeliTahsilatHavale)}</div>
                  </div>
                  <div className="summary-row total">
                    <div>TOPLAM NAKİT (Torba Tutarı)</div>
                    <div>{formatMoney(summaryTotals.torbaTutari)}</div>
                  </div>
                  <div className="summary-row">
                    <div>FARK (Mutabakat)</div>
                    <div>{mutabakatSaved ? formatMoney(mutabakatSaved.diffAmount) : '-'}</div>
                  </div>
                </div>
              ) : null}

              <div className="table-search">
                <input
                  value={detailSearch}
                  onChange={(e) => setDetailSearch(e.target.value)}
                  placeholder={positionTab === 'faturalar' ? 'Ara (müşteri, vergi no, fatura no...)' : 'Ara (müşteri, vergi no, fatura no...)'}
                />
                <button className="btn btn-secondary" type="button" onClick={() => setDetailSearch('')} disabled={!detailSearch.trim()}>
                  Temizle
                </button>
              </div>

              <div className="table-wrapper">
                {positionTab === 'faturalar' ? (
                  <table>
                    <thead>
                      <tr>
                        <th>Müşteri</th>
                        <th>Vergi No</th>
                        <th>Tutar</th>
                        <th>Ödeme Tipi</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailInvoices.length === 0 ? (
                        <tr>
                          <td colSpan={5} style={{ textAlign: 'center', color: '#718096' }}>
                            Detay bulunamadı
                          </td>
                        </tr>
                      ) : (
                        detailInvoices.map((inv) => {
                          const total = invoiceTotalAmount(inv)
                          const allocs = getInvoiceAllocations(inv, invoiceAllocations)
                          const selectedAmount = typeFilter ? allocationAmountForType(allocs, typeFilter) : total
                          return (
                            <tr key={inv.code}>
                              <td>{inv.customer.registeredName}</td>
                              <td>{inv.customer.taxNumber}</td>
                              <td>{formatMoney(total)}</td>
                              <td>{typeFilter ? `${paymentTypeLabel(typeFilter)}: ${formatMoney(selectedAmount)}` : allocationSummary(allocs)}</td>
                              <td>
                                <button className="btn btn-secondary" type="button" onClick={() => setEditingInvoice(inv)}>
                                  Düzenle
                                </button>
                              </td>
                            </tr>
                          )
                        })
                      )}
                    </tbody>
                  </table>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>Müşteri</th>
                        <th>Ödeme Tipi</th>
                        <th>Tutar</th>
                        <th>Tarih</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailPayments.length === 0 ? (
                        <tr>
                          <td colSpan={5} style={{ textAlign: 'center', color: '#718096' }}>
                            Detay bulunamadı
                          </td>
                        </tr>
                      ) : (
                        detailPayments.map((r) => {
                          const selectedAmount = typeFilter ? allocationAmountForType(r.allocs, typeFilter) : r.c.amount
                          return (
                            <tr key={r.key}>
                              <td>{r.c.customer.registeredName}</td>
                              <td>{typeFilter ? paymentTypeLabel(typeFilter) : r.c.paymentFormDescription ?? r.c.paymentFormCode ?? '-'}</td>
                              <td>{formatMoney(selectedAmount)}</td>
                              <td>{formatDateTr(r.c.issueDate)}</td>
                              <td>
                                <button className="btn btn-secondary" type="button" onClick={() => setEditingPayment({ collection: r.c, key: r.key })}>
                                  Düzenle
                                </button>
                              </td>
                            </tr>
                          )
                        })
                      )}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>

        </>
      )}

      <Modal
        title={editingInvoice ? `Fatura Tip Dağılımı - ${editingInvoice.code}` : ''}
        open={!!editingInvoice}
        onClose={() => setEditingInvoice(null)}
        size="wide"
      >
        {editingInvoice ? (
          <AllocationEditor
            editorKey={editingInvoice.code}
            title="Fatura"
            total={invoiceTotalAmount(editingInvoice)}
            allocations={getInvoiceAllocations(editingInvoice, invoiceAllocations)}
            onChange={(next) => updateInvoiceAllocations(editingInvoice.code, next)}
          />
        ) : null}
      </Modal>

      <Modal
        title={editingPayment ? `Tahsilat Tip Dağılımı - ${editingPayment.collection.invoiceCode ?? ''}` : ''}
        open={!!editingPayment}
        onClose={() => setEditingPayment(null)}
        size="wide"
      >
        {editingPayment ? (
          <AllocationEditor
            editorKey={editingPayment.key}
            title="Tahsilat"
            total={editingPayment.collection.amount ?? 0}
            allocations={getPaymentAllocations(editingPayment.key, editingPayment.collection, paymentAllocations)}
            onChange={(next) => updatePaymentAllocations(editingPayment.key, next)}
          />
        ) : null}
      </Modal>
          </div>
        </main>
      </div>
    </div>
  )
}
