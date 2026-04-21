import { type ReactNode, useEffect, useMemo, useState } from 'react'
import {
  fetchImportFiles,
  fetchPositionData,
  fetchPositions,
  importSalesFiles,
  saveInvoiceAllocationsSql,
  savePaymentAllocationsSql,
  type ImportFileRow,
  type PositionRow,
} from './data/api'
import { clearSessionUser, loadSessionUser, saveSessionUser } from './data/local'
import { toCsv } from './domain/csv'
import { transferAmount, type Allocation, allocationAmountForType, computePaymentKey, getInvoiceAllocations, getPaymentAllocations, invoiceTotalAmount } from './domain/allocations'
import { formatDateTr, formatMoney } from './domain/format'
import type { Collection, Invoice } from './domain/models'
import { PAYMENT_TYPES, type PaymentType, paymentTypeLabel } from './domain/paymentTypes'

type StatusType = 'success' | 'error' | 'info'

function downloadCsv(csv: string, fileName: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = fileName
  link.click()
}

function sumAllocations(allocs: Allocation[]) {
  return allocs.reduce((s, a) => s + (a.amount ?? 0), 0)
}

function allocationSummary(allocs: Allocation[]) {
  return allocs
    .filter((a) => (a.amount ?? 0) > 0)
    .map((a) => `${paymentTypeLabel(a.type)}: ${formatMoney(a.amount)}`)
    .join(' / ')
}

type SqlCollectionRow = Collection & { paymentKey?: string }

function LoginPage(props: { onLogin: (userId: string) => void }) {
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
                const json = (await res.json()) as { ok: boolean; userName: string }
                if (!json.ok) throw new Error('Giriş başarısız')
                props.onLogin(json.userName)
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

function Modal(props: { title: string; open: boolean; onClose: () => void; children: ReactNode }) {
  if (!props.open) return null
  return (
    <div className="modal-backdrop" onClick={props.onClose} role="presentation">
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
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
  title: string
  total: number
  allocations: Allocation[]
  onChange: (next: Allocation[]) => void
}) {
  const [from, setFrom] = useState<PaymentType>('HAVALE')
  const [to, setTo] = useState<PaymentType>('NAKIT')
  const [amount, setAmount] = useState<number>(0)

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
  const [currentUser, setCurrentUser] = useState<string | null>(() => loadSessionUser())
  const [status, setStatus] = useState<{ type: StatusType; message: string } | null>(null)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [fileInputKey, setFileInputKey] = useState(0)
  const [selectedPosition, setSelectedPosition] = useState<string | null>(null)

  const [importFiles, setImportFiles] = useState<ImportFileRow[]>([])
  const [selectedDatasetKey, setSelectedDatasetKey] = useState<string>('')

  const [positions, setPositions] = useState<PositionRow[]>([])
  const [positionsLoading, setPositionsLoading] = useState(false)

  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [collections, setCollections] = useState<SqlCollectionRow[]>([])
  const [invoiceAllocations, setInvoiceAllocations] = useState<Record<string, Allocation[]>>({})
  const [paymentAllocations, setPaymentAllocations] = useState<Record<string, Allocation[]>>({})

  const [positionTab, setPositionTab] = useState<'faturalar' | 'tahsilatlar'>('faturalar')
  const [typeFilter, setTypeFilter] = useState<PaymentType | null>(null)
  const [cashListOpen, setCashListOpen] = useState(false)
  const [editingInvoice, setEditingInvoice] = useState<Invoice | null>(null)
  const [editingPayment, setEditingPayment] = useState<{ collection: Collection; key: string } | null>(null)

  useEffect(() => {
    if (!currentUser) return
    fetchImportFiles()
      .then((r) => {
        if (!r.ok) throw new Error(r.message || 'Import listesi alınamadı')
        setImportFiles(r.files)
        if (r.files.length > 0 && !selectedDatasetKey) {
          const first = r.files[0]
          const key = `${first.fileDate ?? ''}|${first.depotCode ?? ''}`
          setSelectedDatasetKey(key)
        }
      })
      .catch((e) => {
        setStatus({ type: 'error', message: e instanceof Error ? e.message : 'Import listesi alınamadı' })
        setImportFiles([])
      })
  }, [currentUser, selectedDatasetKey])

  const selectedDataset = useMemo(() => {
    if (selectedDatasetKey === 'all') return { date: null as string | null, depot: null as string | null }
    const [date, depot] = selectedDatasetKey.split('|')
    return { date: date || null, depot: depot || null }
  }, [selectedDatasetKey])

  const datasetOptions = useMemo(() => {
    const seen = new Set<string>()
    const items: Array<{ key: string; label: string; date?: string; depot?: string }> = []
    for (const f of importFiles) {
      const key = `${f.fileDate ?? ''}|${f.depotCode ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      const parts = [f.fileDate ?? 'Tarih yok', f.depotCode ? `Depo: ${f.depotCode}` : null].filter(Boolean)
      items.push({ key, label: parts.join(' • '), date: f.fileDate, depot: f.depotCode })
    }
    return items
  }, [importFiles])

  useEffect(() => {
    if (!currentUser) return
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

  const onLogin = (userId: string) => {
    saveSessionUser(userId)
    setCurrentUser(userId)
  }

  const onLogout = () => {
    clearSessionUser()
    setCurrentUser(null)
    setSelectedPosition(null)
    setStatus(null)
  }

  const onUpload = async () => {
    if (!currentUser) return
    if (selectedFiles.length === 0) {
      setStatus({ type: 'error', message: 'Lütfen bir JSON dosyası seçin' })
      return
    }

    setStatus({ type: 'info', message: `Dosyalar işleniyor: ${selectedFiles.length} adet` })
    try {
      const result = await importSalesFiles(selectedFiles)
      if (!result.ok) throw new Error(result.message || 'Import başarısız')
      const imported = result.files.filter((f) => !f.skipped)
      const skippedFileCount = result.files.length - imported.length
      const skippedPositionsCount = result.files.reduce((s, f) => s + (f.skippedPositions?.length ?? 0), 0)
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
          setSelectedDatasetKey(`${firstImported.fileDate ?? ''}|${firstImported.depotCode ?? ''}`)
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Import sırasında hata oluştu'
      setStatus({ type: 'error', message: msg })
    }

    setSelectedFiles([])
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

  const summaryTotals = useMemo(() => {
    if (!selectedPosition) return null

    const invoiceNakit = totalsByTypeInvoices.NAKIT
    const invoiceHavale = totalsByTypeInvoices.HAVALE
    const collectionVadeliTahsilat = totalsByTypePayments.VADETAH
    const collectionVadeliTahsilatHavale = totalsByTypePayments.VADETAHHAV

    const havaleIskonto = positionInvoices.reduce((s, inv) => {
      const allocs = getInvoiceAllocations(inv, invoiceAllocations)
      const havalePart = allocationAmountForType(allocs, 'HAVALE')
      if (havalePart <= 0) return s
      return s + (inv.totalDiscount ?? 0)
    }, 0)

    const havaleTutari = havaleIskonto > 0 ? Math.max(0, invoiceHavale - havaleIskonto) : invoiceHavale
    const nakitTutari = invoiceNakit
    const rutToplam = havaleTutari + nakitTutari

    const vadeliSatisTutari = totalsByTypeInvoices.VADELI
    const genelToplam = rutToplam + vadeliSatisTutari

    const torbaTutari = invoiceNakit + collectionVadeliTahsilat

    return {
      havaleTutari,
      nakitTutari,
      nakitToplam: totalsByTypeInvoices.NAKIT + totalsByTypePayments.NAKIT,
      vadeliTahsilatHavale: collectionVadeliTahsilatHavale,
      toplam: rutToplam,
      iskonto: havaleIskonto,
      iskontoToplam: discountTotalAll,
      toplamTahsilat: paymentTotal,
      vadeliSatisTutari,
      genelToplam,
      torbaTutari,
      toplamSatisTutari: invoiceTotal,
    }
  }, [
    selectedPosition,
    totalsByTypeInvoices,
    totalsByTypePayments,
    discountTotalAll,
    paymentTotal,
    invoiceTotal,
    positionInvoices,
    invoiceAllocations,
  ])

  const detailInvoices = useMemo(() => {
    if (!selectedPosition) return []
    if (!typeFilter) return positionInvoices
    return positionInvoices.filter((inv) => allocationAmountForType(getInvoiceAllocations(inv, invoiceAllocations), typeFilter) > 0)
  }, [selectedPosition, positionInvoices, typeFilter, invoiceAllocations])

  const detailPayments = useMemo(() => {
    if (!selectedPosition) return []
    const rows: Array<{ key: string; c: Collection; allocs: Allocation[] }> = []
    for (const c of positionCollections) {
      const key = c.paymentKey ?? computePaymentKey(c.invoiceCode ?? '', c)
      const allocs = getPaymentAllocations(key, c, paymentAllocations)
      if (typeFilter && allocationAmountForType(allocs, typeFilter) <= 0) continue
      rows.push({ key, c, allocs })
    }
    return rows
  }, [selectedPosition, positionCollections, typeFilter, paymentAllocations])

  const cashInvoices = useMemo(() => {
    if (!selectedPosition) return []
    return positionInvoices
      .map((inv) => ({ inv, allocs: getInvoiceAllocations(inv, invoiceAllocations) }))
      .filter((r) => allocationAmountForType(r.allocs, 'NAKIT') > 0)
  }, [selectedPosition, positionInvoices, invoiceAllocations])

  const cashCollections = useMemo(() => {
    if (!selectedPosition) return []
    const rows: Array<{ key: string; c: Collection; allocs: Allocation[] }> = []
    for (const c of positionCollections) {
      const key = c.paymentKey ?? computePaymentKey(c.invoiceCode ?? '', c)
      const allocs = getPaymentAllocations(key, c, paymentAllocations)
      if (allocationAmountForType(allocs, 'NAKIT') <= 0) continue
      rows.push({ key, c, allocs })
    }
    return rows
  }, [selectedPosition, positionCollections, paymentAllocations])

  const onExport = () => {
    const data = positionTab === 'faturalar' ? detailInvoices : detailPayments.map((r) => r.c)
    downloadCsv(toCsv(data, positionTab), `hesap-kapatma-${positionTab}-${new Date().toISOString().split('T')[0]}.csv`)
  }

  const updateInvoiceAllocations = (invoiceCode: string, next: Allocation[]) => {
    if (!currentUser) return
    setStatus({ type: 'info', message: 'Kaydediliyor...' })
    saveInvoiceAllocationsSql({ userName: currentUser, invoiceCode, allocations: next })
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
    savePaymentAllocationsSql({ userName: currentUser, paymentKey, allocations: next })
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

  return (
    <div className="app-shell">
      <div className="app-container">
      <div className="topbar">
        <div className="topbar-left">
          <div className="app-title">Hesap Kapatma</div>
          <div className="app-subtitle">
            {currentUser}
            {selectedDataset.date ? ` • ${selectedDataset.date}` : ''}
            {selectedDataset.depot ? ` • ${selectedDataset.depot}` : ''}
          </div>
        </div>
        <div className="topbar-right">
          {selectedPosition ? (
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => {
                setSelectedPosition(null)
                setTypeFilter(null)
                setPositionTab('faturalar')
              }}
            >
              Pozisyonlara Dön
            </button>
          ) : null}
          <button className="btn btn-secondary" type="button" onClick={onLogout}>
            Çıkış
          </button>
        </div>
      </div>

      {!selectedPosition ? (
        <>
          <div className="header">
            <h1>Hesap Kapatma</h1>
            <p>Kullanıcı bazlı ekran</p>
          </div>

          <div className="filters">
            <div className="filter-group">
              <label>Tarih / Depo</label>
              <select
                value={selectedDatasetKey}
                onChange={(e) => {
                  setSelectedDatasetKey(e.target.value)
                  setSelectedPosition(null)
                  setTypeFilter(null)
                  setPositionTab('faturalar')
                }}
              >
                <option value="all">Tümü</option>
                {datasetOptions.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
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
            <div className={`upload-status ${status?.type ?? ''}`}>{status?.message ?? ''}</div>
          </div>

          <div className="position-list">
            {positionsLoading ? (
              <div className="empty">Pozisyonlar yükleniyor...</div>
            ) : positions.length === 0 ? (
              <div className="empty">Önce JSON yükleyin.</div>
            ) : (
              positions.map((p) => (
                <div
                  key={p.code}
                  className="card"
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
                }}
              >
                Tahsilatlar
              </button>
            </div>

            <div className="table-header">
              <span className="table-title">{positionTab === 'faturalar' ? 'Özet (Faturalar)' : 'Özet (Tahsilatlar)'}</span>
              <div className="actions">
                <button className="btn btn-secondary" type="button" onClick={onExport}>
                  CSV İndir
                </button>
              </div>
            </div>

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
                {summaryTotals.iskonto > 0 ? (
                  <div className="summary-row">
                    <div>İSKONTO</div>
                    <div>{formatMoney(summaryTotals.iskonto)}</div>
                  </div>
                ) : null}
                {summaryTotals.iskontoToplam > 0 ? (
                  <div className="summary-row">
                    <div>İSKONTO TOPLAMI</div>
                    <div>{formatMoney(summaryTotals.iskontoToplam)}</div>
                  </div>
                ) : null}
                <div
                  className="summary-row clickable"
                  onClick={() => {
                    setCashListOpen(true)
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
              </div>
            ) : null}

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

          <Modal
            title={editingInvoice ? `Fatura Tip Dağılımı - ${editingInvoice.code}` : ''}
            open={!!editingInvoice}
            onClose={() => setEditingInvoice(null)}
          >
            {editingInvoice ? (
              <AllocationEditor
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
          >
            {editingPayment ? (
              <AllocationEditor
                title="Tahsilat"
                total={editingPayment.collection.amount ?? 0}
                allocations={getPaymentAllocations(editingPayment.key, editingPayment.collection, paymentAllocations)}
                onChange={(next) => updatePaymentAllocations(editingPayment.key, next)}
              />
            ) : null}
          </Modal>

          <Modal title="Nakit Faturalar ve Tahsilatlar" open={cashListOpen} onClose={() => setCashListOpen(false)}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>Nakit Faturalar</div>
                <div className="table-wrapper" style={{ margin: 0 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Müşteri</th>
                        <th>Vergi No</th>
                        <th>Nakit Tutar</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {cashInvoices.length === 0 ? (
                        <tr>
                          <td colSpan={4} style={{ textAlign: 'center', color: '#718096' }}>
                            Detay bulunamadı
                          </td>
                        </tr>
                      ) : (
                        cashInvoices.map(({ inv, allocs }) => (
                          <tr key={inv.code}>
                            <td>{inv.customer.registeredName}</td>
                            <td>{inv.customer.taxNumber}</td>
                            <td>{formatMoney(allocationAmountForType(allocs, 'NAKIT'))}</td>
                            <td>
                              <button className="btn btn-secondary" type="button" onClick={() => setEditingInvoice(inv)}>
                                Düzenle
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>Nakit Tahsilatlar</div>
                <div className="table-wrapper" style={{ margin: 0 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Müşteri</th>
                        <th>Tutar</th>
                        <th>Tarih</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {cashCollections.length === 0 ? (
                        <tr>
                          <td colSpan={4} style={{ textAlign: 'center', color: '#718096' }}>
                            Detay bulunamadı
                          </td>
                        </tr>
                      ) : (
                        cashCollections.map((r) => (
                          <tr key={r.key}>
                            <td>{r.c.customer.registeredName}</td>
                            <td>{formatMoney(allocationAmountForType(r.allocs, 'NAKIT'))}</td>
                            <td>{formatDateTr(r.c.issueDate)}</td>
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
                </div>
              </div>
            </div>
          </Modal>
        </>
      )}
      </div>
    </div>
  )
}
