import { api } from '@/api/_api';
import { describe, expect, it, vi } from 'vitest';

import {
  executeBankStatements,
  getBankStatementImportStatus,
  getBankStatementProviders,
  parseBankStatement,
  reviewBankStatements,
} from './bank-statements';

vi.mock('@/api/_api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));

describe('bank statement API', () => {
  it('uses only backend endpoints and forwards signed decimal contracts unchanged', async () => {
    vi.mocked(api.get).mockResolvedValue({ configured: false, providers: [] });
    await getBankStatementProviders();
    expect(api.get).toHaveBeenCalledWith('/import/bank-statements/providers');
    const parse = { accountId: '1', importerId: 'bank', fileName: 'statement.pdf', fileBase64: 'base64' };
    await parseBankStatement(parse);
    expect(api.post).toHaveBeenCalledWith('/import/bank-statements/parse', parse);
    const review = {
      files: [
        {
          fileId: 'file',
          fileName: 'statement.pdf',
          importerId: 'bank',
          accountId: '1',
          transactions: [
            { date: '2026-01-01', amount: -1.23, currency: 'USD', description: 'Shop', accountName: 'Card' },
          ],
        },
      ],
      timezone: 'Europe/Kyiv',
    };
    await reviewBankStatements(review);
    expect(api.post).toHaveBeenCalledWith('/import/bank-statements/review', review);
    const execute = { ...review, requestId: 'confirmation', skipRows: [{ fileId: 'file', transactionIndex: 0 }], bankSeamRows: [] };
    await executeBankStatements(execute);
    expect(api.post).toHaveBeenCalledWith('/import/bank-statements/execute', execute);
    await getBankStatementImportStatus({ jobId: 'job' });
    expect(api.get).toHaveBeenCalledWith('/import/bank-statements/execute/status/job');
  });
});
