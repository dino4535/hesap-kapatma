export interface ImportResultFile {
  fileName: string
  status?: 'pending' | 'running' | 'completed' | 'failed'
  errorMessage?: string
  progressPercent?: number
  invoiceCount: number
  paymentCount: number
  depotCode?: string
  fileDate?: string
  skipped?: boolean
  skippedPositions?: string[]
  positions?: Array<{
    positionCode: string
    totalInvoices: number
    totalCollections: number
    processedInvoices: number
    processedCollections: number
    status: 'pending' | 'processing' | 'imported' | 'skipped'
    progressPercent: number
    message?: string
  }>
}

export interface ImportResult {
  ok: boolean
  files: ImportResultFile[]
  message?: string
}
export interface ImportJobStartResult {
  ok: boolean
  accepted?: boolean
  jobId?: string
  totalFiles?: number
  statusUrl?: string
  message?: string
}
export interface ImportJobState {
  id: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  totalFiles: number
  processedFiles: number
  currentFileName?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  errorMessage?: string
  files: ImportResultFile[]
}
export interface ImportJobStatusResult {
  ok: boolean
  job?: ImportJobState
  message?: string
}

export interface ImportFileRow {
  fileName: string
  fileDate?: string
  depotCode?: string
  importedAt?: string
  invoiceCount: number
  paymentCount: number
}

export async function importSalesFiles(args: {
  userName: string
  files: File[]
  depotMap: Record<string, string>
}): Promise<ImportJobStartResult> {
  const form = new FormData()
  for (const f of args.files) form.append('files', f, f.name)
  form.append('depotMap', JSON.stringify(args.depotMap ?? {}))

  const res = await fetch('/api/import', { method: 'POST', body: form, headers: { 'x-user': args.userName } })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as ImportJobStartResult
}

export async function fetchImportJobStatus(args: { userName: string; jobId: string }): Promise<ImportJobStatusResult> {
  const id = String(args.jobId ?? '').trim()
  if (!id) return { ok: false, message: 'jobId zorunlu' }
  const res = await fetch(`/api/import/jobs/${encodeURIComponent(id)}`, { headers: { 'x-user': args.userName } })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as ImportJobStatusResult
}

export async function fetchImportFiles(args: { userName: string }): Promise<{ ok: boolean; files: ImportFileRow[]; message?: string }> {
  const res = await fetch('/api/import-files', { headers: { 'x-user': args.userName } })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, files: [], message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; files: ImportFileRow[] }
}

export interface DepotCashDeviceSetting {
  depotCode: string
  deviceIp: string
  deviceUser: string
  updatedBy?: string
  updatedAt?: string
}

export interface CashCountReceipt {
  counterId: string
  receiptId: string
  deviceIp: string
  transactionDateTime: string
  displayTime: string
  autoNo: string
  sequenceNo: number
  totalAmount: number
  totalQty: number
  banknoteCounts: Record<string, number>
}

export async function logUiEvent(args: {
  userName?: string
  type: 'success' | 'error' | 'info'
  message: string
  context?: Record<string, unknown>
}): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch('/api/ui-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(args.userName ? { 'x-user': args.userName } : {}) },
    body: JSON.stringify({ type: args.type, message: args.message, context: args.context ?? {} }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean }
}

export async function fetchCashDeviceSettings(args: { userName: string }): Promise<{ ok: boolean; settings: DepotCashDeviceSetting[]; message?: string }> {
  const res = await fetch('/api/settings/cash-devices', { headers: { 'x-user': args.userName } })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, settings: [], message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; settings: DepotCashDeviceSetting[] }
}

export async function saveCashDeviceSetting(args: {
  userName: string
  depotCode: string
  deviceIp: string
  deviceUser: string
  devicePassword: string
}): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch('/api/settings/cash-devices', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-user': args.userName },
    body: JSON.stringify({
      depotCode: args.depotCode,
      deviceIp: args.deviceIp,
      deviceUser: args.deviceUser,
      devicePassword: args.devicePassword,
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean }
}

export async function testCashDeviceConnection(args: {
  userName: string
  deviceIp: string
  deviceUser: string
  devicePassword: string
}): Promise<{ ok: boolean; count?: number; message?: string }> {
  const res = await fetch('/api/settings/cash-devices/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user': args.userName },
    body: JSON.stringify({
      deviceIp: args.deviceIp,
      deviceUser: args.deviceUser,
      devicePassword: args.devicePassword,
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; count?: number }
}

export async function fetchCashCountReceipts(args: {
  userName: string
  date: string
  depot: string
  position: string
  excludeSourceFileDate?: string
  excludeDepot?: string
  excludePosition?: string
}): Promise<{ ok: boolean; receipts: CashCountReceipt[]; message?: string }> {
  const qs = new URLSearchParams()
  qs.set('date', args.date)
  qs.set('depot', args.depot)
  qs.set('position', args.position)
  if (args.excludeSourceFileDate) qs.set('excludeSourceFileDate', args.excludeSourceFileDate)
  if (args.excludeDepot) qs.set('excludeDepot', args.excludeDepot)
  if (args.excludePosition) qs.set('excludePosition', args.excludePosition)
  const res = await fetch(`/api/cash-counts/receipts?${qs.toString()}`, { headers: { 'x-user': args.userName } })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, receipts: [], message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; receipts: CashCountReceipt[] }
}

export interface PositionRow {
  code: string
  description?: string
  invoiceCount: number
  torbaTutari?: number
  mutabakatStatus?: 'DRAFT' | 'COMPLETED' | null
}

export async function fetchPositions(args?: {
  date?: string | null
  depot?: string | null
}): Promise<{ ok: boolean; positions: PositionRow[]; message?: string }> {
  const qs = new URLSearchParams()
  if (args?.date) qs.set('date', args.date)
  if (args?.depot) qs.set('depot', args.depot)
  const url = qs.toString() ? `/api/positions?${qs.toString()}` : '/api/positions'
  const res = await fetch(url)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, positions: [], message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; positions: PositionRow[] }
}

export async function fetchPositionData(
  positionCode: string,
  args?: { date?: string | null; depot?: string | null },
): Promise<{
  ok: boolean
  positionCode: string
  invoices: unknown[]
  collections: unknown[]
  invoiceAllocations: Record<string, unknown>
  paymentAllocations: Record<string, unknown>
  message?: string
}> {
  const qs = new URLSearchParams()
  if (args?.date) qs.set('date', args.date)
  if (args?.depot) qs.set('depot', args.depot)
  const url = qs.toString()
    ? `/api/positions/${encodeURIComponent(positionCode)}?${qs.toString()}`
    : `/api/positions/${encodeURIComponent(positionCode)}`
  const res = await fetch(url)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return {
      ok: false,
      positionCode,
      invoices: [],
      collections: [],
      invoiceAllocations: {},
      paymentAllocations: {},
      message: text || `HTTP ${res.status}`,
    }
  }
  return (await res.json()) as {
    ok: boolean
    positionCode: string
    invoices: unknown[]
    collections: unknown[]
    invoiceAllocations: Record<string, unknown>
    paymentAllocations: Record<string, unknown>
  }
}

export async function saveInvoiceAllocationsSql(args: {
  userName: string
  invoiceCode: string
  allocations: unknown[]
}): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch('/api/allocations/invoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user': args.userName },
    body: JSON.stringify({ invoiceCode: args.invoiceCode, allocations: args.allocations }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean }
}

export async function savePaymentAllocationsSql(args: {
  userName: string
  paymentKey: string
  allocations: unknown[]
}): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch('/api/allocations/payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user': args.userName },
    body: JSON.stringify({ paymentKey: args.paymentKey, allocations: args.allocations }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean }
}

export type MutabakatMode = 'NAKIT' | 'BANKA' | 'KARMA'

export interface MutabakatAdjustment {
  id: string
  type: 'ACIK' | 'FAZLA' | 'HATALI_TAHSILAT' | 'DIGER'
  description?: string
  amount: number
}

export interface MutabakatRecord {
  sourceFileDate: string
  depotCode: string
  positionCode: string
  mode: MutabakatMode
  torbaTutari: number
  enteredAmount: number
  adjustmentAmount: number
  diffAmount: number
  cashJson?: unknown
  bankName?: string
  bankDepositAmount?: number
  dekontNo?: string
  bankExplanation?: string
  bankReceiptDateTime?: string
  adjustments?: MutabakatAdjustment[]
  status: 'DRAFT' | 'COMPLETED'
  updatedAt?: string
  updatedBy?: string
  completedAt?: string
  completedBy?: string
}

export async function fetchMutabakat(args: {
  date: string
  depot: string
  position: string
}): Promise<{ ok: boolean; record: MutabakatRecord | null; message?: string }> {
  const qs = new URLSearchParams()
  qs.set('date', args.date)
  qs.set('depot', args.depot)
  qs.set('position', args.position)
  const res = await fetch(`/api/mutabakat?${qs.toString()}`)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, record: null, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; record: MutabakatRecord | null }
}

export async function saveMutabakat(args: {
  userName: string
  record: {
    sourceFileDate: string
    depotCode: string
    positionCode: string
    mode: MutabakatMode
    torbaTutari: number
    enteredAmount: number
    bankName?: string
    bankDepositAmount?: number
    dekontNo?: string
    bankExplanation?: string
    bankReceiptDateTime?: string
    cashJson?: unknown
    adjustments?: MutabakatAdjustment[]
  }
}): Promise<{ ok: boolean; record?: MutabakatRecord; message?: string }> {
  const res = await fetch('/api/mutabakat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user': args.userName },
    body: JSON.stringify(args.record),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; record: MutabakatRecord }
}

export async function completeMutabakat(args: {
  userName: string
  sourceFileDate: string
  depotCode: string
  positionCode: string
}): Promise<{ ok: boolean; record?: MutabakatRecord; message?: string }> {
  const res = await fetch('/api/mutabakat/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user': args.userName },
    body: JSON.stringify({
      sourceFileDate: args.sourceFileDate,
      depotCode: args.depotCode,
      positionCode: args.positionCode,
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; record: MutabakatRecord }
}

export async function fetchCariBalances(args: {
  userName: string
  asOfDate: string
  codes: string[]
  kind?: 'TOTAL' | 'OVERDUE' | 'NOT_DUE'
}): Promise<{ ok: boolean; balances: Array<{ code: string; balance: number }>; message?: string }> {
  const res = await fetch('/api/cari-balances', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user': args.userName },
    body: JSON.stringify({ asOfDate: args.asOfDate, codes: args.codes, kind: args.kind ?? 'TOTAL' }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, balances: [], message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; balances: Array<{ code: string; balance: number }> }
}

export async function fetchCariDayCredits(args: {
  userName: string
  day: string
  codes: string[]
}): Promise<{ ok: boolean; credits: Array<{ code: string; total: number }>; message?: string }> {
  const res = await fetch('/api/cari-day-credits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user': args.userName },
    body: JSON.stringify({ day: args.day, codes: args.codes }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, credits: [], message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; credits: Array<{ code: string; total: number }> }
}

export async function fetchCariCreditWindow(args: {
  userName: string
  start: string
  end: string
  codes: string[]
}): Promise<{ ok: boolean; credits: Array<{ code: string; total: number }>; message?: string }> {
  const res = await fetch('/api/cari-credit-window', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user': args.userName },
    body: JSON.stringify({ start: args.start, end: args.end, codes: args.codes }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, credits: [], message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; credits: Array<{ code: string; total: number }> }
}

export interface PositionRepresentativeRow {
  positionCode: string
  representativeName: string
  phoneNumber: string
  updatedAt?: string
  updatedBy?: string
}

export async function fetchPositionRepresentatives(args: {
  userName: string
}): Promise<{ ok: boolean; mappings: PositionRepresentativeRow[]; message?: string }> {
  const res = await fetch('/api/position-representatives', {
    headers: { 'x-user': args.userName },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, mappings: [], message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; mappings: PositionRepresentativeRow[] }
}

export async function savePositionRepresentative(args: {
  userName: string
  positionCode: string
  representativeName: string
  phoneNumber: string
}): Promise<{ ok: boolean; mapping?: PositionRepresentativeRow; message?: string }> {
  const res = await fetch('/api/position-representatives', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user': args.userName },
    body: JSON.stringify({ positionCode: args.positionCode, representativeName: args.representativeName, phoneNumber: args.phoneNumber }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; mapping: PositionRepresentativeRow }
}

export async function deletePositionRepresentative(args: {
  userName: string
  positionCode: string
}): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch(`/api/position-representatives/${encodeURIComponent(args.positionCode)}`, {
    method: 'DELETE',
    headers: { 'x-user': args.userName },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean }
}

export type RoleCode = 'ADMIN' | 'PLAN_MUHASEBE' | 'SHEF'
export interface ScreenPermissions {
  canMain: boolean
  canMutabakat: boolean
  canBayiHavaleMatch: boolean
  canPositionRepresentative: boolean
  canUserAdmin: boolean
}

export interface UserRow {
  userName: string
  roleCode: RoleCode
  isAdmin: boolean
  isActive: boolean
  permissions: ScreenPermissions
  createdAt?: string
}

export interface MutabakatSettings {
  diffLimitTl: number
}

export interface EndOfDayBankTotalRow {
  bankName: string
  totalAmount: number
  recordCount: number
}

export interface EndOfDayCashByPositionRow {
  positionCode: string
  representativeName: string
  denominationTotals: Record<string, number>
  totalCash: number
}

export interface EndOfDayCashOverallRow {
  denomination: string
  amount: number
}

export interface EndOfDayAllocationChangeRow {
  changedAt?: string
  changedBy?: string
  positionCode: string
  representativeName: string
  invoiceCode?: string
  paymentKey?: string
  customerName: string
  fromJson?: string
  toJson?: string
}

export interface EndOfDayAdjustmentRow {
  positionCode: string
  representativeName: string
  type: string
  description: string
  amount: number
  updatedAt?: string
  updatedBy?: string
}

export interface EndOfDayReport {
  date: string
  depotCode: string
  completedMutabakatCount: number
  totalBankDeposit: number
  bankTotals: EndOfDayBankTotalRow[]
  cashByPosition: EndOfDayCashByPositionRow[]
  cashOverall: EndOfDayCashOverallRow[]
  invoiceAllocationChanges: EndOfDayAllocationChangeRow[]
  paymentAllocationChanges: EndOfDayAllocationChangeRow[]
  adjustments: EndOfDayAdjustmentRow[]
}

export async function fetchUsers(args: {
  userName: string
}): Promise<{ ok: boolean; users: UserRow[]; message?: string }> {
  const res = await fetch('/api/users', {
    headers: { 'x-user': args.userName },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, users: [], message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; users: UserRow[] }
}

export async function createUserAsAdmin(args: {
  userName: string
  newUserName: string
  password: string
  roleCode: RoleCode
  permissions: ScreenPermissions
}): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user': args.userName },
    body: JSON.stringify({ userName: args.newUserName, password: args.password, roleCode: args.roleCode, permissions: args.permissions }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean }
}

export async function updateUserAsAdmin(args: {
  userName: string
  targetUserName: string
  roleCode: RoleCode
  isActive: boolean
  permissions: ScreenPermissions
}): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch(`/api/users/${encodeURIComponent(args.targetUserName)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-user': args.userName },
    body: JSON.stringify({ roleCode: args.roleCode, isActive: args.isActive, permissions: args.permissions }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean }
}

export async function deleteUserAsAdmin(args: {
  userName: string
  targetUserName: string
}): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch(`/api/users/${encodeURIComponent(args.targetUserName)}`, {
    method: 'DELETE',
    headers: { 'x-user': args.userName },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean }
}

export async function fetchMutabakatSettings(args: {
  userName: string
}): Promise<{ ok: boolean; settings?: MutabakatSettings; message?: string }> {
  const res = await fetch('/api/settings/mutabakat', {
    headers: { 'x-user': args.userName },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; settings: MutabakatSettings }
}

export async function updateMutabakatSettings(args: {
  userName: string
  diffLimitTl: number
}): Promise<{ ok: boolean; settings?: MutabakatSettings; message?: string }> {
  const res = await fetch('/api/settings/mutabakat', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-user': args.userName },
    body: JSON.stringify({ diffLimitTl: args.diffLimitTl }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; settings: MutabakatSettings }
}

export async function fetchEndOfDayReport(args: {
  userName: string
  date: string
  depot: string
}): Promise<{ ok: boolean; report?: EndOfDayReport; message?: string }> {
  const qs = new URLSearchParams()
  qs.set('date', args.date)
  qs.set('depot', args.depot)
  const res = await fetch(`/api/reports/end-of-day?${qs.toString()}`, {
    headers: { 'x-user': args.userName },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; report: EndOfDayReport }
}

export async function deleteDataByDateDepot(args: {
  userName: string
  date: string
  depot: string
}): Promise<{ ok: boolean; deleted?: Record<string, unknown>; message?: string }> {
  const qs = new URLSearchParams()
  qs.set('date', args.date)
  qs.set('depot', args.depot)
  const res = await fetch(`/api/admin/data?${qs.toString()}`, {
    method: 'DELETE',
    headers: { 'x-user': args.userName },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; deleted?: Record<string, unknown> }
}

export async function deleteDataByImportFile(args: {
  userName: string
  fileName: string
}): Promise<{ ok: boolean; deleted?: Record<string, unknown>; message?: string }> {
  const qs = new URLSearchParams()
  qs.set('fileName', args.fileName)
  const res = await fetch(`/api/admin/import-file?${qs.toString()}`, {
    method: 'DELETE',
    headers: { 'x-user': args.userName },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; deleted?: Record<string, unknown> }
}

export interface ManimDekontCandidate {
  receiptNo: string
  receiptDate: string
  amount: number
  amountDiff: number
  dayDiff: number
  direction?: string
  explanation?: string
  bankAccountId?: string
  bankAccountLabel?: string
}

export async function findManimDekont(args: {
  userName: string
  bankName: string
  date: string
  amount: number
}): Promise<{ ok: boolean; match: ManimDekontCandidate | null; candidates: ManimDekontCandidate[]; message?: string }> {
  const qs = new URLSearchParams()
  qs.set('bankName', args.bankName)
  qs.set('date', args.date)
  qs.set('amount', String(args.amount))
  const res = await fetch(`/api/manim/dekont?${qs.toString()}`, { headers: { 'x-user': args.userName } })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, match: null, candidates: [], message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; match: ManimDekontCandidate | null; candidates: ManimDekontCandidate[]; message?: string }
}

export interface ManimReceiptRow {
  receiptNo: string
  receiptDate: string
  amount: number
  direction?: string
  explanation?: string
  correspondentCode?: string
  correspondentLabel?: string
  bankAccountId?: string
  bankAccountLabel?: string
  receiptStatusCode?: string
}

export async function fetchManimReceipts(args: {
  userName: string
  bankName?: string
  date: string
  includePreviousDay?: boolean
  allBanks?: boolean
  untilNow?: boolean
  limit?: number
}): Promise<{ ok: boolean; receipts: ManimReceiptRow[]; message?: string }> {
  const qs = new URLSearchParams()
  if (args.bankName) qs.set('bankName', args.bankName)
  qs.set('date', args.date)
  if (args.includePreviousDay) qs.set('includePreviousDay', '1')
  if (args.allBanks) qs.set('allBanks', '1')
  if (args.untilNow) qs.set('untilNow', '1')
  if (typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0) qs.set('limit', String(Math.floor(args.limit)))
  const res = await fetch(`/api/manim/receipts?${qs.toString()}`, { headers: { 'x-user': args.userName } })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, receipts: [], message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; receipts: ManimReceiptRow[]; message?: string }
}
