import type {
  BankStatementExecuteRequest,
  BankStatementImportProgress,
  BankStatementParseRequest,
  BankStatementProvidersResponse,
  BankStatementReviewRequest,
  BankStatementReviewResponse,
  BankStatementTransaction,
} from '@bt/shared/types';

import { makeRequest } from './common';

export function bankStatementProviders<R extends boolean | undefined = false>({ raw }: { raw?: R } = {}) {
  return makeRequest<BankStatementProvidersResponse, R>({
    method: 'get',
    url: '/import/bank-statements/providers',
    raw,
  });
}
export function parseBankStatement<R extends boolean | undefined = false>({
  payload,
  raw,
}: {
  payload: BankStatementParseRequest;
  raw?: R;
}) {
  return makeRequest<{ transactions: BankStatementTransaction[] }, R>({
    method: 'post',
    url: '/import/bank-statements/parse',
    payload,
    raw,
  });
}
export function reviewBankStatements<R extends boolean | undefined = false>({
  payload,
  raw,
}: {
  payload: BankStatementReviewRequest;
  raw?: R;
}) {
  return makeRequest<BankStatementReviewResponse, R>({
    method: 'post',
    url: '/import/bank-statements/review',
    payload,
    raw,
  });
}
export function executeBankStatements<R extends boolean | undefined = false>({
  payload,
  raw,
}: {
  payload: BankStatementExecuteRequest & { bankSeamRows: BankStatementReviewResponse['bankSeamRows'] };
  raw?: R;
}) {
  return makeRequest<{ jobId: string }, R>({ method: 'post', url: '/import/bank-statements/execute', payload, raw });
}
export function bankStatementStatus<R extends boolean | undefined = false>({ jobId, raw }: { jobId: string; raw?: R }) {
  return makeRequest<BankStatementImportProgress, R>({
    method: 'get',
    url: `/import/bank-statements/execute/status/${jobId}`,
    raw,
  });
}
export async function waitForBankStatementImport({ jobId }: { jobId: string }) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const progress = await bankStatementStatus({ jobId, raw: true });
    if (progress.status === 'completed' || progress.status === 'failed') return progress;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Bank statement import did not settle');
}
