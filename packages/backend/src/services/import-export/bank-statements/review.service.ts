import type { BankStatementFile, BankStatementReviewRequest, BankStatementReviewResponse } from '@bt/shared/types';
import { Money } from '@common/types/money';
import { getSeamStart } from '@services/accounts/seam';
import { isFromBankSeam } from '@services/import-export/core/bank-seam';
import { detectDuplicates } from '@services/transactions/duplicates-detection/detect-duplicates.service';

import { anchoredDate, fail, loadTarget, reviewSchema } from './validation';

/** All entry points, including the worker, validate the current target and currencies. */
export async function validateFiles({ userId, files, timezone }: BankStatementReviewRequest & { userId: number }) {
  const parsed = reviewSchema.safeParse({ files, timezone });
  if (!parsed.success) return fail({ reason: 'invalid-request' });
  const seams: Record<string, string | null> = {};
  const bankSeamRows: BankStatementReviewResponse['bankSeamRows'] = [];
  for (const accountId of new Set(files.map((file) => file.accountId))) {
    const account = await loadTarget({ userId, accountId });
    const seamStart = getSeamStart({ account });
    seams[accountId] = seamStart?.toISOString() ?? null;
    for (const file of files.filter((f) => f.accountId === accountId)) {
      file.transactions.forEach((tx, transactionIndex) => {
        if (tx.currency !== account.currencyCode) return fail({ reason: 'currency-mismatch' });
        if (isFromBankSeam({ seamStart, time: anchoredDate({ date: tx.date, timezone }) })) {
          bankSeamRows.push({ fileId: file.fileId, transactionIndex });
        }
      });
    }
  }
  return { seams, bankSeamRows };
}

export const rowKey = ({ fileId, transactionIndex }: { fileId: string; transactionIndex: number }) =>
  `${fileId}:${transactionIndex}`;
export function validateRefs({
  files,
  rows,
}: {
  files: BankStatementFile[];
  rows: BankStatementReviewResponse['bankSeamRows'];
}) {
  const sizes = new Map(files.map((file) => [file.fileId, file.transactions.length]));
  if (
    new Set(rows.map(rowKey)).size !== rows.length ||
    rows.some((row) => !sizes.has(row.fileId) || row.transactionIndex >= sizes.get(row.fileId)!)
  )
    return fail({ reason: 'invalid-row-reference' });
}
export function assertSameSeamRows({
  reviewed,
  current,
}: {
  reviewed: BankStatementReviewResponse['bankSeamRows'];
  current: BankStatementReviewResponse['bankSeamRows'];
}) {
  const set = new Set(reviewed.map(rowKey));
  if (set.size !== current.length || current.some((row) => !set.has(rowKey(row))))
    return fail({ reason: 'bank-link-changed' });
}

export async function reviewStatements({
  userId,
  files,
  timezone,
}: BankStatementReviewRequest & { userId: number }): Promise<BankStatementReviewResponse> {
  const { bankSeamRows } = await validateFiles({ userId, files, timezone });
  const duplicates: BankStatementReviewResponse['duplicates'] = [];
  const seamSet = new Set(bankSeamRows.map(rowKey));
  const batch = new Map<string, { fileId: string; transactionIndex: number }>();
  for (const file of files) {
    const rows = file.transactions
      .map((tx, transactionIndex) => ({
        date: anchoredDate({ date: tx.date, timezone }).toISOString().slice(0, 10),
        amount: Money.fromDecimal(tx.amount).abs().toCents(),
        type: tx.amount > 0 ? ('income' as const) : ('expense' as const),
        transactionIndex,
      }))
      .filter((row) => !seamSet.has(rowKey({ fileId: file.fileId, transactionIndex: row.transactionIndex })));
    const existing = await detectDuplicates({
      userId,
      accountId: file.accountId,
      transactions: rows,
      requireComplete: true,
    });
    for (const match of existing)
      duplicates.push({
        fileId: file.fileId,
        transactionIndex: match.incoming.transactionIndex,
        match: { kind: 'existing', transactionId: match.existing.id },
      });
    for (const row of rows) {
      const tx = file.transactions[row.transactionIndex]!;
      const description = tx.description.trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
      const key = JSON.stringify([file.accountId, row.date, row.amount, row.type, description]);
      const prior = batch.get(key);
      if (prior && prior.fileId !== file.fileId)
        duplicates.push({
          fileId: file.fileId,
          transactionIndex: row.transactionIndex,
          match: { kind: 'batch', ...prior },
        });
      if (!prior) batch.set(key, { fileId: file.fileId, transactionIndex: row.transactionIndex });
    }
  }
  return { totalCount: files.reduce((sum, file) => sum + file.transactions.length, 0), duplicates, bankSeamRows };
}
