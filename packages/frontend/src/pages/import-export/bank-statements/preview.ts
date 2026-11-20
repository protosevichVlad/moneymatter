import type { BankStatementFile, BankStatementReviewResponse } from '@bt/shared/types';

export const PREVIEW_PAGE_SIZE = 100;

export function statementPreview({
  files,
  review,
  page,
}: {
  files: BankStatementFile[];
  review: BankStatementReviewResponse | null;
  page: number;
}) {
  const duplicates = new Map(
    review?.duplicates.map((row) => [`${row.fileId}:${row.transactionIndex}`, row.match.kind]),
  );
  const rows = [];
  let offset = 0;
  const start = page * PREVIEW_PAGE_SIZE;
  for (const file of files) {
    for (let transactionIndex = 0; transactionIndex < file.transactions.length; transactionIndex++) {
      if (offset++ < start) continue;
      if (rows.length === PREVIEW_PAGE_SIZE) return rows;
      const key = `${file.fileId}:${transactionIndex}`;
      rows.push({
        ...file.transactions[transactionIndex]!,
        fileName: file.fileName,
        fileId: file.fileId,
        transactionIndex,
        key,
        duplicate: duplicates.get(key),
      });
    }
  }
  return rows;
}
