import { api } from '@/api/_api';
import type {
  BankStatementProvidersResponse,
  BankStatementParseRequest,
  BankStatementTransaction,
  BankStatementReviewRequest,
  BankStatementReviewResponse,
  BankStatementExecuteRequest,
  BankStatementImportProgress,
} from '@bt/shared/types';

export const getBankStatementProviders = async (): Promise<BankStatementProvidersResponse> =>
  api.get('/import/bank-statements/providers');

export const parseBankStatement = async (
  payload: BankStatementParseRequest,
): Promise<{ transactions: BankStatementTransaction[] }> => api.post('/import/bank-statements/parse', payload);

export const reviewBankStatements = async (payload: BankStatementReviewRequest): Promise<BankStatementReviewResponse> =>
  api.post('/import/bank-statements/review', payload);

export const executeBankStatements = async (payload: BankStatementExecuteRequest): Promise<{ jobId: string }> =>
  api.post('/import/bank-statements/execute', payload);

export const getBankStatementImportStatus = async ({
  jobId,
}: {
  jobId: string;
}): Promise<BankStatementImportProgress> => api.get(`/import/bank-statements/execute/status/${jobId}`);
