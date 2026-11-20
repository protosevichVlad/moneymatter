import {
  ImportSource,
  SSE_EVENT_TYPES,
  type BankStatementImportProgress,
  type BankStatementImportSummary,
  type StatementImportSummary,
} from '@bt/shared/types';
import { Money } from '@common/types/money';
import { t } from '@i18n/index';
import { ConflictError } from '@js/errors';
import type { SentryTraceData } from '@js/utils/sentry';
import { redisClient } from '@root/redis-client';
import { createImportJobQueue } from '@services/import-export/core/queue/create-import-job-queue';
import { executeImport } from '@services/import-export/statement-parser/execute-import.service';
import { createHash } from 'node:crypto';

import { assertSameSeamRows, rowKey, validateFiles, validateRefs } from './review.service';
import { executeSchema, fail, type ExecuteInput } from './validation';

type JobData = SentryTraceData & { userId: number; input: ExecuteInput; seams: Record<string, string | null> };

const bundle = createImportJobQueue<JobData, BankStatementImportSummary, BankStatementImportProgress>({
  baseName: 'bank-statement-import',
  sseEventType: SSE_EVENT_TYPES.BANK_STATEMENT_IMPORT_PROGRESS,
  logLabel: 'Bank Statement Import',
  clearSourceDataOnSettled: true,
  processJob: async ({ job, onProgress }) => {
    const { userId, input, seams } = job.data;
    const totalCount = input.files.reduce((sum, file) => sum + file.transactions.length, 0);
    const summary: BankStatementImportSummary = {
      files: [],
      imported: 0,
      merged: 0,
      skipped: 0,
      skippedAfterBankSeam: 0,
      failed: 0,
    };
    let processed = 0;
    // Recheck the entire batch before the first write, then each file at its own boundary.
    try {
      const current = await validateFiles({ userId, ...input });
      assertSameSeamRows({ reviewed: input.bankSeamRows, current: current.bankSeamRows });
    } catch {
      throw new Error(t({ key: 'importExport.bankStatements.invalidStatement' }));
    }
    const seamRows = new Set(input.bankSeamRows.map(rowKey));
    for (const file of input.files) {
      let committed: StatementImportSummary | undefined;
      let failed = false;
      try {
        const checked = await validateFiles({ userId, files: [file], timezone: input.timezone });
        if (checked.seams[file.accountId] !== seams[file.accountId]) fail({ reason: 'bank-link-changed' });
        await executeImport({
          userId,
          accountId: file.accountId,
          timezone: input.timezone,
          importSource: ImportSource.bankStatement,
          expectedSeamStart: seams[file.accountId]!,
          transactions: file.transactions.map((tx) => ({
            date: tx.date,
            amount: Money.fromDecimal(tx.amount).abs().toNumber(),
            type: tx.amount > 0 ? 'income' : 'expense',
            description: tx.description,
          })),
          skipIndices: input.skipRows
            .filter((row) => row.fileId === file.fileId && !seamRows.has(rowKey(row)))
            .map((row) => row.transactionIndex),
          onRowsCommitted: (result) => {
            committed = {
              ...result,
              errors: result.errors.map(({ transactionIndex, code }) => ({ transactionIndex, code })),
            };
          },
          onProgress: (count) => onProgress(processed + count, totalCount),
        });
      } catch {
        // No exception diagnostics or transaction content are persisted in queue results.
        failed = true;
      }
      summary.files.push({
        fileId: file.fileId,
        fileName: file.fileName,
        accountId: file.accountId,
        ...(committed && { summary: committed }),
        ...(failed && { failed: true }),
      });
      if (committed) {
        summary.imported += committed.imported;
        summary.merged += committed.merged ?? 0;
        summary.skipped += committed.skipped;
        summary.skippedAfterBankSeam += committed.skippedAfterBankSeam ?? 0;
        summary.failed += committed.errors.length;
      } else summary.failed += file.transactions.length;
      processed += file.transactions.length;
      await onProgress(processed, totalCount);
    }
    return summary;
  },
});

export const bankStatementImportQueue = bundle.queue;
export const bankStatementImportWorker = bundle.worker;
export const getBankStatementImportProgress = bundle.getImportProgress;

export async function queueBankStatementImport({
  userId,
  input,
}: {
  userId: number;
  input: ExecuteInput;
}): Promise<{ jobId: string }> {
  const parsed = executeSchema.safeParse(input);
  if (!parsed.success) return fail({ reason: 'invalid-request' });
  const jobId = `bank-statement-${userId}-${input.requestId}`;
  const marker = `bank-statement-request-${userId}-${input.requestId}`;
  const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const prior = await redisClient.get(marker);
  if (prior) {
    if (prior !== fingerprint)
      throw new ConflictError({ message: t({ key: 'importExport.bankStatements.requestAlreadyUsed' }) });
    if (!(await bundle.queue.getJob(jobId)))
      throw new ConflictError({ message: t({ key: 'importExport.bankStatements.requestAlreadyUsed' }) });
    return { jobId };
  }
  validateRefs({ files: input.files, rows: input.skipRows });
  validateRefs({ files: input.files, rows: input.bankSeamRows });
  const { seams, bankSeamRows } = await validateFiles({ userId, ...input });
  assertSameSeamRows({ reviewed: input.bankSeamRows, current: bankSeamRows });
  // Permanent content-free tombstone: even after job retention expires, a retry cannot replay writes.
  const reserved = await redisClient.set(marker, fingerprint, 'NX');
  if (!reserved) {
    if ((await redisClient.get(marker)) !== fingerprint || !(await bundle.queue.getJob(jobId)))
      throw new ConflictError({ message: t({ key: 'importExport.bankStatements.requestAlreadyUsed' }) });
    return { jobId };
  }
  await bundle.enqueue({ userId, jobId, data: { userId, input, seams } });
  return { jobId };
}
