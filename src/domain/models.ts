export type SalesType = string

export type PaymentFormCode = string

export interface SalesFileMeta {
  fileName: string
  fileDate?: string
  depotCode?: string
}

export interface InvoiceCustomer {
  code?: string
  registeredName: string
  taxNumber?: string
  licenseNumber?: string
}

export interface InvoicePosition {
  code: string
  description?: string
}

export interface Payment {
  code?: string
  issueDate?: string
  amount: number
  paymentFormCode?: PaymentFormCode
  paymentFormDescription?: string
}

export interface InvoiceDetailProduct {
  sequence?: number
  code?: string
  description?: string
}

export interface InvoiceDetail {
  product: InvoiceDetailProduct
  quantity?: number
  netAmount?: number
  grossAmount?: number
  price?: number
  availability?: number
}

export interface Collection extends Payment {
  invoiceCode?: string
  customer: InvoiceCustomer
  position: InvoicePosition
  source?: SalesFileMeta
}

export interface Invoice {
  code: string
  isEdos?: boolean
  returnGoods?: unknown
  legalNumber?: string
  status?: string
  salesType: SalesType
  issueDate?: string
  dueDate?: string
  creditDays?: number
  netAmount: number
  grossAmount?: number
  outstandingAmount?: number
  taxAmount?: number
  totalDiscount?: number
  customer: InvoiceCustomer
  position: InvoicePosition
  payments: Payment[]
  details?: InvoiceDetail[]
  source?: SalesFileMeta
}

export interface NormalizedSalesFile {
  invoices: Invoice[]
  collections: Collection[]
}

export interface RepStats {
  total: number
  vadeli: number
  hhsat: number
  count: number
}
