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
  const m = /^(\d{8})_([A-Z0-9]+)_SALES$/i.exec(base)
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

type RawSalesFile = { INVOICES?: unknown; COLLECTIONS?: unknown; Id?: unknown; RowCount?: unknown; ModDate?: unknown }
type RawInvoice = {
  CODE?: unknown
  ISEDOS?: unknown
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
  DETAILS?: unknown
  RETURNGOODS?: unknown
}

type RawInvoicePayment = {
  CODE?: unknown
  ISSUEDATE?: unknown
  AMOUNT?: unknown
  PAYMENTFORM?: {
    CODE?: unknown
    DESCRIPTION?: unknown
  }
  PAYMENT_FORM?: {
    CODE?: unknown
    DESCRIPTION?: unknown
  }
}

type RawInvoiceDetailProduct = {
  SEQUENCE?: unknown
  CODE?: unknown
  DESCRIPTION?: unknown
}

type RawInvoiceDetail = {
  PRODUCT?: RawInvoiceDetailProduct
  QUANTITY?: unknown
  NETAMOUNT?: unknown
  GROSSAMOUNT?: unknown
  PRICE?: unknown
  AVAILABILITY?: unknown
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

function toNumberFlexible(v: unknown) {
  const n = toNumberOrUndef(v)
  if (typeof n === 'number') return n
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (!s) return undefined
  const cleaned = s.replaceAll('.', '').replace(',', '.')
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : undefined
}

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

function computeInvoicePaymentKey(invoiceCode: string, p: { code?: string; issueDate?: string; amount: number; formCode?: string }) {
  return `INV|${computePaymentKey(invoiceCode, p)}`
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

IF COL_LENGTH('dbo.ImportFiles', 'JsonId') IS NULL
BEGIN
  ALTER TABLE dbo.ImportFiles ADD JsonId NVARCHAR(64) NULL;
END

IF COL_LENGTH('dbo.ImportFiles', 'JsonId') IS NOT NULL
   AND EXISTS (
     SELECT 1
     FROM sys.columns c
     JOIN sys.types t ON t.user_type_id = c.user_type_id
     WHERE c.object_id = OBJECT_ID('dbo.ImportFiles')
       AND c.name = 'JsonId'
       AND t.name NOT IN ('nvarchar')
   )
BEGIN
  IF COL_LENGTH('dbo.ImportFiles', 'JsonId2') IS NULL
  BEGIN
    EXEC(N'ALTER TABLE dbo.ImportFiles ADD JsonId2 NVARCHAR(64) NULL;');
  END

  EXEC(N'UPDATE dbo.ImportFiles SET JsonId2 = CONVERT(NVARCHAR(64), JsonId) WHERE JsonId IS NOT NULL;');

  EXEC(N'ALTER TABLE dbo.ImportFiles DROP COLUMN JsonId;');
  EXEC sp_rename 'dbo.ImportFiles.JsonId2', 'JsonId', 'COLUMN';
END

IF COL_LENGTH('dbo.ImportFiles', 'JsonRowCount') IS NULL
BEGIN
  ALTER TABLE dbo.ImportFiles ADD JsonRowCount INT NULL;
END

IF COL_LENGTH('dbo.ImportFiles', 'JsonModDate') IS NULL
BEGIN
  ALTER TABLE dbo.ImportFiles ADD JsonModDate DATETIME2(0) NULL;
END

IF OBJECT_ID('dbo.Invoices', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Invoices (
    Code NVARCHAR(64) NOT NULL PRIMARY KEY,
    IsEdos BIT NULL,
    ReturnGoodsJson NVARCHAR(MAX) NULL,
    LegalNumber NVARCHAR(64) NULL,
    Status NVARCHAR(32) NULL,
    SalesType NVARCHAR(32) NOT NULL,
    IsStub BIT NOT NULL CONSTRAINT DF_Invoices_IsStub DEFAULT (0),
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

IF COL_LENGTH('dbo.Invoices', 'IsEdos') IS NULL
BEGIN
  ALTER TABLE dbo.Invoices ADD IsEdos BIT NULL;
END

IF COL_LENGTH('dbo.Invoices', 'ReturnGoodsJson') IS NULL
BEGIN
  ALTER TABLE dbo.Invoices ADD ReturnGoodsJson NVARCHAR(MAX) NULL;
END

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Invoices_SourceFileDate_Depot_Position' AND object_id = OBJECT_ID('dbo.Invoices'))
BEGIN
  CREATE INDEX IX_Invoices_SourceFileDate_Depot_Position ON dbo.Invoices (SourceFileDate, SourceDepotCode, PositionCode);
END

IF COL_LENGTH('dbo.Invoices', 'GrossAmount') IS NULL
BEGIN
  ALTER TABLE dbo.Invoices ADD GrossAmount DECIMAL(18,4) NULL;
END

IF COL_LENGTH('dbo.Invoices', 'IsStub') IS NULL
BEGIN
  ALTER TABLE dbo.Invoices ADD IsStub BIT NOT NULL CONSTRAINT DF_Invoices_IsStub DEFAULT (0);
END
EXEC(N'
UPDATE dbo.Invoices
SET IsStub = 1
WHERE IsStub = 0
  AND SalesType = ''UNKNOWN''
  AND NetAmount = 0
  AND LegalNumber IS NULL
  AND IssueDate IS NULL
  AND DueDate IS NULL;
');

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

IF COL_LENGTH('dbo.Payments', 'PaymentSource') IS NULL
BEGIN
  ALTER TABLE dbo.Payments ADD PaymentSource NVARCHAR(16) NOT NULL CONSTRAINT DF_Payments_PaymentSource DEFAULT ('COLLECTION');
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

IF OBJECT_ID('dbo.InvoiceDetails', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.InvoiceDetails (
    InvoiceCode NVARCHAR(64) NOT NULL,
    LineNumber INT NOT NULL,
    ProductSequence INT NULL,
    ProductCode NVARCHAR(64) NULL,
    ProductDescription NVARCHAR(256) NULL,
    Quantity DECIMAL(18,4) NULL,
    NetAmount DECIMAL(18,4) NULL,
    GrossAmount DECIMAL(18,4) NULL,
    Price DECIMAL(18,4) NULL,
    Availability INT NULL,
    CONSTRAINT PK_InvoiceDetails PRIMARY KEY (InvoiceCode, LineNumber),
    CONSTRAINT FK_InvoiceDetails_Invoices FOREIGN KEY (InvoiceCode) REFERENCES dbo.Invoices(Code)
  );
END

IF OBJECT_ID('dbo.InvoiceDetails', 'U') IS NOT NULL
   AND COL_LENGTH('dbo.InvoiceDetails', 'LineNo') IS NOT NULL
   AND COL_LENGTH('dbo.InvoiceDetails', 'LineNumber') IS NULL
BEGIN
  EXEC sp_rename 'dbo.InvoiceDetails.LineNo', 'LineNumber', 'COLUMN';
END

IF OBJECT_ID('dbo.Mutabakat', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Mutabakat (
    SourceFileDate DATE NOT NULL,
    DepotCode NVARCHAR(32) NOT NULL,
    PositionCode NVARCHAR(64) NOT NULL,
    Mode NVARCHAR(8) NOT NULL,
    TorbaTutari DECIMAL(18,4) NOT NULL,
    EnteredAmount DECIMAL(18,4) NOT NULL,
    AdjustmentAmount DECIMAL(18,4) NOT NULL,
    DiffAmount DECIMAL(18,4) NOT NULL,
    CashJson NVARCHAR(MAX) NULL,
    BankName NVARCHAR(64) NULL,
    BankDepositAmount DECIMAL(18,4) NULL,
    DekontNo NVARCHAR(64) NULL,
    AdjustmentsJson NVARCHAR(MAX) NULL,
    Status NVARCHAR(16) NOT NULL CONSTRAINT DF_Mutabakat_Status DEFAULT ('DRAFT'),
    CreatedBy NVARCHAR(64) NULL,
    CreatedAt DATETIME2(0) NOT NULL CONSTRAINT DF_Mutabakat_CreatedAt DEFAULT (SYSUTCDATETIME()),
    UpdatedBy NVARCHAR(64) NULL,
    UpdatedAt DATETIME2(0) NOT NULL CONSTRAINT DF_Mutabakat_UpdatedAt DEFAULT (SYSUTCDATETIME()),
    CompletedBy NVARCHAR(64) NULL,
    CompletedAt DATETIME2(0) NULL,
    CONSTRAINT PK_Mutabakat PRIMARY KEY (SourceFileDate, DepotCode, PositionCode)
  );
END

IF OBJECT_ID('dbo.PositionRepresentativeMap', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.PositionRepresentativeMap (
    PositionCode NVARCHAR(64) NOT NULL PRIMARY KEY,
    RepresentativeName NVARCHAR(128) NOT NULL,
    UpdatedBy NVARCHAR(64) NULL,
    UpdatedAt DATETIME2(0) NOT NULL CONSTRAINT DF_PositionRepresentativeMap_UpdatedAt DEFAULT (SYSUTCDATETIME())
  );
END
`)
}

async function ensureImportFilesJsonColumns(pool: mssql.ConnectionPool) {
  const r = await pool.request().query(`
SELECT
  COL_LENGTH('dbo.ImportFiles', 'JsonId') AS JsonIdLen,
  COL_LENGTH('dbo.ImportFiles', 'JsonRowCount') AS JsonRowCountLen,
  COL_LENGTH('dbo.ImportFiles', 'JsonModDate') AS JsonModDateLen
`)
  const row = (r.recordset?.[0] ?? {}) as { JsonIdLen?: unknown; JsonRowCountLen?: unknown; JsonModDateLen?: unknown }
  const needsJsonId = row.JsonIdLen == null
  const needsRowCount = row.JsonRowCountLen == null
  const needsModDate = row.JsonModDateLen == null
  if (!needsJsonId && !needsRowCount && !needsModDate) return

  const parts: string[] = []
  if (needsJsonId) parts.push("ALTER TABLE dbo.ImportFiles ADD JsonId NVARCHAR(64) NULL;")
  if (needsRowCount) parts.push('ALTER TABLE dbo.ImportFiles ADD JsonRowCount INT NULL;')
  if (needsModDate) parts.push('ALTER TABLE dbo.ImportFiles ADD JsonModDate DATETIME2(0) NULL;')
  await pool.request().batch(parts.join('\n'))
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

async function replaceInvoiceDetails(pool: mssql.ConnectionPool, invoiceCode: string, details: unknown) {
  if (!Array.isArray(details)) return

  await pool.request().input('InvoiceCode', mssql.NVarChar(64), invoiceCode).query('DELETE FROM dbo.InvoiceDetails WHERE InvoiceCode = @InvoiceCode')

  if (details.length === 0) return

  const table = new mssql.Table('dbo.InvoiceDetails')
  table.create = false
  table.columns.add('InvoiceCode', mssql.NVarChar(64), { nullable: false })
  table.columns.add('LineNumber', mssql.Int, { nullable: false })
  table.columns.add('ProductSequence', mssql.Int, { nullable: true })
  table.columns.add('ProductCode', mssql.NVarChar(64), { nullable: true })
  table.columns.add('ProductDescription', mssql.NVarChar(256), { nullable: true })
  table.columns.add('Quantity', mssql.Decimal(18, 4), { nullable: true })
  table.columns.add('NetAmount', mssql.Decimal(18, 4), { nullable: true })
  table.columns.add('GrossAmount', mssql.Decimal(18, 4), { nullable: true })
  table.columns.add('Price', mssql.Decimal(18, 4), { nullable: true })
  table.columns.add('Availability', mssql.Int, { nullable: true })

  let lineNumber = 1
  for (const d of details as RawInvoiceDetail[]) {
    if (!d || typeof d !== 'object') continue
    const product = (d.PRODUCT ?? {}) as RawInvoiceDetailProduct
    table.rows.add(
      invoiceCode,
      lineNumber,
      (toNumberOrUndef(product.SEQUENCE) ?? null) as number | null,
      (toStringOrUndef(product.CODE) ?? null) as string | null,
      (toStringOrUndef(product.DESCRIPTION) ?? null) as string | null,
      (toNumberFlexible(d.QUANTITY) ?? null) as number | null,
      (toNumberFlexible(d.NETAMOUNT) ?? null) as number | null,
      (toNumberFlexible(d.GROSSAMOUNT) ?? null) as number | null,
      (toNumberFlexible(d.PRICE) ?? null) as number | null,
      (toNumberOrUndef(d.AVAILABILITY) ?? null) as number | null,
    )
    lineNumber += 1
  }

  if (table.rows.length === 0) return
  await pool.request().bulk(table)
}

async function upsertInvoice(pool: mssql.ConnectionPool, inv: RawInvoice, source: { fileName: string; fileDate?: string; depotCode?: string }) {
  const code = toStringOrUndef(inv.CODE) ?? ''
  if (!code) return { paymentCount: 0 }

  const customerName = toStringOrUndef(inv.CUSTOMER?.REGISTEREDNAME) ?? ''
  const positionCode = toStringOrUndef(inv.POSITION?.CODE) ?? ''

  const salesType = toStringOrUndef(inv.SALESTYPE) ?? ''
  const issueDate = toStringOrUndef(inv.ISSUEDATE)
  const dueDate = toStringOrUndef(inv.DUEDATE)

  const isEdosRaw = toNumberOrUndef(inv.ISEDOS)
  const isEdos = typeof isEdosRaw === 'number' ? isEdosRaw !== 0 : null

  let returnGoodsJson: string | null = null
  if (inv.RETURNGOODS !== undefined && inv.RETURNGOODS !== null) {
    try {
      returnGoodsJson = JSON.stringify(inv.RETURNGOODS)
    } catch {
      returnGoodsJson = null
    }
  }

  await pool
    .request()
    .input('Code', mssql.NVarChar(64), code)
    .input('IsEdos', mssql.Bit, isEdos)
    .input('ReturnGoodsJson', mssql.NVarChar(mssql.MAX), returnGoodsJson)
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
  @IsEdos AS IsEdos,
  @ReturnGoodsJson AS ReturnGoodsJson,
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
  IsEdos = s.IsEdos,
  ReturnGoodsJson = s.ReturnGoodsJson,
  LegalNumber = s.LegalNumber,
  Status = s.Status,
  SalesType = s.SalesType,
  IsStub = 0,
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
  Code, IsEdos, ReturnGoodsJson, LegalNumber, Status, SalesType, IsStub, IssueDate, DueDate, CreditDays, NetAmount, OutstandingAmount, TaxAmount, TotalDiscount,
  GrossAmount,
  CustomerCode, CustomerName, CustomerTaxNumber, CustomerLicenseNumber,
  PositionCode, PositionDescription,
  SourceFileName, SourceFileDate, SourceDepotCode
) VALUES (
  s.Code, s.IsEdos, s.ReturnGoodsJson, s.LegalNumber, s.Status, s.SalesType, 0, s.IssueDate, s.DueDate, s.CreditDays, s.NetAmount, s.OutstandingAmount, s.TaxAmount, s.TotalDiscount,
  s.GrossAmount,
  s.CustomerCode, s.CustomerName, s.CustomerTaxNumber, s.CustomerLicenseNumber,
  s.PositionCode, s.PositionDescription,
  s.SourceFileName, s.SourceFileDate, s.SourceDepotCode
);
`)

  await replaceInvoiceDetails(pool, code, inv.DETAILS)

  let paymentCount = 0
  if (Array.isArray(inv.PAYMENTS)) {
    for (const raw of inv.PAYMENTS as RawInvoicePayment[]) {
      if (!raw || typeof raw !== 'object') continue
      const pCode = toStringOrUndef(raw.CODE)
      const pIssueDate = toStringOrUndef(raw.ISSUEDATE)
      const pAmount = toNumberFlexible(raw.AMOUNT) ?? 0
      if (pAmount <= 0) continue

      const form = (raw.PAYMENTFORM ?? raw.PAYMENT_FORM) as { CODE?: unknown; DESCRIPTION?: unknown } | undefined
      const rawFormCode = toStringOrUndef(form?.CODE)
      const rawFormDesc = toStringOrUndef(form?.DESCRIPTION)
      const isVadeli = !rawFormDesc || !rawFormDesc.trim()
      const formCode = isVadeli ? 'VADELI' : rawFormCode
      const formDesc = isVadeli ? 'Vadeli Ödeme' : rawFormDesc

      const paymentKey = computeInvoicePaymentKey(code, { code: pCode ?? undefined, issueDate: pIssueDate ?? undefined, amount: pAmount, formCode })

      const insertRes = await pool
        .request()
        .input('PaymentKey', mssql.NVarChar(300), paymentKey)
        .input('InvoiceCode', mssql.NVarChar(64), code)
        .input('Code', mssql.NVarChar(64), pCode ?? null)
        .input('IssueDate', mssql.DateTime2(0), safeDate(pIssueDate ?? undefined))
        .input('Amount', mssql.Decimal(18, 4), pAmount)
        .input('PaymentFormCode', mssql.NVarChar(32), formCode ?? null)
        .input('PaymentFormDescription', mssql.NVarChar(64), formDesc ?? null)
        .input('SourceFileName', mssql.NVarChar(260), source.fileName)
        .input('PaymentSource', mssql.NVarChar(16), 'INVOICE')
        .query(`
DECLARE @Inserted BIT = 0;
IF NOT EXISTS (SELECT 1 FROM dbo.Payments WHERE PaymentKey = @PaymentKey)
BEGIN
  INSERT INTO dbo.Payments (PaymentKey, InvoiceCode, Code, IssueDate, Amount, PaymentFormCode, PaymentFormDescription, SourceFileName, PaymentSource)
  VALUES (@PaymentKey, @InvoiceCode, @Code, @IssueDate, @Amount, @PaymentFormCode, @PaymentFormDescription, @SourceFileName, @PaymentSource);
  SET @Inserted = 1;
END
SELECT @Inserted AS Inserted;
`)

      const inserted = Boolean((insertRes.recordset?.[0] as { Inserted?: unknown } | undefined)?.Inserted)
      if (inserted) paymentCount += 1
    }
  }

  return { paymentCount }
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
    .input('IsStub', mssql.Bit, true)
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
    Code, SalesType, IsStub, NetAmount,
    CustomerCode, CustomerName, CustomerTaxNumber, CustomerLicenseNumber,
    PositionCode, PositionDescription,
    SourceFileName, SourceFileDate, SourceDepotCode
  ) VALUES (
    @Code, @SalesType, @IsStub, @NetAmount,
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
    .input('PaymentSource', mssql.NVarChar(16), 'COLLECTION')
    .query(`
IF NOT EXISTS (SELECT 1 FROM dbo.Payments WHERE PaymentKey = @PaymentKey)
BEGIN
  INSERT INTO dbo.Payments (PaymentKey, InvoiceCode, Code, IssueDate, Amount, PaymentFormCode, PaymentFormDescription, SourceFileName, PaymentSource)
  VALUES (@PaymentKey, @InvoiceCode, @Code, @IssueDate, @Amount, @PaymentFormCode, @PaymentFormDescription, @SourceFileName, @PaymentSource);
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
  const isReprocess = !!existingRow

  const parsed = JSON.parse(content) as RawSalesFile
  if (!parsed || !Array.isArray(parsed.INVOICES)) {
    throw new Error(`${fileName}: Geçersiz JSON formatı (INVOICES array bekleniyor)`)
  }

  const invoices = parsed.INVOICES as RawInvoice[]
  const collections = Array.isArray(parsed.COLLECTIONS) ? (parsed.COLLECTIONS as RawCollection[]) : []

  let skippedPositions: string[] = []
  if (meta.fileDate && !isReprocess) {
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

  const jsonId = toStringOrUndef(parsed.Id) ?? null
  const jsonRowCount = toNumberOrUndef(parsed.RowCount) ?? null
  const jsonModDate = safeDate(toStringOrUndef(parsed.ModDate) ?? undefined)

  await ensureImportFilesJsonColumns(pool)

  await pool
    .request()
    .input('FileName', mssql.NVarChar(260), meta.fileName)
    .input('FileDate', mssql.Date, meta.fileDate ? new Date(meta.fileDate) : null)
    .input('DepotCode', mssql.NVarChar(32), meta.depotCode ?? null)
    .input('InvoiceCount', mssql.Int, invoiceCount)
    .input('PaymentCount', mssql.Int, paymentCount)
    .input('JsonId', mssql.NVarChar(64), jsonId)
    .input('JsonRowCount', mssql.Int, jsonRowCount)
    .input('JsonModDate', mssql.DateTime2(0), jsonModDate)
    .query(`
MERGE dbo.ImportFiles WITH (HOLDLOCK) AS t
USING (SELECT
  @FileName AS FileName,
  @FileDate AS FileDate,
  @DepotCode AS DepotCode,
  @InvoiceCount AS InvoiceCount,
  @PaymentCount AS PaymentCount,
  @JsonId AS JsonId,
  @JsonRowCount AS JsonRowCount,
  @JsonModDate AS JsonModDate
) AS s
ON t.FileName = s.FileName
WHEN MATCHED THEN UPDATE SET
  FileDate = s.FileDate,
  DepotCode = s.DepotCode,
  InvoiceCount = s.InvoiceCount,
  PaymentCount = s.PaymentCount,
  JsonId = s.JsonId,
  JsonRowCount = s.JsonRowCount,
  JsonModDate = s.JsonModDate
WHEN NOT MATCHED THEN INSERT (FileName, FileDate, DepotCode, InvoiceCount, PaymentCount, JsonId, JsonRowCount, JsonModDate)
VALUES (s.FileName, s.FileDate, s.DepotCode, s.InvoiceCount, s.PaymentCount, s.JsonId, s.JsonRowCount, s.JsonModDate);
`)

  return {
    fileName: existingRow?.FileName ?? meta.fileName,
    fileDate: meta.fileDate ?? (existingRow?.FileDate ? existingRow.FileDate.toISOString().slice(0, 10) : undefined),
    depotCode: meta.depotCode ?? (existingRow?.DepotCode ?? undefined),
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

async function cleanupDatabase(pool: mssql.ConnectionPool) {
  const deletedCounts: Record<string, number> = {}

  const deleteInOrder = [
    'dbo.InvoiceDetails',
    'dbo.Payments',
    'dbo.InvoiceAllocations',
    'dbo.PaymentAllocations',
    'dbo.AllocationEdits',
    'dbo.Mutabakat',
    'dbo.PositionRepresentativeMap',
    'dbo.ImportFiles',
    'dbo.Invoices',
  ]

  for (const fullName of deleteInOrder) {
    const r = await pool.request().query(`DECLARE @c INT; DELETE FROM ${fullName}; SET @c = @@ROWCOUNT; SELECT @c AS c;`)
    const c = Number((r.recordset?.[0] as { c?: unknown } | undefined)?.c ?? 0)
    deletedCounts[fullName] = c
  }

  const keepTables = new Set([
    'Users',
    'ImportFiles',
    'Invoices',
    'Payments',
    'InvoiceAllocations',
    'PaymentAllocations',
    'AllocationEdits',
    'InvoiceDetails',
    'Mutabakat',
    'PositionRepresentativeMap',
  ])

  const toDropRes = await pool.request().query(`
SELECT t.name AS TableName
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE s.name = 'dbo'
  AND t.name NOT IN (${Array.from(keepTables)
    .map((x) => `'${x.replaceAll("'", "''")}'`)
    .join(', ')});
`)

  const dropTables = (toDropRes.recordset ?? [])
    .map((x) => String((x as { TableName?: unknown }).TableName ?? '').trim())
    .filter((x) => !!x)

  for (const tableName of dropTables) {
    const safe = tableName.replaceAll(']', ']]')
    await pool.request().batch(`
DECLARE @t SYSNAME = N'${safe}';
DECLARE @sql NVARCHAR(MAX) = N'';
SELECT @sql = @sql + N'ALTER TABLE [dbo].[' + OBJECT_NAME(fk.parent_object_id) + N'] DROP CONSTRAINT [' + fk.name + N'];' + CHAR(10)
FROM sys.foreign_keys fk
WHERE fk.parent_object_id = OBJECT_ID(N'[dbo].[' + @t + N']')
   OR fk.referenced_object_id = OBJECT_ID(N'[dbo].[' + @t + N']');
IF (@sql <> N'') EXEC sp_executesql @sql;
EXEC(N'DROP TABLE [dbo].[' + @t + N']');
`)
  }

  return { deletedCounts, droppedTables: dropTables }
}

app.post('/api/admin/cleanup', async (req, res) => {
  try {
    const secret = String(req.header('x-admin-secret') ?? '')
    if (!env.adminSecret || secret !== env.adminSecret) {
      res.status(403).send('Yetkisiz')
      return
    }

    const confirm = String(req.query.confirm ?? '').trim().toUpperCase()
    if (confirm !== 'YES') {
      res.status(400).send('Onay gerekli: ?confirm=YES')
      return
    }

    const pool = await getPool()
    await ensureSchema(pool)

    const r = await cleanupDatabase(pool)
    res.json({ ok: true, ...r })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.get('/api/position-representatives', async (req, res) => {
  try {
    const userName = String(req.header('x-user') ?? '').trim()
    if (!userName) {
      res.status(401).send('Yetkisiz')
      return
    }
    const pool = await getPool()
    await ensureSchema(pool)
    const active = await requireActiveUser(pool, userName)
    if (!active) {
      res.status(401).send('Yetkisiz')
      return
    }

    const r = await pool.request().query(
      `
SELECT
  PositionCode,
  RepresentativeName,
  UpdatedBy,
  UpdatedAt
FROM dbo.PositionRepresentativeMap
ORDER BY PositionCode
`,
    )
    const mappings = (r.recordset ?? []).map((row) => ({
      positionCode: String(row.PositionCode ?? ''),
      representativeName: String(row.RepresentativeName ?? ''),
      updatedBy: row.UpdatedBy ?? undefined,
      updatedAt: row.UpdatedAt ? new Date(row.UpdatedAt).toISOString() : undefined,
    }))
    res.json({ ok: true, mappings })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.post('/api/position-representatives', async (req, res) => {
  try {
    const userName = String(req.header('x-user') ?? '').trim()
    if (!userName) {
      res.status(401).send('Yetkisiz')
      return
    }
    const positionCode = String(req.body?.positionCode ?? '').trim()
    const representativeName = String(req.body?.representativeName ?? '').trim()
    if (!positionCode || !representativeName) {
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

    await pool
      .request()
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .input('RepresentativeName', mssql.NVarChar(128), representativeName)
      .input('UserName', mssql.NVarChar(64), userName)
      .query(
        `
MERGE dbo.PositionRepresentativeMap WITH (HOLDLOCK) AS t
USING (SELECT
  @PositionCode AS PositionCode,
  @RepresentativeName AS RepresentativeName,
  @UserName AS UserName
) AS s
ON t.PositionCode = s.PositionCode
WHEN MATCHED THEN
  UPDATE SET
    RepresentativeName = s.RepresentativeName,
    UpdatedBy = s.UserName,
    UpdatedAt = SYSUTCDATETIME()
WHEN NOT MATCHED THEN
  INSERT (PositionCode, RepresentativeName, UpdatedBy)
  VALUES (s.PositionCode, s.RepresentativeName, s.UserName);
`,
      )

    const readBack = await pool
      .request()
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .query(
        `
SELECT TOP 1 PositionCode, RepresentativeName, UpdatedBy, UpdatedAt
FROM dbo.PositionRepresentativeMap
WHERE PositionCode = @PositionCode
`,
      )
    const row = readBack.recordset?.[0] as { PositionCode: string; RepresentativeName: string; UpdatedBy: string | null; UpdatedAt: Date } | undefined
    if (!row) {
      res.status(500).send('Kayıt okunamadı')
      return
    }
    res.json({
      ok: true,
      mapping: {
        positionCode: String(row.PositionCode ?? ''),
        representativeName: String(row.RepresentativeName ?? ''),
        updatedBy: row.UpdatedBy ?? undefined,
        updatedAt: row.UpdatedAt ? new Date(row.UpdatedAt).toISOString() : undefined,
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.delete('/api/position-representatives/:positionCode', async (req, res) => {
  try {
    const userName = String(req.header('x-user') ?? '').trim()
    if (!userName) {
      res.status(401).send('Yetkisiz')
      return
    }
    const positionCode = String(req.params.positionCode ?? '').trim()
    if (!positionCode) {
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
    await pool
      .request()
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .query('DELETE FROM dbo.PositionRepresentativeMap WHERE PositionCode = @PositionCode')
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

app.get('/api/import-files', async (_req, res) => {
  try {
    const pool = await getPool()
    await ensureSchema(pool)
    const r = await pool.request().query(`
SELECT
  FileName AS fileName,
  FileDate AS fileDate,
  DepotCode AS depotCode,
  ImportedAt AS importedAt,
  InvoiceCount AS invoiceCount,
  PaymentCount AS paymentCount
FROM dbo.ImportFiles
ORDER BY FileDate DESC, ImportedAt DESC
`)
    const files = (r.recordset ?? []).map((row) => ({
      fileName: String(row.fileName ?? ''),
      fileDate: row.fileDate ? new Date(row.fileDate).toISOString().slice(0, 10) : undefined,
      depotCode: row.depotCode ?? undefined,
      importedAt: row.importedAt ? new Date(row.importedAt).toISOString() : undefined,
      invoiceCount: Number(row.invoiceCount ?? 0),
      paymentCount: Number(row.paymentCount ?? 0),
    }))
    res.json({ ok: true, files })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

function parseQueryDate(value: unknown) {
  if (typeof value !== 'string') return { ok: true as const, date: null as Date | null }
  const s = value.trim()
  if (!s) return { ok: true as const, date: null as Date | null }
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return { ok: false as const, error: 'Geçersiz tarih formatı (YYYY-MM-DD bekleniyor)' }
  return { ok: true as const, date: d }
}

app.get('/api/positions', async (req, res) => {
  try {
    const parsedDate = parseQueryDate(req.query.date)
    if (!parsedDate.ok) {
      res.status(400).send(parsedDate.error)
      return
    }
    const depot = typeof req.query.depot === 'string' ? req.query.depot.trim() : ''
    const sourceFileDate = parsedDate.date
    const sourceDepotCode = depot || null

    const pool = await getPool()
    await ensureSchema(pool)
    const r = await pool
      .request()
      .input('SourceFileDate', mssql.Date, sourceFileDate)
      .input('SourceDepotCode', mssql.NVarChar(32), sourceDepotCode)
      .query(`
SELECT
  i.PositionCode AS code,
  MAX(i.PositionDescription) AS description,
  COUNT(1) AS invoiceCount,
  MAX(m.Status) AS mutabakatStatus
FROM dbo.Invoices i
LEFT JOIN dbo.Mutabakat m
  ON m.PositionCode = i.PositionCode
  AND @SourceFileDate IS NOT NULL AND m.SourceFileDate = @SourceFileDate
  AND @SourceDepotCode IS NOT NULL AND m.DepotCode = @SourceDepotCode
WHERE i.PositionCode IS NOT NULL AND LTRIM(RTRIM(i.PositionCode)) <> ''
  AND i.IsStub = 0
  AND (@SourceFileDate IS NULL OR i.SourceFileDate = @SourceFileDate)
  AND (@SourceDepotCode IS NULL OR i.SourceDepotCode = @SourceDepotCode)
GROUP BY i.PositionCode
ORDER BY i.PositionCode
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

    const parsedDate = parseQueryDate(req.query.date)
    if (!parsedDate.ok) {
      res.status(400).send(parsedDate.error)
      return
    }
    const depot = typeof req.query.depot === 'string' ? req.query.depot.trim() : ''
    const sourceFileDate = parsedDate.date
    const sourceDepotCode = depot || null

    const pool = await getPool()
    await ensureSchema(pool)

    const invRes = await pool
      .request()
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .input('SourceFileDate', mssql.Date, sourceFileDate)
      .input('SourceDepotCode', mssql.NVarChar(32), sourceDepotCode)
      .query(
        `
SELECT
  Code, IsEdos, ReturnGoodsJson, LegalNumber, Status, SalesType, IssueDate, DueDate, CreditDays, NetAmount, GrossAmount, OutstandingAmount, TaxAmount, TotalDiscount,
  CustomerCode, CustomerName, CustomerTaxNumber, CustomerLicenseNumber,
  PositionCode, PositionDescription,
  SourceFileName, SourceFileDate, SourceDepotCode
FROM dbo.Invoices
WHERE PositionCode = @PositionCode
  AND IsStub = 0
  AND (@SourceFileDate IS NULL OR SourceFileDate = @SourceFileDate)
  AND (@SourceDepotCode IS NULL OR SourceDepotCode = @SourceDepotCode)
ORDER BY Code
`,
      )

    const detailRes = await pool
      .request()
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .input('SourceFileDate', mssql.Date, sourceFileDate)
      .input('SourceDepotCode', mssql.NVarChar(32), sourceDepotCode)
      .query(
        `
SELECT
  d.InvoiceCode,
  d.LineNumber,
  d.ProductSequence,
  d.ProductCode,
  d.ProductDescription,
  d.Quantity,
  d.NetAmount,
  d.GrossAmount,
  d.Price,
  d.Availability
FROM dbo.InvoiceDetails d
JOIN dbo.Invoices i ON i.Code = d.InvoiceCode
WHERE i.PositionCode = @PositionCode
  AND i.IsStub = 0
  AND (@SourceFileDate IS NULL OR i.SourceFileDate = @SourceFileDate)
  AND (@SourceDepotCode IS NULL OR i.SourceDepotCode = @SourceDepotCode)
ORDER BY d.InvoiceCode, d.LineNumber
`,
      )

    const payRes = await pool
      .request()
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .input('SourceFileDate', mssql.Date, sourceFileDate)
      .input('SourceDepotCode', mssql.NVarChar(32), sourceDepotCode)
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
  AND p.PaymentSource = 'COLLECTION'
  AND (@SourceFileDate IS NULL OR i.SourceFileDate = @SourceFileDate)
  AND (@SourceDepotCode IS NULL OR i.SourceDepotCode = @SourceDepotCode)
ORDER BY p.Id
`,
      )

    const invPayRes = await pool
      .request()
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .input('SourceFileDate', mssql.Date, sourceFileDate)
      .input('SourceDepotCode', mssql.NVarChar(32), sourceDepotCode)
      .query(
        `
SELECT
  p.InvoiceCode,
  p.Code,
  p.IssueDate,
  p.Amount,
  p.PaymentFormCode,
  p.PaymentFormDescription
FROM dbo.Payments p
JOIN dbo.Invoices i ON i.Code = p.InvoiceCode
WHERE i.PositionCode = @PositionCode
  AND p.PaymentSource = 'INVOICE'
  AND (@SourceFileDate IS NULL OR i.SourceFileDate = @SourceFileDate)
  AND (@SourceDepotCode IS NULL OR i.SourceDepotCode = @SourceDepotCode)
ORDER BY p.Id
`,
      )

    const invAllocRes = await pool
      .request()
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .input('SourceFileDate', mssql.Date, sourceFileDate)
      .input('SourceDepotCode', mssql.NVarChar(32), sourceDepotCode)
      .query(
        `
SELECT ia.InvoiceCode, ia.AllocationsJson
FROM dbo.InvoiceAllocations ia
JOIN dbo.Invoices i ON i.Code = ia.InvoiceCode
WHERE i.PositionCode = @PositionCode
  AND (@SourceFileDate IS NULL OR i.SourceFileDate = @SourceFileDate)
  AND (@SourceDepotCode IS NULL OR i.SourceDepotCode = @SourceDepotCode)
`,
      )

    const payAllocRes = await pool
      .request()
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .input('SourceFileDate', mssql.Date, sourceFileDate)
      .input('SourceDepotCode', mssql.NVarChar(32), sourceDepotCode)
      .query(
        `
SELECT pa.PaymentKey, pa.AllocationsJson
FROM dbo.PaymentAllocations pa
JOIN dbo.Payments p ON p.PaymentKey = pa.PaymentKey
JOIN dbo.Invoices i ON i.Code = p.InvoiceCode
WHERE i.PositionCode = @PositionCode
  AND (@SourceFileDate IS NULL OR i.SourceFileDate = @SourceFileDate)
  AND (@SourceDepotCode IS NULL OR i.SourceDepotCode = @SourceDepotCode)
`,
      )

    const invoices = (invRes.recordset ?? []).map((row) => ({
      code: String(row.Code),
      isEdos: row.IsEdos != null ? Boolean(row.IsEdos) : undefined,
      returnGoods: (() => {
        const raw = row.ReturnGoodsJson
        if (!raw) return undefined
        try {
          return JSON.parse(String(raw))
        } catch {
          return undefined
        }
      })(),
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
      payments: [] as Array<{
        code?: string
        issueDate?: string
        amount: number
        paymentFormCode?: string
        paymentFormDescription?: string
      }>,
      details: [] as Array<{
        product: { sequence?: number; code?: string; description?: string }
        quantity?: number
        netAmount?: number
        grossAmount?: number
        price?: number
        availability?: number
      }>,
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

    const paymentsByInvoiceCode = new Map<
      string,
      Array<{ code?: string; issueDate?: string; amount: number; paymentFormCode?: string; paymentFormDescription?: string }>
    >()
    for (const row of invPayRes.recordset ?? []) {
      const invoiceCode = String(row.InvoiceCode ?? '').trim()
      if (!invoiceCode) continue
      const arr = paymentsByInvoiceCode.get(invoiceCode) ?? []
      arr.push({
        code: row.Code ?? undefined,
        issueDate: row.IssueDate ? new Date(row.IssueDate).toISOString() : undefined,
        amount: Number(row.Amount ?? 0),
        paymentFormCode: row.PaymentFormCode ?? undefined,
        paymentFormDescription: row.PaymentFormDescription ?? undefined,
      })
      paymentsByInvoiceCode.set(invoiceCode, arr)
    }

    for (const inv of invoices) {
      inv.payments = paymentsByInvoiceCode.get(inv.code) ?? []
    }

    const detailsByInvoiceCode = new Map<string, Array<{
      product: { sequence?: number; code?: string; description?: string }
      quantity?: number
      netAmount?: number
      grossAmount?: number
      price?: number
      availability?: number
    }>>()
    for (const row of detailRes.recordset ?? []) {
      const invoiceCode = String(row.InvoiceCode ?? '').trim()
      if (!invoiceCode) continue
      const arr = detailsByInvoiceCode.get(invoiceCode) ?? []
      arr.push({
        product: {
          sequence: typeof row.ProductSequence === 'number' ? row.ProductSequence : row.ProductSequence != null ? Number(row.ProductSequence) : undefined,
          code: row.ProductCode ?? undefined,
          description: row.ProductDescription ?? undefined,
        },
        quantity: row.Quantity != null ? Number(row.Quantity) : undefined,
        netAmount: row.NetAmount != null ? Number(row.NetAmount) : undefined,
        grossAmount: row.GrossAmount != null ? Number(row.GrossAmount) : undefined,
        price: row.Price != null ? Number(row.Price) : undefined,
        availability: row.Availability != null ? Number(row.Availability) : undefined,
      })
      detailsByInvoiceCode.set(invoiceCode, arr)
    }

    for (const inv of invoices) {
      inv.details = detailsByInvoiceCode.get(inv.code) ?? []
    }

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

app.get('/api/mutabakat', async (req, res) => {
  try {
    const parsedDate = parseQueryDate(req.query.date)
    if (!parsedDate.ok || !parsedDate.date) {
      res.status(400).send(parsedDate.ok ? 'Tarih zorunlu' : parsedDate.error)
      return
    }
    const depot = typeof req.query.depot === 'string' ? req.query.depot.trim() : ''
    const position = typeof req.query.position === 'string' ? req.query.position.trim() : ''
    if (!depot || !position) {
      res.status(400).send('Depo ve pozisyon zorunlu')
      return
    }

    const pool = await getPool()
    await ensureSchema(pool)
    const r = await pool
      .request()
      .input('SourceFileDate', mssql.Date, parsedDate.date)
      .input('DepotCode', mssql.NVarChar(32), depot)
      .input('PositionCode', mssql.NVarChar(64), position)
      .query(
        `
SELECT TOP 1
  SourceFileDate,
  DepotCode,
  PositionCode,
  Mode,
  TorbaTutari,
  EnteredAmount,
  AdjustmentAmount,
  DiffAmount,
  CashJson,
  BankName,
  BankDepositAmount,
  DekontNo,
  AdjustmentsJson,
  Status,
  UpdatedBy,
  UpdatedAt,
  CompletedBy,
  CompletedAt
FROM dbo.Mutabakat
WHERE SourceFileDate = @SourceFileDate
  AND DepotCode = @DepotCode
  AND PositionCode = @PositionCode
`,
      )

    const row = r.recordset?.[0] as
      | {
          SourceFileDate: Date
          DepotCode: string
          PositionCode: string
          Mode: string
          TorbaTutari: unknown
          EnteredAmount: unknown
          AdjustmentAmount: unknown
          DiffAmount: unknown
          CashJson: string | null
          BankName: string | null
          BankDepositAmount: unknown
          DekontNo: string | null
          AdjustmentsJson: string | null
          Status: string
          UpdatedBy: string | null
          UpdatedAt: Date | null
          CompletedBy: string | null
          CompletedAt: Date | null
        }
      | undefined

    if (!row) {
      res.json({ ok: true, record: null })
      return
    }

    let cashJson: unknown = undefined
    if (row.CashJson) {
      try {
        cashJson = JSON.parse(row.CashJson)
      } catch {
        cashJson = undefined
      }
    }
    let adjustments: unknown = undefined
    if (row.AdjustmentsJson) {
      try {
        adjustments = JSON.parse(row.AdjustmentsJson)
      } catch {
        adjustments = undefined
      }
    }

    res.json({
      ok: true,
      record: {
        sourceFileDate: row.SourceFileDate.toISOString().slice(0, 10),
        depotCode: row.DepotCode,
        positionCode: row.PositionCode,
        mode: row.Mode,
        torbaTutari: Number(row.TorbaTutari ?? 0),
        enteredAmount: Number(row.EnteredAmount ?? 0),
        adjustmentAmount: Number(row.AdjustmentAmount ?? 0),
        diffAmount: Number(row.DiffAmount ?? 0),
        cashJson,
        bankName: row.BankName ?? undefined,
        bankDepositAmount: row.BankDepositAmount != null ? Number(row.BankDepositAmount) : undefined,
        dekontNo: row.DekontNo ?? undefined,
        adjustments: Array.isArray(adjustments) ? adjustments : undefined,
        status: row.Status,
        updatedBy: row.UpdatedBy ?? undefined,
        updatedAt: row.UpdatedAt ? new Date(row.UpdatedAt).toISOString() : undefined,
        completedBy: row.CompletedBy ?? undefined,
        completedAt: row.CompletedAt ? new Date(row.CompletedAt).toISOString() : undefined,
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.post('/api/mutabakat', async (req, res) => {
  try {
    const userName = String(req.header('x-user') ?? '').trim()
    if (!userName) {
      res.status(401).send('Yetkisiz')
      return
    }

    const parsedDate = parseQueryDate(req.body?.sourceFileDate)
    if (!parsedDate.ok || !parsedDate.date) {
      res.status(400).send(parsedDate.ok ? 'Tarih zorunlu' : parsedDate.error)
      return
    }

    const depotCode = String(req.body?.depotCode ?? '').trim()
    const positionCode = String(req.body?.positionCode ?? '').trim()
    const mode = String(req.body?.mode ?? '').trim().toUpperCase()
    if (!depotCode || !positionCode || (mode !== 'NAKIT' && mode !== 'BANKA' && mode !== 'KARMA')) {
      res.status(400).send('Eksik alan')
      return
    }

    const torbaTutari = toNumberFlexible(req.body?.torbaTutari) ?? toNumberOrUndef(req.body?.torbaTutari) ?? null
    const enteredAmount = toNumberFlexible(req.body?.enteredAmount) ?? toNumberOrUndef(req.body?.enteredAmount) ?? null
    if (torbaTutari == null || enteredAmount == null) {
      res.status(400).send('Tutar zorunlu')
      return
    }

    const adjustments = req.body?.adjustments
    const adjustmentsJson = Array.isArray(adjustments) ? JSON.stringify(adjustments) : null
    const adjustmentAmount = Array.isArray(adjustments)
      ? adjustments.reduce((s: number, a: any) => s + (toNumberFlexible(a?.amount) ?? toNumberOrUndef(a?.amount) ?? 0), 0)
      : 0
    const diffAmount = enteredAmount + adjustmentAmount - torbaTutari

    const cashJson = req.body?.cashJson
    const cashJsonStr = cashJson != null ? JSON.stringify(cashJson) : null
    const bankName = String(req.body?.bankName ?? '').trim() || null
    const bankDepositAmount = toNumberFlexible(req.body?.bankDepositAmount) ?? toNumberOrUndef(req.body?.bankDepositAmount) ?? null
    const dekontNo = String(req.body?.dekontNo ?? '').trim() || null

    const pool = await getPool()
    await ensureSchema(pool)
    const active = await requireActiveUser(pool, userName)
    if (!active) {
      res.status(401).send('Yetkisiz')
      return
    }

    const existing = await pool
      .request()
      .input('SourceFileDate', mssql.Date, parsedDate.date)
      .input('DepotCode', mssql.NVarChar(32), depotCode)
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .query(
        `
SELECT TOP 1 Status
FROM dbo.Mutabakat
WHERE SourceFileDate = @SourceFileDate
  AND DepotCode = @DepotCode
  AND PositionCode = @PositionCode
`,
      )
    const existingStatus = (existing.recordset?.[0]?.Status as string | undefined) ?? null
    if (existingStatus === 'COMPLETED') {
      res.status(409).send('Mutabakat tamamlanmış')
      return
    }

    await pool
      .request()
      .input('SourceFileDate', mssql.Date, parsedDate.date)
      .input('DepotCode', mssql.NVarChar(32), depotCode)
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .input('Mode', mssql.NVarChar(8), mode)
      .input('TorbaTutari', mssql.Decimal(18, 4), torbaTutari)
      .input('EnteredAmount', mssql.Decimal(18, 4), enteredAmount)
      .input('AdjustmentAmount', mssql.Decimal(18, 4), adjustmentAmount)
      .input('DiffAmount', mssql.Decimal(18, 4), diffAmount)
      .input('CashJson', mssql.NVarChar(mssql.MAX), cashJsonStr)
      .input('BankName', mssql.NVarChar(64), bankName)
      .input('BankDepositAmount', mssql.Decimal(18, 4), bankDepositAmount)
      .input('DekontNo', mssql.NVarChar(64), dekontNo)
      .input('AdjustmentsJson', mssql.NVarChar(mssql.MAX), adjustmentsJson)
      .input('UserName', mssql.NVarChar(64), userName)
      .query(
        `
MERGE dbo.Mutabakat WITH (HOLDLOCK) AS t
USING (SELECT
  @SourceFileDate AS SourceFileDate,
  @DepotCode AS DepotCode,
  @PositionCode AS PositionCode,
  @Mode AS Mode,
  @TorbaTutari AS TorbaTutari,
  @EnteredAmount AS EnteredAmount,
  @AdjustmentAmount AS AdjustmentAmount,
  @DiffAmount AS DiffAmount,
  @CashJson AS CashJson,
  @BankName AS BankName,
  @BankDepositAmount AS BankDepositAmount,
  @DekontNo AS DekontNo,
  @AdjustmentsJson AS AdjustmentsJson,
  @UserName AS UserName
) AS s
ON t.SourceFileDate = s.SourceFileDate AND t.DepotCode = s.DepotCode AND t.PositionCode = s.PositionCode
WHEN MATCHED THEN
  UPDATE SET
    Mode = s.Mode,
    TorbaTutari = s.TorbaTutari,
    EnteredAmount = s.EnteredAmount,
    AdjustmentAmount = s.AdjustmentAmount,
    DiffAmount = s.DiffAmount,
    CashJson = s.CashJson,
    BankName = s.BankName,
    BankDepositAmount = s.BankDepositAmount,
    DekontNo = s.DekontNo,
    AdjustmentsJson = s.AdjustmentsJson,
    UpdatedBy = s.UserName,
    UpdatedAt = SYSUTCDATETIME()
WHEN NOT MATCHED THEN
  INSERT (
    SourceFileDate, DepotCode, PositionCode, Mode,
    TorbaTutari, EnteredAmount, AdjustmentAmount, DiffAmount,
    CashJson, BankName, BankDepositAmount, DekontNo, AdjustmentsJson,
    CreatedBy, UpdatedBy
  )
  VALUES (
    s.SourceFileDate, s.DepotCode, s.PositionCode, s.Mode,
    s.TorbaTutari, s.EnteredAmount, s.AdjustmentAmount, s.DiffAmount,
    s.CashJson, s.BankName, s.BankDepositAmount, s.DekontNo, s.AdjustmentsJson,
    s.UserName, s.UserName
  );
`,
      )

    const readBack = await pool
      .request()
      .input('SourceFileDate', mssql.Date, parsedDate.date)
      .input('DepotCode', mssql.NVarChar(32), depotCode)
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .query(
        `
SELECT TOP 1
  SourceFileDate,
  DepotCode,
  PositionCode,
  Mode,
  TorbaTutari,
  EnteredAmount,
  AdjustmentAmount,
  DiffAmount,
  CashJson,
  BankName,
  BankDepositAmount,
  DekontNo,
  AdjustmentsJson,
  Status,
  UpdatedBy,
  UpdatedAt,
  CompletedBy,
  CompletedAt
FROM dbo.Mutabakat
WHERE SourceFileDate = @SourceFileDate
  AND DepotCode = @DepotCode
  AND PositionCode = @PositionCode
`,
      )

    const row = readBack.recordset?.[0] as any
    let outCash: unknown = undefined
    if (row?.CashJson) {
      try {
        outCash = JSON.parse(String(row.CashJson))
      } catch {
        outCash = undefined
      }
    }
    let outAdj: unknown = undefined
    if (row?.AdjustmentsJson) {
      try {
        outAdj = JSON.parse(String(row.AdjustmentsJson))
      } catch {
        outAdj = undefined
      }
    }

    res.json({
      ok: true,
      record: {
        sourceFileDate: new Date(row.SourceFileDate).toISOString().slice(0, 10),
        depotCode: String(row.DepotCode),
        positionCode: String(row.PositionCode),
        mode: String(row.Mode),
        torbaTutari: Number(row.TorbaTutari ?? 0),
        enteredAmount: Number(row.EnteredAmount ?? 0),
        adjustmentAmount: Number(row.AdjustmentAmount ?? 0),
        diffAmount: Number(row.DiffAmount ?? 0),
        cashJson: outCash,
        bankName: row.BankName ?? undefined,
        bankDepositAmount: row.BankDepositAmount != null ? Number(row.BankDepositAmount) : undefined,
        dekontNo: row.DekontNo ?? undefined,
        adjustments: Array.isArray(outAdj) ? outAdj : undefined,
        status: String(row.Status),
        updatedBy: row.UpdatedBy ?? undefined,
        updatedAt: row.UpdatedAt ? new Date(row.UpdatedAt).toISOString() : undefined,
        completedBy: row.CompletedBy ?? undefined,
        completedAt: row.CompletedAt ? new Date(row.CompletedAt).toISOString() : undefined,
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.post('/api/mutabakat/complete', async (req, res) => {
  try {
    const userName = String(req.header('x-user') ?? '').trim()
    if (!userName) {
      res.status(401).send('Yetkisiz')
      return
    }
    const parsedDate = parseQueryDate(req.body?.sourceFileDate)
    if (!parsedDate.ok || !parsedDate.date) {
      res.status(400).send(parsedDate.ok ? 'Tarih zorunlu' : parsedDate.error)
      return
    }
    const depotCode = String(req.body?.depotCode ?? '').trim()
    const positionCode = String(req.body?.positionCode ?? '').trim()
    if (!depotCode || !positionCode) {
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

    const current = await pool
      .request()
      .input('SourceFileDate', mssql.Date, parsedDate.date)
      .input('DepotCode', mssql.NVarChar(32), depotCode)
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .query(
        `
SELECT TOP 1 DiffAmount, Status
FROM dbo.Mutabakat
WHERE SourceFileDate = @SourceFileDate
  AND DepotCode = @DepotCode
  AND PositionCode = @PositionCode
`,
      )

    const row = current.recordset?.[0] as { DiffAmount: unknown; Status: string } | undefined
    if (!row) {
      res.status(404).send('Mutabakat kaydı bulunamadı')
      return
    }
    if (row.Status === 'COMPLETED') {
      res.status(409).send('Mutabakat zaten tamamlanmış')
      return
    }
    const diff = Number(row.DiffAmount ?? 0)
    if (Math.abs(diff) >= 0.01) {
      res.status(400).send('Fark sıfır değil')
      return
    }

    await pool
      .request()
      .input('SourceFileDate', mssql.Date, parsedDate.date)
      .input('DepotCode', mssql.NVarChar(32), depotCode)
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .input('UserName', mssql.NVarChar(64), userName)
      .query(
        `
UPDATE dbo.Mutabakat
SET Status = 'COMPLETED',
    CompletedBy = @UserName,
    CompletedAt = SYSUTCDATETIME(),
    UpdatedBy = @UserName,
    UpdatedAt = SYSUTCDATETIME()
WHERE SourceFileDate = @SourceFileDate
  AND DepotCode = @DepotCode
  AND PositionCode = @PositionCode
`,
      )

    const readBack = await pool
      .request()
      .input('SourceFileDate', mssql.Date, parsedDate.date)
      .input('DepotCode', mssql.NVarChar(32), depotCode)
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .query(
        `
SELECT TOP 1
  SourceFileDate,
  DepotCode,
  PositionCode,
  Mode,
  TorbaTutari,
  EnteredAmount,
  AdjustmentAmount,
  DiffAmount,
  CashJson,
  BankName,
  BankDepositAmount,
  DekontNo,
  AdjustmentsJson,
  Status,
  UpdatedBy,
  UpdatedAt,
  CompletedBy,
  CompletedAt
FROM dbo.Mutabakat
WHERE SourceFileDate = @SourceFileDate
  AND DepotCode = @DepotCode
  AND PositionCode = @PositionCode
`,
      )

    const rrow = readBack.recordset?.[0] as any
    let outCash: unknown = undefined
    if (rrow?.CashJson) {
      try {
        outCash = JSON.parse(String(rrow.CashJson))
      } catch {
        outCash = undefined
      }
    }
    let outAdj: unknown = undefined
    if (rrow?.AdjustmentsJson) {
      try {
        outAdj = JSON.parse(String(rrow.AdjustmentsJson))
      } catch {
        outAdj = undefined
      }
    }

    res.json({
      ok: true,
      record: {
        sourceFileDate: new Date(rrow.SourceFileDate).toISOString().slice(0, 10),
        depotCode: String(rrow.DepotCode),
        positionCode: String(rrow.PositionCode),
        mode: String(rrow.Mode),
        torbaTutari: Number(rrow.TorbaTutari ?? 0),
        enteredAmount: Number(rrow.EnteredAmount ?? 0),
        adjustmentAmount: Number(rrow.AdjustmentAmount ?? 0),
        diffAmount: Number(rrow.DiffAmount ?? 0),
        cashJson: outCash,
        bankName: rrow.BankName ?? undefined,
        bankDepositAmount: rrow.BankDepositAmount != null ? Number(rrow.BankDepositAmount) : undefined,
        dekontNo: rrow.DekontNo ?? undefined,
        adjustments: Array.isArray(outAdj) ? outAdj : undefined,
        status: String(rrow.Status),
        updatedBy: rrow.UpdatedBy ?? undefined,
        updatedAt: rrow.UpdatedAt ? new Date(rrow.UpdatedAt).toISOString() : undefined,
        completedBy: rrow.CompletedBy ?? undefined,
        completedAt: rrow.CompletedAt ? new Date(rrow.CompletedAt).toISOString() : undefined,
      },
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
