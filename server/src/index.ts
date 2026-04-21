import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import multer from 'multer'
import mssql from 'mssql'
import crypto from 'node:crypto'

dotenv.config()

const env = {
  sqlServer: process.env.SQL_SERVER ?? '',
  sqlUser: process.env.SQL_USER ?? '',
  sqlPassword: process.env.SQL_PASSWORD ?? '',
  sqlDatabase: process.env.SQL_DATABASE ?? 'HesapKapatma',
  sqlPort: process.env.SQL_PORT ? Number(process.env.SQL_PORT) : undefined,
  sqlTrustServerCertificate: (process.env.SQL_TRUST_SERVER_CERT ?? 'true').toLowerCase() !== 'false',
  port: process.env.PORT ? Number(process.env.PORT) : 3001,
  adminSecret: process.env.ADMIN_SECRET ?? '',
}

type SalesFileMeta = { fileName: string; fileDate?: string; depotCode?: string }

function parseSalesFileName(fileName: string): SalesFileMeta {
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

type RawSalesFile = { INVOICES?: unknown; COLLECTIONS?: unknown }
type RawInvoice = {
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

type RawCollection = {
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

function safeDate(value?: string) {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  const y = d.getUTCFullYear()
  if (y < 1 || y > 9999) return null
  return d
}

function computePaymentKey(invoiceCode: string, p: { code?: string; issueDate?: string; amount: number; formCode?: string }) {
  return `${invoiceCode}|${p.code ?? ''}|${p.issueDate ?? ''}|${p.amount}|${p.formCode ?? ''}`
}

let poolPromise: Promise<mssql.ConnectionPool> | null = null

function getPool() {
  if (!poolPromise) {
    if (!env.sqlServer || !env.sqlUser || !env.sqlPassword || !env.sqlDatabase) {
      throw new Error('SQL bağlantı env değişkenleri eksik: SQL_SERVER, SQL_USER, SQL_PASSWORD, SQL_DATABASE')
    }
    poolPromise = new mssql.ConnectionPool({
      server: env.sqlServer,
      port: env.sqlPort,
      user: env.sqlUser,
      password: env.sqlPassword,
      database: env.sqlDatabase,
      options: {
        trustServerCertificate: env.sqlTrustServerCertificate,
      },
    }).connect()
  }
  return poolPromise
}

async function ensureSchema(pool: mssql.ConnectionPool) {
  await pool.request().batch(`
IF OBJECT_ID('dbo.Users', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Users (
    Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    UserName NVARCHAR(64) NOT NULL UNIQUE,
    PasswordSalt VARBINARY(16) NOT NULL,
    PasswordHash VARBINARY(32) NOT NULL,
    IsActive BIT NOT NULL CONSTRAINT DF_Users_IsActive DEFAULT (1),
    CreatedAt DATETIME2(0) NOT NULL CONSTRAINT DF_Users_CreatedAt DEFAULT (SYSUTCDATETIME())
  );
END

IF OBJECT_ID('dbo.ImportFiles', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.ImportFiles (
    Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    FileName NVARCHAR(260) NOT NULL UNIQUE,
    FileDate DATE NULL,
    DepotCode NVARCHAR(32) NULL,
    ImportedAt DATETIME2(0) NOT NULL CONSTRAINT DF_ImportFiles_ImportedAt DEFAULT (SYSUTCDATETIME()),
    InvoiceCount INT NOT NULL,
    PaymentCount INT NOT NULL
  );
END

IF OBJECT_ID('dbo.Invoices', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Invoices (
    Code NVARCHAR(64) NOT NULL PRIMARY KEY,
    LegalNumber NVARCHAR(64) NULL,
    Status NVARCHAR(32) NULL,
    SalesType NVARCHAR(32) NOT NULL,
    IssueDate DATETIME2(0) NULL,
    DueDate DATETIME2(0) NULL,
    CreditDays INT NULL,
    NetAmount DECIMAL(18,4) NOT NULL,
    GrossAmount DECIMAL(18,4) NULL,
    OutstandingAmount DECIMAL(18,4) NULL,
    TaxAmount DECIMAL(18,4) NULL,
    TotalDiscount DECIMAL(18,4) NULL,
    CustomerCode NVARCHAR(64) NULL,
    CustomerName NVARCHAR(256) NOT NULL,
    CustomerTaxNumber NVARCHAR(64) NULL,
    CustomerLicenseNumber NVARCHAR(64) NULL,
    PositionCode NVARCHAR(64) NOT NULL,
    PositionDescription NVARCHAR(256) NULL,
    SourceFileName NVARCHAR(260) NULL,
    SourceFileDate DATE NULL,
    SourceDepotCode NVARCHAR(32) NULL,
    UpdatedAt DATETIME2(0) NOT NULL CONSTRAINT DF_Invoices_UpdatedAt DEFAULT (SYSUTCDATETIME())
  );
END

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Invoices_SourceFileDate_Depot_Position' AND object_id = OBJECT_ID('dbo.Invoices'))
BEGIN
  CREATE INDEX IX_Invoices_SourceFileDate_Depot_Position ON dbo.Invoices (SourceFileDate, SourceDepotCode, PositionCode);
END

IF COL_LENGTH('dbo.Invoices', 'GrossAmount') IS NULL
BEGIN
  ALTER TABLE dbo.Invoices ADD GrossAmount DECIMAL(18,4) NULL;
END

IF OBJECT_ID('dbo.Payments', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Payments (
    Id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    PaymentKey NVARCHAR(300) NOT NULL UNIQUE,
    InvoiceCode NVARCHAR(64) NOT NULL,
    Code NVARCHAR(64) NULL,
    IssueDate DATETIME2(0) NULL,
    Amount DECIMAL(18,4) NOT NULL,
    PaymentFormCode NVARCHAR(32) NULL,
    PaymentFormDescription NVARCHAR(64) NULL,
    SourceFileName NVARCHAR(260) NULL,
    CONSTRAINT FK_Payments_Invoices FOREIGN KEY (InvoiceCode) REFERENCES dbo.Invoices(Code)
  );
END

IF OBJECT_ID('dbo.InvoiceAllocations', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.InvoiceAllocations (
    InvoiceCode NVARCHAR(64) NOT NULL PRIMARY KEY,
    AllocationsJson NVARCHAR(MAX) NOT NULL,
    UpdatedBy NVARCHAR(64) NULL,
    UpdatedAt DATETIME2(0) NOT NULL CONSTRAINT DF_InvoiceAllocations_UpdatedAt DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT FK_InvoiceAllocations_Invoices FOREIGN KEY (InvoiceCode) REFERENCES dbo.Invoices(Code)
  );
END

IF OBJECT_ID('dbo.PaymentAllocations', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.PaymentAllocations (
    PaymentKey NVARCHAR(300) NOT NULL PRIMARY KEY,
    AllocationsJson NVARCHAR(MAX) NOT NULL,
    UpdatedBy NVARCHAR(64) NULL,
    UpdatedAt DATETIME2(0) NOT NULL CONSTRAINT DF_PaymentAllocations_UpdatedAt DEFAULT (SYSUTCDATETIME())
  );
END

IF OBJECT_ID('dbo.AllocationEdits', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.AllocationEdits (
    Id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    EntityType NVARCHAR(16) NOT NULL,
    EntityKey NVARCHAR(300) NOT NULL,
    FromJson NVARCHAR(MAX) NULL,
    ToJson NVARCHAR(MAX) NOT NULL,
    ChangedBy NVARCHAR(64) NULL,
    ChangedAt DATETIME2(0) NOT NULL CONSTRAINT DF_AllocationEdits_ChangedAt DEFAULT (SYSUTCDATETIME())
  );
END
`)
}

function hashPassword(password: string, salt: Buffer) {
  return crypto.pbkdf2Sync(password, salt, 120_000, 32, 'sha256')
}

async function verifyUser(pool: mssql.ConnectionPool, userName: string, password: string) {
  const r = await pool
    .request()
    .input('UserName', mssql.NVarChar(64), userName)
    .query('SELECT TOP 1 UserName, PasswordSalt, PasswordHash, IsActive FROM dbo.Users WHERE UserName = @UserName')

  const row = r.recordset?.[0] as
    | { UserName: string; PasswordSalt: Buffer; PasswordHash: Buffer; IsActive: boolean }
    | undefined

  if (!row || !row.IsActive) return false
  const computed = hashPassword(password, row.PasswordSalt)
  return crypto.timingSafeEqual(computed, row.PasswordHash)
}

async function createUser(pool: mssql.ConnectionPool, userName: string, password: string) {
  const salt = crypto.randomBytes(16)
  const hash = hashPassword(password, salt)
  await pool
    .request()
    .input('UserName', mssql.NVarChar(64), userName)
    .input('PasswordSalt', mssql.VarBinary(16), salt)
    .input('PasswordHash', mssql.VarBinary(32), hash)
    .query('INSERT INTO dbo.Users (UserName, PasswordSalt, PasswordHash) VALUES (@UserName, @PasswordSalt, @PasswordHash)')
}

async function upsertInvoice(pool: mssql.ConnectionPool, inv: RawInvoice, source: { fileName: string; fileDate?: string; depotCode?: string }) {
  const code = toStringOrUndef(inv.CODE) ?? ''
  if (!code) return { paymentCount: 0 }

  const customerName = toStringOrUndef(inv.CUSTOMER?.REGISTEREDNAME) ?? ''
  const positionCode = toStringOrUndef(inv.POSITION?.CODE) ?? ''

  const salesType = toStringOrUndef(inv.SALESTYPE) ?? ''
  const issueDate = toStringOrUndef(inv.ISSUEDATE)
  const dueDate = toStringOrUndef(inv.DUEDATE)

  await pool
    .request()
    .input('Code', mssql.NVarChar(64), code)
    .input('LegalNumber', mssql.NVarChar(64), toStringOrUndef(inv.LEGALNUMBER))
    .input('Status', mssql.NVarChar(32), toStringOrUndef(inv.STATUS))
    .input('SalesType', mssql.NVarChar(32), salesType)
    .input('IssueDate', mssql.DateTime2(0), safeDate(issueDate))
    .input('DueDate', mssql.DateTime2(0), safeDate(dueDate))
    .input('CreditDays', mssql.Int, toNumberOrUndef(inv.CREDITDAYS) ?? null)
    .input('NetAmount', mssql.Decimal(18, 4), toNumberOrUndef(inv.NETAMOUNT) ?? 0)
    .input('GrossAmount', mssql.Decimal(18, 4), toNumberOrUndef(inv.GROSSAMOUNT) ?? null)
    .input('OutstandingAmount', mssql.Decimal(18, 4), toNumberOrUndef(inv.OUTSTANDINGAMOUNT) ?? null)
    .input('TaxAmount', mssql.Decimal(18, 4), toNumberOrUndef(inv.TAXAMOUNT) ?? null)
    .input('TotalDiscount', mssql.Decimal(18, 4), toNumberOrUndef(inv.TOTAL_DISCOUNT) ?? null)
    .input('CustomerCode', mssql.NVarChar(64), toStringOrUndef(inv.CUSTOMER?.CODE))
    .input('CustomerName', mssql.NVarChar(256), customerName)
    .input('CustomerTaxNumber', mssql.NVarChar(64), toStringOrUndef(inv.CUSTOMER?.TAXNUMBER))
    .input('CustomerLicenseNumber', mssql.NVarChar(64), toStringOrUndef(inv.CUSTOMER?.LICENSENUMBER))
    .input('PositionCode', mssql.NVarChar(64), positionCode)
    .input('PositionDescription', mssql.NVarChar(256), toStringOrUndef(inv.POSITION?.DESCRIPTION))
    .input('SourceFileName', mssql.NVarChar(260), source.fileName)
    .input('SourceFileDate', mssql.Date, source.fileDate ? new Date(source.fileDate) : null)
    .input('SourceDepotCode', mssql.NVarChar(32), source.depotCode ?? null)
    .query(`
MERGE dbo.Invoices WITH (HOLDLOCK) AS t
USING (SELECT
  @Code AS Code,
  @LegalNumber AS LegalNumber,
  @Status AS Status,
  @SalesType AS SalesType,
  @IssueDate AS IssueDate,
  @DueDate AS DueDate,
  @CreditDays AS CreditDays,
  @NetAmount AS NetAmount,
  @GrossAmount AS GrossAmount,
  @OutstandingAmount AS OutstandingAmount,
  @TaxAmount AS TaxAmount,
  @TotalDiscount AS TotalDiscount,
  @CustomerCode AS CustomerCode,
  @CustomerName AS CustomerName,
  @CustomerTaxNumber AS CustomerTaxNumber,
  @CustomerLicenseNumber AS CustomerLicenseNumber,
  @PositionCode AS PositionCode,
  @PositionDescription AS PositionDescription,
  @SourceFileName AS SourceFileName,
  @SourceFileDate AS SourceFileDate,
  @SourceDepotCode AS SourceDepotCode
) AS s
ON t.Code = s.Code
WHEN MATCHED THEN UPDATE SET
  LegalNumber = s.LegalNumber,
  Status = s.Status,
  SalesType = s.SalesType,
  IssueDate = s.IssueDate,
  DueDate = s.DueDate,
  CreditDays = s.CreditDays,
  NetAmount = s.NetAmount,
  GrossAmount = s.GrossAmount,
  OutstandingAmount = s.OutstandingAmount,
  TaxAmount = s.TaxAmount,
  TotalDiscount = s.TotalDiscount,
  CustomerCode = s.CustomerCode,
  CustomerName = s.CustomerName,
  CustomerTaxNumber = s.CustomerTaxNumber,
  CustomerLicenseNumber = s.CustomerLicenseNumber,
  PositionCode = s.PositionCode,
  PositionDescription = s.PositionDescription,
  SourceFileName = s.SourceFileName,
  SourceFileDate = s.SourceFileDate,
  SourceDepotCode = s.SourceDepotCode,
  UpdatedAt = SYSUTCDATETIME()
WHEN NOT MATCHED THEN INSERT (
  Code, LegalNumber, Status, SalesType, IssueDate, DueDate, CreditDays, NetAmount, OutstandingAmount, TaxAmount, TotalDiscount,
  GrossAmount,
  CustomerCode, CustomerName, CustomerTaxNumber, CustomerLicenseNumber,
  PositionCode, PositionDescription,
  SourceFileName, SourceFileDate, SourceDepotCode
) VALUES (
  s.Code, s.LegalNumber, s.Status, s.SalesType, s.IssueDate, s.DueDate, s.CreditDays, s.NetAmount, s.OutstandingAmount, s.TaxAmount, s.TotalDiscount,
  s.GrossAmount,
  s.CustomerCode, s.CustomerName, s.CustomerTaxNumber, s.CustomerLicenseNumber,
  s.PositionCode, s.PositionDescription,
  s.SourceFileName, s.SourceFileDate, s.SourceDepotCode
);
`)

  return { paymentCount: 0 }
}

async function ensureInvoiceStub(pool: mssql.ConnectionPool, args: {
  invoiceCode: string
  positionCode?: string
  positionDescription?: string
  customerCode?: string
  customerName?: string
  customerTaxNumber?: string
  customerLicenseNumber?: string
  source: SalesFileMeta
}) {
  const invoiceCode = args.invoiceCode.trim()
  if (!invoiceCode) return

  const positionCode = (args.positionCode ?? '').trim() || 'Bilinmeyen'
  const customerName = (args.customerName ?? '').trim() || '-'

  await pool
    .request()
    .input('Code', mssql.NVarChar(64), invoiceCode)
    .input('SalesType', mssql.NVarChar(32), 'UNKNOWN')
    .input('NetAmount', mssql.Decimal(18, 4), 0)
    .input('CustomerCode', mssql.NVarChar(64), args.customerCode ?? null)
    .input('CustomerName', mssql.NVarChar(256), customerName)
    .input('CustomerTaxNumber', mssql.NVarChar(64), args.customerTaxNumber ?? null)
    .input('CustomerLicenseNumber', mssql.NVarChar(64), args.customerLicenseNumber ?? null)
    .input('PositionCode', mssql.NVarChar(64), positionCode)
    .input('PositionDescription', mssql.NVarChar(256), args.positionDescription ?? null)
    .input('SourceFileName', mssql.NVarChar(260), args.source.fileName)
    .input('SourceFileDate', mssql.Date, args.source.fileDate ? new Date(args.source.fileDate) : null)
    .input('SourceDepotCode', mssql.NVarChar(32), args.source.depotCode ?? null)
    .query(
      `
IF NOT EXISTS (SELECT 1 FROM dbo.Invoices WHERE Code = @Code)
BEGIN
  INSERT INTO dbo.Invoices (
    Code, SalesType, NetAmount,
    CustomerCode, CustomerName, CustomerTaxNumber, CustomerLicenseNumber,
    PositionCode, PositionDescription,
    SourceFileName, SourceFileDate, SourceDepotCode
  ) VALUES (
    @Code, @SalesType, @NetAmount,
    @CustomerCode, @CustomerName, @CustomerTaxNumber, @CustomerLicenseNumber,
    @PositionCode, @PositionDescription,
    @SourceFileName, @SourceFileDate, @SourceDepotCode
  );
END
`,
    )
}

async function insertCollection(pool: mssql.ConnectionPool, c: RawCollection, source: SalesFileMeta) {
  const invoiceCode = toStringOrUndef(c.INVOICE_CODE) ?? ''
  if (!invoiceCode) return

  await ensureInvoiceStub(pool, {
    invoiceCode,
    positionCode: toStringOrUndef(c.POSITION?.CODE),
    positionDescription: toStringOrUndef(c.POSITION?.DESCRIPTION),
    customerCode: toStringOrUndef(c.CUSTOMER?.CODE),
    customerName: toStringOrUndef(c.CUSTOMER?.REGISTEREDNAME),
    customerTaxNumber: toStringOrUndef(c.CUSTOMER?.TAXNUMBER),
    customerLicenseNumber: toStringOrUndef(c.CUSTOMER?.LICENSENUMBER),
    source,
  })

  const code = toStringOrUndef(c.CODE)
  const issueDate = toStringOrUndef(c.ISSUEDATE)
  const amount = toNumberOrUndef(c.AMOUNT) ?? 0
  const formCode = toStringOrUndef(c.PAYMENTFORM?.CODE)
  const formDesc = toStringOrUndef(c.PAYMENTFORM?.DESCRIPTION)

  const paymentKey = computePaymentKey(invoiceCode, { code, issueDate, amount, formCode })

  await pool
    .request()
    .input('PaymentKey', mssql.NVarChar(300), paymentKey)
    .input('InvoiceCode', mssql.NVarChar(64), invoiceCode)
    .input('Code', mssql.NVarChar(64), code ?? null)
    .input('IssueDate', mssql.DateTime2(0), safeDate(issueDate))
    .input('Amount', mssql.Decimal(18, 4), amount)
    .input('PaymentFormCode', mssql.NVarChar(32), formCode ?? null)
    .input('PaymentFormDescription', mssql.NVarChar(64), formDesc ?? null)
    .input('SourceFileName', mssql.NVarChar(260), source.fileName)
    .query(`
IF NOT EXISTS (SELECT 1 FROM dbo.Payments WHERE PaymentKey = @PaymentKey)
BEGIN
  INSERT INTO dbo.Payments (PaymentKey, InvoiceCode, Code, IssueDate, Amount, PaymentFormCode, PaymentFormDescription, SourceFileName)
  VALUES (@PaymentKey, @InvoiceCode, @Code, @IssueDate, @Amount, @PaymentFormCode, @PaymentFormDescription, @SourceFileName);
END
`)
}

async function importFile(pool: mssql.ConnectionPool, fileName: string, content: string) {
  const meta = parseSalesFileName(fileName)

  const existing = await pool
    .request()
    .input('FileName', mssql.NVarChar(260), meta.fileName)
    .query('SELECT TOP 1 FileName, FileDate, DepotCode, InvoiceCount, PaymentCount FROM dbo.ImportFiles WHERE FileName = @FileName')
  const existingRow = existing.recordset?.[0] as
    | { FileName: string; FileDate: Date | null; DepotCode: string | null; InvoiceCount: number; PaymentCount: number }
    | undefined
  if (existingRow) {
    return {
      fileName: existingRow.FileName,
      fileDate: existingRow.FileDate ? existingRow.FileDate.toISOString().slice(0, 10) : meta.fileDate,
      depotCode: existingRow.DepotCode ?? meta.depotCode,
      invoiceCount: existingRow.InvoiceCount,
      paymentCount: existingRow.PaymentCount,
      skipped: true,
      skippedPositions: [],
    }
  }

  const parsed = JSON.parse(content) as RawSalesFile
  if (!parsed || !Array.isArray(parsed.INVOICES)) {
    throw new Error(`${fileName}: Geçersiz JSON formatı (INVOICES array bekleniyor)`)
  }

  const invoices = parsed.INVOICES as RawInvoice[]
  const collections = Array.isArray(parsed.COLLECTIONS) ? (parsed.COLLECTIONS as RawCollection[]) : []

  let skippedPositions: string[] = []
  if (meta.fileDate) {
    const r = await pool
      .request()
      .input('SourceFileDate', mssql.Date, new Date(meta.fileDate))
      .input('SourceDepotCode', mssql.NVarChar(32), meta.depotCode ?? null)
      .query(
        `
SELECT DISTINCT PositionCode
FROM dbo.Invoices
WHERE SourceFileDate = @SourceFileDate
  AND (@SourceDepotCode IS NULL OR SourceDepotCode = @SourceDepotCode)
  AND PositionCode IS NOT NULL AND LTRIM(RTRIM(PositionCode)) <> ''
`,
      )
    skippedPositions = (r.recordset ?? [])
      .map((x) => String((x as { PositionCode: string }).PositionCode ?? '').trim())
      .filter((x) => !!x)
  }
  const skipPosSet = new Set(skippedPositions)

  let paymentCount = 0
  let invoiceCount = 0

  for (const inv of invoices) {
    const pos = toStringOrUndef(inv.POSITION?.CODE)?.trim()
    if (pos && skipPosSet.has(pos)) continue
    const r = await upsertInvoice(pool, inv, meta)
    paymentCount += r.paymentCount
    invoiceCount += 1
  }

  for (const c of collections) {
    const pos = toStringOrUndef(c.POSITION?.CODE)?.trim()
    if (pos && skipPosSet.has(pos)) continue
    await insertCollection(pool, c, meta)
    paymentCount += 1
  }

  await pool
    .request()
    .input('FileName', mssql.NVarChar(260), meta.fileName)
    .input('FileDate', mssql.Date, meta.fileDate ? new Date(meta.fileDate) : null)
    .input('DepotCode', mssql.NVarChar(32), meta.depotCode ?? null)
    .input('InvoiceCount', mssql.Int, invoiceCount)
    .input('PaymentCount', mssql.Int, paymentCount)
    .query(`
IF NOT EXISTS (SELECT 1 FROM dbo.ImportFiles WHERE FileName = @FileName)
BEGIN
  INSERT INTO dbo.ImportFiles (FileName, FileDate, DepotCode, InvoiceCount, PaymentCount)
  VALUES (@FileName, @FileDate, @DepotCode, @InvoiceCount, @PaymentCount);
END
`)

  return {
    fileName: meta.fileName,
    fileDate: meta.fileDate,
    depotCode: meta.depotCode,
    invoiceCount,
    paymentCount,
    skipped: false,
    skippedPositions,
  }
}

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

async function requireActiveUser(pool: mssql.ConnectionPool, userName: string) {
  const r = await pool
    .request()
    .input('UserName', mssql.NVarChar(64), userName)
    .query('SELECT TOP 1 IsActive FROM dbo.Users WHERE UserName = @UserName')
  const row = r.recordset?.[0] as { IsActive: boolean } | undefined
  return !!row?.IsActive
}

app.post('/api/auth/login', async (req, res) => {
  try {
    const userName = String(req.body?.userName ?? '').trim()
    const password = String(req.body?.password ?? '')
    if (!userName || !password) {
      res.status(400).send('Eksik alan')
      return
    }

    const pool = await getPool()
    await ensureSchema(pool)
    const ok = await verifyUser(pool, userName, password)
    if (!ok) {
      res.status(401).send('Hatalı kullanıcı adı/şifre')
      return
    }
    res.json({ ok: true, userName })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.post('/api/users', async (req, res) => {
  try {
    const secret = String(req.header('x-admin-secret') ?? '')
    if (!env.adminSecret || secret !== env.adminSecret) {
      res.status(403).send('Yetkisiz')
      return
    }

    const userName = String(req.body?.userName ?? '').trim()
    const password = String(req.body?.password ?? '')
    if (!userName || !password) {
      res.status(400).send('Eksik alan')
      return
    }

    const pool = await getPool()
    await ensureSchema(pool)
    await createUser(pool, userName, password)
    res.json({ ok: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 20, fileSize: 300 * 1024 * 1024 },
})

app.post('/api/import', upload.array('files'), async (req, res) => {
  try {
    const files = (req.files as Express.Multer.File[] | undefined) ?? []
    if (files.length === 0) {
      res.status(400).send('Dosya bulunamadı (files)')
      return
    }

    const pool = await getPool()
    await ensureSchema(pool)

    const results = []
    for (const f of files) {
      const content = f.buffer.toString('utf8')
      const r = await importFile(pool, f.originalname, content)
      results.push(r)
    }

    res.json({ ok: true, files: results })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.get('/api/positions', async (_req, res) => {
  try {
    const pool = await getPool()
    await ensureSchema(pool)
    const r = await pool.request().query(`
SELECT
  PositionCode AS code,
  MAX(PositionDescription) AS description,
  COUNT(1) AS invoiceCount
FROM dbo.Invoices
WHERE PositionCode IS NOT NULL AND LTRIM(RTRIM(PositionCode)) <> ''
GROUP BY PositionCode
ORDER BY PositionCode
`)
    res.json({ ok: true, positions: r.recordset ?? [] })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.get('/api/positions/:code', async (req, res) => {
  try {
    const positionCode = String(req.params.code ?? '').trim()
    if (!positionCode) {
      res.status(400).send('Eksik pozisyon kodu')
      return
    }

    const pool = await getPool()
    await ensureSchema(pool)

    const invRes = await pool
      .request()
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .query(
        `
SELECT
  Code, LegalNumber, Status, SalesType, IssueDate, DueDate, CreditDays, NetAmount, GrossAmount, OutstandingAmount, TaxAmount, TotalDiscount,
  CustomerCode, CustomerName, CustomerTaxNumber, CustomerLicenseNumber,
  PositionCode, PositionDescription,
  SourceFileName, SourceFileDate, SourceDepotCode
FROM dbo.Invoices
WHERE PositionCode = @PositionCode
ORDER BY Code
`,
      )

    const payRes = await pool
      .request()
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .query(
        `
SELECT
  p.PaymentKey,
  p.InvoiceCode,
  p.Code,
  p.IssueDate,
  p.Amount,
  p.PaymentFormCode,
  p.PaymentFormDescription,
  p.SourceFileName,
  i.CustomerCode,
  i.CustomerName,
  i.CustomerTaxNumber,
  i.CustomerLicenseNumber,
  i.PositionCode,
  i.PositionDescription,
  i.SourceFileDate,
  i.SourceDepotCode
FROM dbo.Payments p
JOIN dbo.Invoices i ON i.Code = p.InvoiceCode
WHERE i.PositionCode = @PositionCode
ORDER BY p.Id
`,
      )

    const invAllocRes = await pool
      .request()
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .query(
        `
SELECT ia.InvoiceCode, ia.AllocationsJson
FROM dbo.InvoiceAllocations ia
JOIN dbo.Invoices i ON i.Code = ia.InvoiceCode
WHERE i.PositionCode = @PositionCode
`,
      )

    const payAllocRes = await pool
      .request()
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .query(
        `
SELECT pa.PaymentKey, pa.AllocationsJson
FROM dbo.PaymentAllocations pa
JOIN dbo.Payments p ON p.PaymentKey = pa.PaymentKey
JOIN dbo.Invoices i ON i.Code = p.InvoiceCode
WHERE i.PositionCode = @PositionCode
`,
      )

    const invoices = (invRes.recordset ?? []).map((row) => ({
      code: String(row.Code),
      legalNumber: row.LegalNumber ?? undefined,
      status: row.Status ?? undefined,
      salesType: String(row.SalesType ?? ''),
      issueDate: row.IssueDate ? new Date(row.IssueDate).toISOString() : undefined,
      dueDate: row.DueDate ? new Date(row.DueDate).toISOString() : undefined,
      creditDays: typeof row.CreditDays === 'number' ? row.CreditDays : undefined,
      netAmount: Number(row.NetAmount ?? 0),
      grossAmount: row.GrossAmount != null ? Number(row.GrossAmount) : undefined,
      outstandingAmount: row.OutstandingAmount != null ? Number(row.OutstandingAmount) : undefined,
      taxAmount: row.TaxAmount != null ? Number(row.TaxAmount) : undefined,
      totalDiscount: row.TotalDiscount != null ? Number(row.TotalDiscount) : undefined,
      customer: {
        code: row.CustomerCode ?? undefined,
        registeredName: String(row.CustomerName ?? ''),
        taxNumber: row.CustomerTaxNumber ?? undefined,
        licenseNumber: row.CustomerLicenseNumber ?? undefined,
      },
      position: {
        code: String(row.PositionCode ?? ''),
        description: row.PositionDescription ?? undefined,
      },
      payments: [],
      source: row.SourceFileName
        ? {
            fileName: String(row.SourceFileName),
            fileDate: row.SourceFileDate ? new Date(row.SourceFileDate).toISOString().slice(0, 10) : undefined,
            depotCode: row.SourceDepotCode ?? undefined,
          }
        : undefined,
    }))

    const collections = (payRes.recordset ?? []).map((row) => ({
      paymentKey: String(row.PaymentKey),
      invoiceCode: row.InvoiceCode ?? undefined,
      code: row.Code ?? undefined,
      issueDate: row.IssueDate ? new Date(row.IssueDate).toISOString() : undefined,
      amount: Number(row.Amount ?? 0),
      paymentFormCode: row.PaymentFormCode ?? undefined,
      paymentFormDescription: row.PaymentFormDescription ?? undefined,
      customer: {
        code: row.CustomerCode ?? undefined,
        registeredName: String(row.CustomerName ?? ''),
        taxNumber: row.CustomerTaxNumber ?? undefined,
        licenseNumber: row.CustomerLicenseNumber ?? undefined,
      },
      position: {
        code: String(row.PositionCode ?? ''),
        description: row.PositionDescription ?? undefined,
      },
      source: row.SourceFileName
        ? {
            fileName: String(row.SourceFileName),
            fileDate: row.SourceFileDate ? new Date(row.SourceFileDate).toISOString().slice(0, 10) : undefined,
            depotCode: row.SourceDepotCode ?? undefined,
          }
        : undefined,
    }))

    const invoiceAllocations: Record<string, unknown> = {}
    for (const row of invAllocRes.recordset ?? []) {
      const code = String(row.InvoiceCode)
      const raw = String(row.AllocationsJson ?? '')
      if (!raw) continue
      try {
        invoiceAllocations[code] = JSON.parse(raw)
      } catch {
        invoiceAllocations[code] = []
      }
    }

    const paymentAllocations: Record<string, unknown> = {}
    for (const row of payAllocRes.recordset ?? []) {
      const key = String(row.PaymentKey)
      const raw = String(row.AllocationsJson ?? '')
      if (!raw) continue
      try {
        paymentAllocations[key] = JSON.parse(raw)
      } catch {
        paymentAllocations[key] = []
      }
    }

    res.json({
      ok: true,
      positionCode,
      invoices,
      collections,
      invoiceAllocations,
      paymentAllocations,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.post('/api/allocations/invoice', async (req, res) => {
  try {
    const userName = String(req.header('x-user') ?? '').trim()
    const invoiceCode = String(req.body?.invoiceCode ?? '').trim()
    const allocations = req.body?.allocations
    if (!userName || !invoiceCode || !Array.isArray(allocations)) {
      res.status(400).send('Eksik alan')
      return
    }

    const pool = await getPool()
    await ensureSchema(pool)
    const active = await requireActiveUser(pool, userName)
    if (!active) {
      res.status(401).send('Yetkisiz')
      return
    }

    const nextJson = JSON.stringify(allocations)
    const currentRes = await pool
      .request()
      .input('InvoiceCode', mssql.NVarChar(64), invoiceCode)
      .query('SELECT TOP 1 AllocationsJson FROM dbo.InvoiceAllocations WHERE InvoiceCode = @InvoiceCode')
    const fromJson = (currentRes.recordset?.[0]?.AllocationsJson as string | undefined) ?? null

    await pool
      .request()
      .input('InvoiceCode', mssql.NVarChar(64), invoiceCode)
      .input('AllocationsJson', mssql.NVarChar(mssql.MAX), nextJson)
      .input('UpdatedBy', mssql.NVarChar(64), userName)
      .query(
        `
MERGE dbo.InvoiceAllocations WITH (HOLDLOCK) AS t
USING (SELECT @InvoiceCode AS InvoiceCode, @AllocationsJson AS AllocationsJson, @UpdatedBy AS UpdatedBy) AS s
ON t.InvoiceCode = s.InvoiceCode
WHEN MATCHED THEN UPDATE SET AllocationsJson = s.AllocationsJson, UpdatedBy = s.UpdatedBy, UpdatedAt = SYSUTCDATETIME()
WHEN NOT MATCHED THEN INSERT (InvoiceCode, AllocationsJson, UpdatedBy) VALUES (s.InvoiceCode, s.AllocationsJson, s.UpdatedBy);
`,
      )

    await pool
      .request()
      .input('EntityType', mssql.NVarChar(16), 'invoice')
      .input('EntityKey', mssql.NVarChar(300), invoiceCode)
      .input('FromJson', mssql.NVarChar(mssql.MAX), fromJson)
      .input('ToJson', mssql.NVarChar(mssql.MAX), nextJson)
      .input('ChangedBy', mssql.NVarChar(64), userName)
      .query(
        `
INSERT INTO dbo.AllocationEdits (EntityType, EntityKey, FromJson, ToJson, ChangedBy)
VALUES (@EntityType, @EntityKey, @FromJson, @ToJson, @ChangedBy);
`,
      )

    res.json({ ok: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.post('/api/allocations/payment', async (req, res) => {
  try {
    const userName = String(req.header('x-user') ?? '').trim()
    const paymentKey = String(req.body?.paymentKey ?? '').trim()
    const allocations = req.body?.allocations
    if (!userName || !paymentKey || !Array.isArray(allocations)) {
      res.status(400).send('Eksik alan')
      return
    }

    const pool = await getPool()
    await ensureSchema(pool)
    const active = await requireActiveUser(pool, userName)
    if (!active) {
      res.status(401).send('Yetkisiz')
      return
    }

    const nextJson = JSON.stringify(allocations)
    const currentRes = await pool
      .request()
      .input('PaymentKey', mssql.NVarChar(300), paymentKey)
      .query('SELECT TOP 1 AllocationsJson FROM dbo.PaymentAllocations WHERE PaymentKey = @PaymentKey')
    const fromJson = (currentRes.recordset?.[0]?.AllocationsJson as string | undefined) ?? null

    await pool
      .request()
      .input('PaymentKey', mssql.NVarChar(300), paymentKey)
      .input('AllocationsJson', mssql.NVarChar(mssql.MAX), nextJson)
      .input('UpdatedBy', mssql.NVarChar(64), userName)
      .query(
        `
MERGE dbo.PaymentAllocations WITH (HOLDLOCK) AS t
USING (SELECT @PaymentKey AS PaymentKey, @AllocationsJson AS AllocationsJson, @UpdatedBy AS UpdatedBy) AS s
ON t.PaymentKey = s.PaymentKey
WHEN MATCHED THEN UPDATE SET AllocationsJson = s.AllocationsJson, UpdatedBy = s.UpdatedBy, UpdatedAt = SYSUTCDATETIME()
WHEN NOT MATCHED THEN INSERT (PaymentKey, AllocationsJson, UpdatedBy) VALUES (s.PaymentKey, s.AllocationsJson, s.UpdatedBy);
`,
      )

    await pool
      .request()
      .input('EntityType', mssql.NVarChar(16), 'payment')
      .input('EntityKey', mssql.NVarChar(300), paymentKey)
      .input('FromJson', mssql.NVarChar(mssql.MAX), fromJson)
      .input('ToJson', mssql.NVarChar(mssql.MAX), nextJson)
      .input('ChangedBy', mssql.NVarChar(64), userName)
      .query(
        `
INSERT INTO dbo.AllocationEdits (EntityType, EntityKey, FromJson, ToJson, ChangedBy)
VALUES (@EntityType, @EntityKey, @FromJson, @ToJson, @ChangedBy);
`,
      )

    res.json({ ok: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.get('/api/edits', async (req, res) => {
  try {
    const entityType = String(req.query.type ?? '').trim()
    const entityKey = String(req.query.key ?? '').trim()
    const changedBy = String(req.query.user ?? '').trim()

    const pool = await getPool()
    await ensureSchema(pool)

    const r = await pool
      .request()
      .input('EntityType', mssql.NVarChar(16), entityType || null)
      .input('EntityKey', mssql.NVarChar(300), entityKey || null)
      .input('ChangedBy', mssql.NVarChar(64), changedBy || null)
      .query(
        `
SELECT TOP 500
  Id, EntityType, EntityKey, FromJson, ToJson, ChangedBy, ChangedAt
FROM dbo.AllocationEdits
WHERE (@EntityType IS NULL OR EntityType = @EntityType)
  AND (@EntityKey IS NULL OR EntityKey = @EntityKey)
  AND (@ChangedBy IS NULL OR ChangedBy = @ChangedBy)
ORDER BY Id DESC
`,
      )

    res.json({ ok: true, edits: r.recordset ?? [] })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.listen(env.port, () => {
  process.stdout.write(`API listening on http://localhost:${env.port}\n`)
})
