import type { Collection, Invoice, NormalizedSalesFile, Payment, SalesFileMeta } from './models'

interface RawSalesFile {
  INVOICES?: unknown
  COLLECTIONS?: unknown
}

interface RawPayment {
  CODE?: unknown
  ISSUEDATE?: unknown
  AMOUNT?: unknown
  AMOUNTPAID?: unknown
  PAYMENTDATE?: unknown
  DATE?: unknown
  DOCUMENTNUMBER?: unknown
  RECIEPTNUMBER?: unknown
  PAYMENTFORM?: {
    CODE?: unknown
    DESCRIPTION?: unknown
  }
}

interface RawInvoice {
  CODE?: unknown
  LEGALNUMBER?: unknown
  STATUS?: unknown
  SALESTYPE?: unknown
  ISSUEDATE?: unknown
  DUEDATE?: unknown
  CREDITDAYS?: unknown
  NETAMOUNT?: unknown
  GROSSAMOUNT?: unknown
  OUTSTANDINGAMOUNT?: unknown
  TAXAMOUNT?: unknown
  TOTAL_DISCOUNT?: unknown
  CUSTOMER?: {
    CODE?: unknown
    REGISTEREDNAME?: unknown
    TAXNUMBER?: unknown
    LICENSENUMBER?: unknown
  }
  POSITION?: {
    CODE?: unknown
    DESCRIPTION?: unknown
  }
  PAYMENTS?: unknown
}

interface RawCollection {
  POSITION?: {
    CODE?: unknown
    DESCRIPTION?: unknown
  }
  CODE?: unknown
  INVOICE_CODE?: unknown
  ISSUEDATE?: unknown
  AMOUNT?: unknown
  PAYMENTFORM?: {
    CODE?: unknown
    DESCRIPTION?: unknown
  }
  CUSTOMER?: {
    CODE?: unknown
    REGISTEREDNAME?: unknown
    TAXNUMBER?: unknown
    LICENSENUMBER?: unknown
  }
}

const toStringOrUndef = (v: unknown) => (typeof v === 'string' ? v : undefined)

const toNumberOrUndef = (v: unknown) => (typeof v === 'number' ? v : undefined)

export function parseSalesFileName(fileName: string): SalesFileMeta {
  const base = fileName.replace(/\.json$/i, '')
  const m = /^(\d{8})_DIST([A-Z0-9]+)_SALES$/i.exec(base)
  if (!m) return { fileName }
  const y = m[1].slice(0, 4)
  const mo = m[1].slice(4, 6)
  const d = m[1].slice(6, 8)
  return {
    fileName,
    fileDate: `${y}-${mo}-${d}`,
    depotCode: m[2].toUpperCase(),
  }
}

export function normalizeSalesFile(json: unknown, source?: SalesFileMeta): NormalizedSalesFile {
  const raw = json as RawSalesFile
  const invoices = Array.isArray(raw?.INVOICES) ? (raw.INVOICES as RawInvoice[]).map((inv) => normalizeInvoice(inv, source)) : []
  const collections = Array.isArray(raw?.COLLECTIONS)
    ? (raw.COLLECTIONS as RawCollection[]).map((c) => normalizeCollection(c, source))
    : []
  return { invoices, collections }
}

export function normalizeInvoice(raw: RawInvoice, source?: SalesFileMeta): Invoice {
  const paymentsRaw = Array.isArray(raw.PAYMENTS) ? (raw.PAYMENTS as RawPayment[]) : []
  const payments: Payment[] = paymentsRaw.map((p) => ({
    code: toStringOrUndef(p.CODE),
    issueDate: toStringOrUndef(p.ISSUEDATE) ?? toStringOrUndef(p.PAYMENTDATE) ?? toStringOrUndef(p.DATE),
    amount: toNumberOrUndef(p.AMOUNT) ?? toNumberOrUndef(p.AMOUNTPAID) ?? 0,
    paymentFormCode: toStringOrUndef(p.PAYMENTFORM?.CODE),
    paymentFormDescription: toStringOrUndef(p.PAYMENTFORM?.DESCRIPTION),
  }))

  return {
    code: toStringOrUndef(raw.CODE) ?? '',
    legalNumber: toStringOrUndef(raw.LEGALNUMBER),
    status: toStringOrUndef(raw.STATUS),
    salesType: toStringOrUndef(raw.SALESTYPE) ?? '',
    issueDate: toStringOrUndef(raw.ISSUEDATE),
    dueDate: toStringOrUndef(raw.DUEDATE),
    creditDays: toNumberOrUndef(raw.CREDITDAYS),
    netAmount: toNumberOrUndef(raw.NETAMOUNT) ?? 0,
    grossAmount: toNumberOrUndef(raw.GROSSAMOUNT),
    outstandingAmount: toNumberOrUndef(raw.OUTSTANDINGAMOUNT),
    taxAmount: toNumberOrUndef(raw.TAXAMOUNT),
    totalDiscount: toNumberOrUndef(raw.TOTAL_DISCOUNT),
    customer: {
      code: toStringOrUndef(raw.CUSTOMER?.CODE),
      registeredName: toStringOrUndef(raw.CUSTOMER?.REGISTEREDNAME) ?? '',
      taxNumber: toStringOrUndef(raw.CUSTOMER?.TAXNUMBER),
      licenseNumber: toStringOrUndef(raw.CUSTOMER?.LICENSENUMBER),
    },
    position: {
      code: toStringOrUndef(raw.POSITION?.CODE) ?? '',
      description: toStringOrUndef(raw.POSITION?.DESCRIPTION),
    },
    payments,
    source,
  }
}

export function normalizeCollection(raw: RawCollection, source?: SalesFileMeta): Collection {
  return {
    code: toStringOrUndef(raw.CODE),
    invoiceCode: toStringOrUndef(raw.INVOICE_CODE),
    issueDate: toStringOrUndef(raw.ISSUEDATE),
    amount: toNumberOrUndef(raw.AMOUNT) ?? 0,
    paymentFormCode: toStringOrUndef(raw.PAYMENTFORM?.CODE),
    paymentFormDescription: toStringOrUndef(raw.PAYMENTFORM?.DESCRIPTION),
    customer: {
      code: toStringOrUndef(raw.CUSTOMER?.CODE),
      registeredName: toStringOrUndef(raw.CUSTOMER?.REGISTEREDNAME) ?? '',
      taxNumber: toStringOrUndef(raw.CUSTOMER?.TAXNUMBER),
      licenseNumber: toStringOrUndef(raw.CUSTOMER?.LICENSENUMBER),
    },
    position: {
      code: toStringOrUndef(raw.POSITION?.CODE) ?? '',
      description: toStringOrUndef(raw.POSITION?.DESCRIPTION),
    },
    source,
  }
}
