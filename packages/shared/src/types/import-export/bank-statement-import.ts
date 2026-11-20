import type { ImportJobFailure } from './core';
import type { StatementImportSummary } from './statement-parser';

/** ImportHelper's public discovery and transaction contracts. */
export interface BankStatementProvider {
  id: string;
  bankName: string;
  supportedFormats: string[];
}

export interface BankStatementTransaction {
  date: string;
  /** Signed decimal in `currency`, not cents. */
  amount: number;
  currency: string;
  description: string;
  accountName: string;
}

export const BANK_STATEMENT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const BANK_STATEMENT_MAX_FILES = 20;
export const BANK_STATEMENT_MAX_TRANSACTIONS = 50_000;

export interface BankStatementProvidersResponse {
  configured: boolean;
  providers: BankStatementProvider[];
}

export interface BankStatementParseRequest {
  accountId: string;
  importerId: string;
  fileName: string;
  fileBase64: string;
}

/** A browser-session result, not a persisted draft. */
export interface BankStatementFile {
  fileId: string;
  fileName: string;
  importerId: string;
  accountId: string;
  transactions: BankStatementTransaction[];
}

export interface BankStatementReviewRequest {
  files: BankStatementFile[];
  timezone: string;
}

export interface BankStatementDuplicate {
  fileId: string;
  transactionIndex: number;
  match: { kind: 'existing'; transactionId: string } | { kind: 'batch'; fileId: string; transactionIndex: number };
}

export interface BankStatementReviewResponse {
  totalCount: number;
  duplicates: BankStatementDuplicate[];
  /** Rows owned by the linked bank from its seam date onward. */
  bankSeamRows: { fileId: string; transactionIndex: number }[];
}

export interface BankStatementExecuteRequest extends BankStatementReviewRequest {
  /** Stable across retries of one explicit confirmation. */
  requestId: string;
  skipRows: { fileId: string; transactionIndex: number }[];
  /** Must match the reviewed seam exclusions before a job may write. */
  bankSeamRows: { fileId: string; transactionIndex: number }[];
}

export interface BankStatementFileSummary {
  fileId: string;
  fileName: string;
  accountId: string;
  summary?: StatementImportSummary;
  /** File-level failure; rows already committed by earlier files remain imported. */
  failed?: boolean;
}

export interface BankStatementImportSummary {
  files: BankStatementFileSummary[];
  imported: number;
  merged: number;
  skipped: number;
  skippedAfterBankSeam: number;
  failed: number;
}

type BankStatementProgressBase = { jobId: string; processedCount: number; totalCount: number };
export type BankStatementImportProgress =
  | (BankStatementProgressBase & { status: 'queued' | 'running' })
  | (BankStatementProgressBase & { status: 'completed'; summary: BankStatementImportSummary })
  | (BankStatementProgressBase & { status: 'failed'; error: string; failure?: ImportJobFailure });
