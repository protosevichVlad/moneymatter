import type { BankStatementFile, BankStatementReviewResponse } from '@bt/shared/types';
import { describe, expect, it } from 'vitest';

import { statementPreview, PREVIEW_PAGE_SIZE } from './preview';

const transaction = { date: '2026-01-01', amount: -1.23, currency: 'USD', description: 'Shop', accountName: 'Account' };
const file: BankStatementFile = {
  fileId: 'file',
  fileName: 'statement.pdf',
  importerId: 'bank',
  accountId: '1',
  transactions: Array.from({ length: 101 }, () => transaction),
};
const review: BankStatementReviewResponse = {
  totalCount: 101,
  bankSeamRows: [],
  duplicates: [
    { fileId: 'file', transactionIndex: 0, match: { kind: 'existing', transactionId: 'db' } },
    { fileId: 'file', transactionIndex: 100, match: { kind: 'batch', fileId: 'file', transactionIndex: 0 } },
  ],
};

describe('statementPreview', () => {
  it('bounds rendering to 100 rows and preserves signed decimals and duplicate kinds', () => {
    const first = statementPreview({ files: [file], review, page: 0 });
    expect(first).toHaveLength(PREVIEW_PAGE_SIZE);
    expect(first[0]).toMatchObject({ key: 'file:0', duplicate: 'existing', amount: -1.23, transactionIndex: 0 });
    expect(first[1]?.duplicate).toBeUndefined();
    const second = statementPreview({ files: [file], review, page: 1 });
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ key: 'file:100', duplicate: 'batch', transactionIndex: 100 });
  });

  it('paginates across file boundaries without losing file-local indices', () => {
    const files = [
      { ...file, transactions: [transaction] },
      { ...file, fileId: 'other' },
    ];
    const second = statementPreview({ files, review: null, page: 1 });
    expect(second).toHaveLength(2);
    expect(second[0]).toMatchObject({ fileId: 'other', transactionIndex: 99 });
    expect(statementPreview({ files: [], review: null, page: 0 })).toEqual([]);
    expect(statementPreview({ files, review: null, page: 3 })).toEqual([]);
  });
});
