import type { Collection, Invoice } from './models'

export type TabKey = 'faturalar' | 'tahsilatlar'

const esc = (v: unknown) => String(v ?? '').replaceAll(';', ',').replaceAll('\n', ' ')

export function toCsv(data: Array<Invoice | Collection>, tab: TabKey) {
  if (tab === 'faturalar') {
    let csv = 'Müşteri;Vergi No;Ödeme Tipi;Net Tutar;KDV;Toplam;Kalan;Vade;Temsilci\n'
    for (const item of data) {
      if (!('salesType' in item)) continue
      const total = (item.netAmount ?? 0) + (item.taxAmount ?? 0)
      csv += `${esc(item.customer.registeredName)};${esc(item.customer.taxNumber)};${esc(item.salesType)};${esc(item.netAmount)};${esc(item.taxAmount)};${esc(total)};${esc(item.outstandingAmount)};${esc(item.dueDate)};${esc(item.position.code)}\n`
    }
    return csv
  }

  let csv = 'Müşteri;Vergi No;Ödeme Tipi;Tahsilat Tutarı;Tarih;Belge No;Fatura Kodu;Pozisyon\n'
  for (const item of data) {
    if ('invoiceCode' in item) {
      csv += `${esc(item.customer.registeredName)};${esc(item.customer.taxNumber)};${esc(item.paymentFormDescription ?? item.paymentFormCode ?? '')};${esc(item.amount)};${esc(item.issueDate)};${esc(item.code)};${esc(item.invoiceCode)};${esc(item.position.code)}\n`
    }
  }
  return csv
}
