import { useMemo, useState } from 'react'
import { Modal } from './Modal'
import type { CashCountReceipt } from '../data/api'
import { formatDateTimeTr, formatMoney } from '../domain/format'

export function CashReceiptPickerModal(props: {
  open: boolean
  loading: boolean
  date: string
  receipts: CashCountReceipt[]
  selectedIds: string[]
  onClose: () => void
  onDateChange: (next: string) => void
  onSelectedIdsChange: (next: string[]) => void
  onConfirm: () => void
}) {
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'time_desc' | 'time_asc' | 'amount_desc' | 'amount_asc'>('time_desc')

  const selectedSet = useMemo(() => new Set(props.selectedIds), [props.selectedIds])
  const selectedCount = props.receipts.reduce((s, r) => s + (selectedSet.has(r.receiptId) ? 1 : 0), 0)
  const selectedTotal = props.receipts.reduce((s, r) => s + (selectedSet.has(r.receiptId) ? Number(r.totalAmount) || 0 : 0), 0)

  const filteredReceipts = useMemo(() => {
    const q = search.trim().toLocaleLowerCase('tr-TR')
    const rows = q
      ? props.receipts.filter((r) => {
          const hay = `${r.autoNo ?? ''} ${r.counterId ?? ''} ${r.receiptId ?? ''} ${r.displayTime ?? ''} ${r.transactionDateTime ?? ''}`.toLocaleLowerCase('tr-TR')
          return hay.includes(q)
        })
      : props.receipts
    const byTime = (r: CashCountReceipt) => {
      const t = new Date(r.transactionDateTime || '').getTime()
      return Number.isFinite(t) ? t : 0
    }
    const byAmount = (r: CashCountReceipt) => Number(r.totalAmount) || 0
    const sorted = [...rows]
    sorted.sort((a, b) => {
      if (sort === 'amount_desc') return byAmount(b) - byAmount(a)
      if (sort === 'amount_asc') return byAmount(a) - byAmount(b)
      if (sort === 'time_asc') return byTime(a) - byTime(b)
      return byTime(b) - byTime(a)
    })
    return sorted
  }, [props.receipts, search, sort])

  return (
    <Modal title="Sayım Fişi Ekle" open={props.open} onClose={props.onClose} size="wide">
      <div className="modal-content">
        <div className="modal-actions">
          <button className="btn btn-secondary" type="button" onClick={props.onClose}>
            İptal
          </button>
          <button className="btn btn-primary" type="button" disabled={props.loading} onClick={props.onConfirm}>
            Sayım Fişi Ekle
          </button>
        </div>

        <div className="mutabakat-form">
          <div className="mutabakat-field">
            <label>Tarih</label>
            <input type="date" value={props.date} onChange={(e) => props.onDateChange(e.target.value)} disabled={props.loading} />
          </div>
          <div className="mutabakat-field">
            <label>Ara</label>
            <input
              id="cash-receipt-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="No / ID / tarih..."
              disabled={props.loading}
            />
          </div>
          <div className="mutabakat-field">
            <label>Sırala</label>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as 'time_desc' | 'time_asc' | 'amount_desc' | 'amount_asc')}
              disabled={props.loading}
            >
              <option value="time_desc">Tarih (Yeni → Eski)</option>
              <option value="time_asc">Tarih (Eski → Yeni)</option>
              <option value="amount_desc">Tutar (Büyük → Küçük)</option>
              <option value="amount_asc">Tutar (Küçük → Büyük)</option>
            </select>
          </div>
        </div>

        <div className="mutabakat-hint">
          Seçili: {selectedCount} • Toplam: {formatMoney(selectedTotal)}
        </div>

        <div className="table-scroll">
          <table className="mini-table">
            <thead>
              <tr>
                <th></th>
                <th>Fiş</th>
                <th>İşlem Zamanı</th>
                <th>Tutar</th>
              </tr>
            </thead>
            <tbody>
              {props.loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={`sk-${i}`}>
                    <td style={{ width: 40 }}>
                      <div className="skeleton" style={{ height: 16, width: 16, borderRadius: 3 }} />
                    </td>
                    <td>
                      <div className="skeleton" style={{ height: 14, width: 220 }} />
                    </td>
                    <td>
                      <div className="skeleton" style={{ height: 14, width: 180 }} />
                    </td>
                    <td>
                      <div className="skeleton" style={{ height: 14, width: 110 }} />
                    </td>
                  </tr>
                ))
              ) : filteredReceipts.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ textAlign: 'center', color: '#718096' }}>
                    Kayıt yok
                  </td>
                </tr>
              ) : (
                filteredReceipts.map((r) => {
                  const checked = selectedSet.has(r.receiptId)
                  return (
                    <tr key={r.receiptId}>
                      <td style={{ width: 40 }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const nextChecked = e.target.checked
                            props.onSelectedIdsChange(
                              nextChecked
                                ? checked
                                  ? props.selectedIds
                                  : props.selectedIds.concat([r.receiptId])
                                : props.selectedIds.filter((x) => x !== r.receiptId),
                            )
                          }}
                        />
                      </td>
                      <td>{[r.autoNo ? `No ${r.autoNo}` : '', r.counterId ? `ID ${r.counterId}` : ''].filter(Boolean).join(' • ') || r.receiptId}</td>
                      <td>{r.displayTime || formatDateTimeTr(r.transactionDateTime)}</td>
                      <td>{formatMoney(Number(r.totalAmount) || 0)}</td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  )
}
