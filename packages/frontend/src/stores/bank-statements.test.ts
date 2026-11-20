import * as api from '@/api/bank-statements';
import { ApiErrorResponseError } from '@/js/errors';
import { API_ERROR_CODES, type BankStatementImportProgress, type BankStatementTransaction } from '@bt/shared/types';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';

import { useBankStatementsStore, providerAccept, supportsStatementFile, readStatementFile } from './bank-statements';

vi.mock('@/api/bank-statements', () => ({
  getBankStatementProviders: vi.fn(),
  parseBankStatement: vi.fn(),
  reviewBankStatements: vi.fn(),
  executeBankStatements: vi.fn(),
  getBankStatementImportStatus: vi.fn(),
}));
vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }));
const mocks = vi.hoisted(() => ({
  invalidate: vi.fn(),
  refetch: vi.fn(),
  currencies: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('@tanstack/vue-query', () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidate }) }));
vi.mock('@/stores/accounts', () => ({
  useAccountsStore: () => ({
    importLinkableAccounts: [
      { id: 1, name: 'Account', currencyCode: 'USD' },
      { id: 2, name: 'Other', currencyCode: 'EUR' },
    ],
    refetchAccounts: mocks.refetch,
  }),
}));
vi.mock('@/stores/currencies', () => ({ useCurrenciesStore: () => ({ loadCurrencies: mocks.currencies }) }));
let progress: Ref<BankStatementImportProgress | null>;
let complete: () => Promise<void>;
vi.mock('@/composable/use-import-job-progress', () => ({
  useImportJobProgress: (options: { onComplete: () => Promise<void> }) => {
    complete = options.onComplete;
    return { progress, executeError: ref(null), start: mocks.start, stop: mocks.stop, setExecuteError: vi.fn() };
  },
}));

const provider = { id: 'bank', bankName: 'Банк', supportedFormats: ['PDF', '.csv', 'text/plain'] };
const transaction: BankStatementTransaction = {
  date: '2026-01-01',
  amount: -12.34,
  currency: 'USD',
  description: 'Shop',
  accountName: 'Card',
};

async function preparedStore({ count = 1 }: { count?: number } = {}) {
  vi.mocked(api.getBankStatementProviders).mockResolvedValue({ configured: true, providers: [provider] });
  const store = useBankStatementsStore();
  await store.loadProviders();
  store.setFiles({ files: Array.from({ length: count }, (_, index) => new File(['data'], `file-${index}.pdf`)) });
  store.uploads.forEach((item) => store.changeFile({ fileId: item.fileId, accountId: '1', importerId: 'bank' }));
  return store;
}

beforeEach(() => {
  vi.resetAllMocks();
  provider.supportedFormats = ['PDF', '.csv', 'text/plain'];
  progress = ref(null);
  setActivePinia(createPinia());
  vi.stubGlobal(
    'FileReader',
    class {
      result = 'data:application/pdf;base64,ZGF0YQ==';
      onload: (() => void) | null = null;
      readAsDataURL() {
        this.onload?.();
      }
    },
  );
  vi.mocked(api.parseBankStatement).mockResolvedValue({ transactions: [transaction] });
  vi.mocked(api.reviewBankStatements).mockResolvedValue({ totalCount: 1, duplicates: [], bankSeamRows: [] });
});

describe('provider catalog and file reading', () => {
  it('derives accepted extensions/MIME types from the catalog, retaining bank names', async () => {
    expect(providerAccept({ providers: [provider, provider] })).toBe('.pdf,.csv,text/plain');
    expect(supportsStatementFile({ provider, file: new File(['x'], 'STATEMENT.PDF') })).toBe(true);
    expect(supportsStatementFile({ provider, file: new File(['x'], 'statement.xml') })).toBe(false);
    expect(supportsStatementFile({ provider, file: new File(['x'], 'statement', { type: 'text/plain' }) })).toBe(true);
    expect(providerAccept({ providers: [] })).toBe('');
    expect(
      supportsStatementFile({ provider: { ...provider, supportedFormats: [] }, file: new File(['x'], 'file.pdf') }),
    ).toBe(false);
    expect(await readStatementFile({ file: new File(['data'], 'file.pdf') })).toBe('ZGF0YQ==');
    const store = await preparedStore();
    expect(store.providers[0]?.bankName).toBe('Банк');
  });

  it('rejects file read errors', async () => {
    vi.stubGlobal(
      'FileReader',
      class {
        onerror: (() => void) | null = null;
        readAsDataURL() {
          this.onerror?.();
        }
      },
    );
    await expect(readStatementFile({ file: new File(['x'], 'file.pdf') })).rejects.toThrow();
  });

  it('distinguishes not configured from unavailable and supports retry', async () => {
    const store = useBankStatementsStore();
    vi.mocked(api.getBankStatementProviders).mockResolvedValueOnce({ configured: false, providers: [] });
    await store.loadProviders();
    expect(store.configured).toBe(false);
    expect(store.catalogError).toBe(false);
    vi.mocked(api.getBankStatementProviders).mockRejectedValueOnce(new Error('unavailable'));
    await store.loadProviders();
    expect(store.catalogError).toBe(true);
    vi.mocked(api.getBankStatementProviders).mockResolvedValueOnce({ configured: true, providers: [provider] });
    await store.loadProviders();
    expect(store.catalogError).toBe(false);
    expect(store.configured).toBe(true);
  });
});

describe('bank statement session', () => {
  it('enforces count, size, empty-file limits including exact boundaries', () => {
    const store = useBankStatementsStore();
    const file = new File(['x'], 'file.pdf');
    Object.defineProperty(file, 'size', { value: 10 * 1024 * 1024, configurable: true });
    store.setFiles({ files: Array.from({ length: 20 }, () => file) });
    expect(store.uploads).toHaveLength(20);
    store.setFiles({ files: Array.from({ length: 21 }, () => file) });
    expect(store.error).toContain('fileLimits');
    expect(store.uploads).toHaveLength(20);
    Object.defineProperty(file, 'size', { value: 10 * 1024 * 1024 + 1 });
    store.setFiles({ files: [file] });
    expect(store.error).toContain('fileLimits');
    store.setFiles({ files: [new File([], 'empty.pdf')] });
    expect(store.error).toContain('fileLimits');
  });

  it('parses sequentially, preserves decimals, and requires explicitly excluding failed files', async () => {
    const store = await preparedStore({ count: 2 });
    let finish!: (result: { transactions: BankStatementTransaction[] }) => void;
    vi.mocked(api.parseBankStatement).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.mocked(api.parseBankStatement).mockRejectedValueOnce(new Error('unavailable'));
    const pending = store.parseFiles();
    await Promise.resolve();
    expect(api.parseBankStatement).toHaveBeenCalledTimes(1);
    expect(store.locked).toBe(true);
    finish({ transactions: [transaction] });
    await pending;
    expect(api.parseBankStatement).toHaveBeenCalledTimes(2);
    expect(store.parsedFiles[0]?.transactions[0]?.amount).toBe(-12.34);
    expect(store.canReview).toBe(false);
    expect(store.uploads[1]?.error).toContain('parseFailed');
    store.changeFile({ fileId: store.uploads[1]!.fileId, excluded: true });
    expect(store.canReview).toBe(true);
    await store.reviewFiles();
    expect(api.reviewBankStatements).toHaveBeenCalledWith(expect.objectContaining({ files: [store.parsedFiles[0]] }));
  });

  it('blocks currency mismatches and unsupported formats and allows correction/retry', async () => {
    const store = await preparedStore();
    store.changeFile({ fileId: store.uploads[0]!.fileId, accountId: '2' });
    await store.parseFiles();
    expect(store.uploads[0]?.error).toContain('currencyMismatch');
    expect(store.canReview).toBe(false);
    store.changeFile({ fileId: store.uploads[0]!.fileId, accountId: '1' });
    await store.parseFiles({ fileId: store.uploads[0]!.fileId });
    expect(store.canReview).toBe(true);
    store.providers[0]!.supportedFormats = ['XML'];
    store.changeFile({ fileId: store.uploads[0]!.fileId, importerId: 'bank' });
    await store.parseFiles();
    expect(store.uploads[0]?.error).toContain('unsupportedFormat');
  });

  it.each([
    ['currency-mismatch', 'currencyMismatch'],
    ['unsupported-format', 'unsupportedFormat'],
    ['unknown-private-diagnostic', 'parseFailed'],
  ])('maps backend parse reason %s to safe localized error %s', async (reason, key) => {
    const store = await preparedStore();
    vi.mocked(api.parseBankStatement).mockRejectedValueOnce(
      new ApiErrorResponseError('Private backend diagnostic', { code: API_ERROR_CODES.validationError, details: { reason } }),
    );
    await store.parseFiles();
    expect(store.uploads[0]?.error).toBe(`pages.bankStatements.${key}`);
    expect(store.canReview).toBe(false);
  });

  it('enforces 50k total transactions across files', async () => {
    const store = await preparedStore({ count: 2 });
    vi.mocked(api.parseBankStatement).mockResolvedValueOnce({
      transactions: Array.from({ length: 50_000 }, () => transaction),
    });
    await store.parseFiles();
    expect(store.recognized).toBe(50_000);
    expect(store.uploads[1]?.error).toContain('transactionLimit');
    expect(store.canReview).toBe(false);
  });

  it('invalidates parsed rows on account/provider changes and review on selection changes', async () => {
    const store = await preparedStore({ count: 2 });
    await store.parseFiles();
    await store.reviewFiles();
    expect(store.step).toBe('review');
    store.changeFile({ fileId: store.uploads[0]!.fileId, accountId: '2' });
    expect(store.review).toBeNull();
    expect(store.skipRows).toEqual([]);
    expect(store.uploads[0]?.parsed).toBeNull();
    expect(store.uploads[1]?.parsed).not.toBeNull();
    store.setFiles({ files: [store.uploads[1]!.file] });
    expect(store.uploads).toHaveLength(1);
    expect(store.step).toBe('upload');
  });

  it('counts duplicate and seam skips as a union and allows overriding only duplicates', async () => {
    const store = await preparedStore();
    vi.mocked(api.parseBankStatement).mockResolvedValueOnce({ transactions: [transaction, transaction, transaction] });
    await store.parseFiles();
    const fileId = store.uploads[0]!.fileId;
    vi.mocked(api.reviewBankStatements).mockResolvedValueOnce({
      totalCount: 3,
      duplicates: [
        { fileId, transactionIndex: 0, match: { kind: 'existing', transactionId: 'db' } },
        { fileId, transactionIndex: 1, match: { kind: 'batch', fileId, transactionIndex: 0 } },
      ],
      bankSeamRows: [{ fileId, transactionIndex: 1 }],
    });
    await store.reviewFiles();
    expect(store.toImport).toBe(1);
    store.toggleSkip({ fileId, transactionIndex: 0, skip: false });
    expect(store.toImport).toBe(2);
    store.toggleSkip({ fileId, transactionIndex: 1, skip: false });
    expect(store.toImport).toBe(2);
    store.toggleSkip({ fileId, transactionIndex: 2, skip: true });
    store.toggleSkip({ fileId, transactionIndex: 2, skip: true });
    expect(store.toImport).toBe(1);
    expect(store.skipRows).toHaveLength(2);
  });

  it('submits each duplicate row only once when it matches both the database and another file', async () => {
    const store = await preparedStore({ count: 2 });
    await store.parseFiles();
    const fileId = store.uploads[1]!.fileId;
    vi.mocked(api.reviewBankStatements).mockResolvedValueOnce({
      totalCount: 2,
      duplicates: [
        { fileId, transactionIndex: 0, match: { kind: 'existing', transactionId: 'db' } },
        {
          fileId,
          transactionIndex: 0,
          match: { kind: 'batch', fileId: store.uploads[0]!.fileId, transactionIndex: 0 },
        },
      ],
      bankSeamRows: [],
    });
    await store.reviewFiles();
    expect(store.skipRows).toEqual([{ fileId, transactionIndex: 0 }]);
    expect(store.duplicateCount).toBe(1);
    expect(store.toImport).toBe(1);
  });

  it('ignores late parse responses after disposal and releases files', async () => {
    const store = await preparedStore();
    let finish!: (result: { transactions: BankStatementTransaction[] }) => void;
    vi.mocked(api.parseBankStatement).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = store.parseFiles();
    await Promise.resolve();
    store.dispose();
    finish({ transactions: [transaction] });
    await pending;
    expect(store.uploads).toEqual([]);
    expect(store.review).toBeNull();
    expect(store.busy).toBe(false);
    expect(mocks.stop).toHaveBeenCalled();
  });

  it('ignores a late review response after disposal', async () => {
    const store = await preparedStore();
    await store.parseFiles();
    let finish!: (result: { totalCount: number; duplicates: []; bankSeamRows: [] }) => void;
    vi.mocked(api.reviewBankStatements).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = store.reviewFiles();
    store.dispose();
    finish({ totalCount: 1, duplicates: [], bankSeamRows: [] });
    await pending;
    expect(store.review).toBeNull();
    expect(store.step).toBe('upload');
  });

  it('cannot bypass the transaction limit by excluding and re-including parsed files', async () => {
    const store = await preparedStore({ count: 2 });
    const firstId = store.uploads[0]!.fileId;
    const secondId = store.uploads[1]!.fileId;
    store.changeFile({ fileId: secondId, excluded: true });
    vi.mocked(api.parseBankStatement).mockResolvedValueOnce({
      transactions: Array.from({ length: 50_000 }, () => transaction),
    });
    await store.parseFiles();
    store.changeFile({ fileId: firstId, excluded: true });
    store.changeFile({ fileId: secondId, excluded: false });
    await store.parseFiles();
    store.changeFile({ fileId: firstId, excluded: false });
    expect(store.recognized).toBe(50_001);
    expect(store.canReview).toBe(false);
    expect(store.error).toContain('transactionLimit');
  });

  it('freezes an idempotent confirmation on enqueue errors and retries exactly that request', async () => {
    const store = await preparedStore();
    await store.parseFiles();
    await store.reviewFiles();
    vi.mocked(api.executeBankStatements)
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ jobId: 'job' });
    await store.execute();
    const payload = vi.mocked(api.executeBankStatements).mock.calls[0]![0];
    expect(store.locked).toBe(true);
    expect(store.dirty).toBe(true);
    store.changeFile({ fileId: store.uploads[0]!.fileId, accountId: '2' });
    store.toggleSkip({ fileId: store.uploads[0]!.fileId, transactionIndex: 0, skip: true });
    expect(store.uploads[0]?.accountId).toBe('1');
    expect(store.skipRows).toEqual([]);
    await store.execute();
    expect(vi.mocked(api.executeBankStatements).mock.calls[1]![0]).toEqual(payload);
    expect(payload.requestId).toBeTruthy();
    expect(payload.bankSeamRows).toEqual([]);
    expect(payload.bankSeamRows).not.toBe(store.review?.bankSeamRows);
    expect(store.dirty).toBe(false);
    expect(mocks.start).toHaveBeenCalledWith({
      initialProgress: { jobId: 'job', status: 'queued', processedCount: 0, totalCount: 1 },
    });
    await complete();
    expect(mocks.invalidate).toHaveBeenCalled();
    expect(mocks.refetch).toHaveBeenCalled();
    expect(mocks.currencies).toHaveBeenCalledWith({ force: true });
  });
});
