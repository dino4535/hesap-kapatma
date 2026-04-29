import { useMemo } from 'react'
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
  const selectedSet = useMemo(() => new Set(props.selectedIds), [props.selectedIds])
  const selectedCount = props.receipts.reduce((s, r) => s + (selectedSet.has(r.receiptId) ? 1 : 0), 0)
  const selectedTotal = props.receipts.reduce((s, r) => s + (selectedSet.has(r.receiptId) ? Number(r.totalAmount) || 0 : 0), 0)

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

        <div className="form-row">
          <label>Tarih</label>
          <input type="date" value={props.date} onChange={(e) => props.onDateChange(e.target.value)} disabled={props.loading} />
        </div>

        <div className="mutabakat-hint">
          Seçili: {selectedCount} • Toplam: {formatMoney(selectedTotal)}
        </div>

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
              <tr>
                <td colSpan={4} style={{ textAlign: 'center', color: '#718096' }}>
                  Yükleniyor...
                </td>
              </tr>
            ) : props.receipts.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ textAlign: 'center', color: '#718096' }}>
                  Kayıt yok
                </td>
              </tr>
            ) : (
              props.receipts.map((r) => {
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
                            nextChecked ? (checked ? props.selectedIds : props.selectedIds.concat([r.receiptId])) : props.selectedIds.filter((x) => x !== r.receiptId),
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
    </Modal>
  )
}
