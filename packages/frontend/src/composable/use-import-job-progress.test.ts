import { SSE_EVENT_TYPES, type BankStatementImportProgress } from '@bt/shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useImportJobProgress } from './use-import-job-progress';

const sse = vi.hoisted(() => ({ connect: vi.fn(), on: vi.fn() }));
vi.mock('@/composable/use-sse', () => ({ useSSE: () => sse }));
vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }));
vi.mock('@/lib/sentry', () => ({ captureException: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  sse.connect.mockResolvedValue(undefined);
  sse.on.mockReturnValue(vi.fn());
});
afterEach(() => vi.useRealTimers());

function createWatcher() {
  const fetchStatus = vi.fn<({ jobId }: { jobId: string }) => Promise<BankStatementImportProgress>>();
  const onComplete = vi.fn();
  const watcher = useImportJobProgress<BankStatementImportProgress>({
    sseEventType: SSE_EVENT_TYPES.BANK_STATEMENT_IMPORT_PROGRESS,
    fetchStatus,
    onComplete,
    onFailure: vi.fn(),
    onLostContact: vi.fn(),
  });
  return { watcher, fetchStatus, onComplete };
}
const queued: BankStatementImportProgress = { jobId: 'first', status: 'queued', processedCount: 0, totalCount: 1 };
const completed: BankStatementImportProgress = {
  ...queued,
  status: 'completed',
  summary: { files: [], imported: 1, merged: 0, skipped: 0, skippedAfterBankSeam: 0, failed: 0 },
};

describe('import progress lifecycle', () => {
  it('ignores an in-flight status result after stopping', async () => {
    const { watcher, fetchStatus, onComplete } = createWatcher();
    let finish!: (value: BankStatementImportProgress) => void;
    fetchStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    watcher.start({ initialProgress: queued });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    watcher.stop();
    finish(completed);
    await Promise.resolve();
    expect(watcher.progress.value).toEqual(queued);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('ignores a previous job response after starting another job', async () => {
    const { watcher, fetchStatus } = createWatcher();
    let finish!: (value: BankStatementImportProgress) => void;
    fetchStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    watcher.start({ initialProgress: queued });
    await vi.advanceTimersByTimeAsync(2000);
    const next = { ...queued, jobId: 'second' };
    watcher.start({ initialProgress: next });
    finish(completed);
    await Promise.resolve();
    expect(watcher.progress.value).toEqual(next);
    watcher.stop();
  });

  it('ignores late errors after stopping and still handles terminal status once', async () => {
    const { watcher, fetchStatus, onComplete } = createWatcher();
    let reject!: (reason: Error) => void;
    fetchStatus.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    watcher.start({ initialProgress: queued });
    await vi.advanceTimersByTimeAsync(2000);
    watcher.stop();
    reject(new Error('late failure'));
    await Promise.resolve();
    expect(watcher.executeError.value).toBeNull();
    fetchStatus.mockResolvedValue(completed);
    watcher.start({ initialProgress: queued });
    await vi.advanceTimersByTimeAsync(2000);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(watcher.progress.value).toEqual(completed);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onComplete).toHaveBeenCalledTimes(1);
    watcher.stop();
  });
});
