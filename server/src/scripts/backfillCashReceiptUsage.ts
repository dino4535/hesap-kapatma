import dotenv from 'dotenv'
import mssql from 'mssql'

dotenv.config({ path: './.env' })
dotenv.config({ path: '../.env' })

function normalizeIpText(value: unknown) {
  const s = String(value ?? '').trim()
  if (!s) return ''
  return s.replace(/\s+/g, '')
}

function safeDate(value: unknown) {
  const s = String(value ?? '').trim()
  if (!s) return null
  const d = new Date(s)
  return Number.isFinite(d.getTime()) ? d : null
}

function buildCounterId(args: { rawId?: unknown; transactionDateTime?: unknown }) {
  const rawId = String(args.rawId ?? '').trim()
  const time = String(args.transactionDateTime ?? '').trim()
  if (time) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:[.:](\d{1,6}))?/.exec(time)
    if (m) {
      const ms = String(m[7] ?? '000').slice(0, 3).padEnd(3, '0')
      return `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}${m[6]}${ms}`
    }
  }
  const digits = rawId.replace(/\D+/g, '')
  return digits || rawId
}

type MutabakatRow = {
  SourceFileDate: Date
  DepotCode: string
  PositionCode: string
  CashJson: string | null
}

type DepotDeviceRow = { DepotCode: string; DeviceIp: string | null }

const sqlConfig: mssql.config = {
  server: process.env.SQL_SERVER ?? '',
  user: process.env.SQL_USER ?? '',
  password: process.env.SQL_PASSWORD ?? '',
  database: process.env.SQL_DATABASE ?? 'HesapKapatma',
  options: { trustServerCertificate: (process.env.SQL_TRUST_SERVER_CERT ?? 'true').toLowerCase() !== 'false' },
}

const pool = await mssql.connect(sqlConfig)

const depotDevices = await pool
  .request()
  .query('SELECT DepotCode, DeviceIp FROM dbo.DepotCashDeviceSettings')
  .then((r) => (r.recordset ?? []) as DepotDeviceRow[])

const deviceIpByDepot = new Map<string, string>()
for (const r of depotDevices) {
  const depot = String(r.DepotCode ?? '').trim()
  const ip = normalizeIpText(r.DeviceIp)
  if (depot && ip) deviceIpByDepot.set(depot, ip)
}

const mutabakatRows = await pool
  .request()
  .query("SELECT SourceFileDate, DepotCode, PositionCode, CashJson FROM dbo.Mutabakat WHERE CashJson IS NOT NULL AND LTRIM(RTRIM(CashJson)) <> ''")
  .then((r) => (r.recordset ?? []) as MutabakatRow[])

let updated = 0
let inserted = 0
let skipped = 0
let conflicted = 0

for (const row of mutabakatRows) {
  const depotCode = String(row.DepotCode ?? '').trim()
  const positionCode = String(row.PositionCode ?? '').trim()
  if (!row.SourceFileDate || !depotCode || !positionCode) {
    skipped += 1
    continue
  }

  let cash: any = null
  try {
    cash = JSON.parse(String(row.CashJson ?? 'null'))
  } catch {
    skipped += 1
    continue
  }

  const rawSelections: any[] = []
  if (cash && typeof cash === 'object') {
    if (Array.isArray((cash as any).counterSelections)) rawSelections.push(...(cash as any).counterSelections)
    if ((cash as any).counterSelection) rawSelections.push((cash as any).counterSelection)
  }
  const selections = rawSelections.filter((x) => x && typeof x === 'object')
  if (selections.length === 0) {
    skipped += 1
    continue
  }

  for (const sel of selections) {
    const receiptIdRaw = String((sel as any).receiptId ?? '').trim()
    const tx = String((sel as any).transactionDateTime ?? '').trim()
    const receiptId = buildCounterId({ rawId: receiptIdRaw, transactionDateTime: tx })
    if (!receiptId) {
      skipped += 1
      continue
    }

    const deviceIp = normalizeIpText((sel as any).deviceIp) || (depotCode ? deviceIpByDepot.get(depotCode) ?? '' : '')
    if (!deviceIp) {
      skipped += 1
      continue
    }

    const autoNo = String((sel as any).autoNo ?? '').trim() || null
    const receiptDateTime = safeDate(tx)

    try {
      const r = await pool
        .request()
        .input('SourceFileDate', mssql.Date, row.SourceFileDate)
        .input('DepotCode', mssql.NVarChar(32), depotCode)
        .input('PositionCode', mssql.NVarChar(64), positionCode)
        .input('DeviceIp', mssql.NVarChar(128), deviceIp)
        .input('ReceiptId', mssql.NVarChar(64), receiptId)
        .input('ReceiptDateTime', mssql.DateTime2(0), receiptDateTime)
        .input('AutoNo', mssql.NVarChar(64), autoNo)
        .query(`
MERGE dbo.MutabakatCashReceiptUsageItems AS t
USING (SELECT
  @SourceFileDate AS SourceFileDate,
  @DepotCode AS DepotCode,
  @PositionCode AS PositionCode,
  @DeviceIp AS DeviceIp,
  @ReceiptId AS ReceiptId
) AS s
  ON t.SourceFileDate = s.SourceFileDate
 AND t.DepotCode = s.DepotCode
 AND t.PositionCode = s.PositionCode
 AND t.DeviceIp = s.DeviceIp
 AND t.ReceiptId = s.ReceiptId
WHEN MATCHED THEN
  UPDATE SET
    ReceiptDateTime = @ReceiptDateTime,
    AutoNo = @AutoNo,
    SelectedBy = 'backfill'
WHEN NOT MATCHED THEN
  INSERT (SourceFileDate, DepotCode, PositionCode, DeviceIp, ReceiptId, ReceiptDateTime, AutoNo, SelectedBy)
  VALUES (@SourceFileDate, @DepotCode, @PositionCode, @DeviceIp, @ReceiptId, @ReceiptDateTime, @AutoNo, 'backfill')
OUTPUT $action AS action;
`)

      const action = String((r.recordset?.[0] as any)?.action ?? '')
      if (action.toUpperCase() === 'UPDATE') updated += 1
      else if (action.toUpperCase() === 'INSERT') inserted += 1
      else updated += 1
    } catch {
      conflicted += 1
    }
  }
}

const countRes = await pool.request().query('SELECT COUNT(1) AS usageCount FROM dbo.MutabakatCashReceiptUsageItems')
const usageCount = Number((countRes.recordset?.[0] as any)?.usageCount ?? 0) || 0

console.log(
  JSON.stringify(
    {
      mutabakatWithCashJson: mutabakatRows.length,
      inserted,
      updated,
      skipped,
      conflicted,
      usageCount,
    },
    null,
    2,
  ),
)

await pool.close()
