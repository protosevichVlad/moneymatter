import * as bankApi from '@/api/bank-statements';
import { useImportJobProgress } from '@/composable/use-import-job-progress';
import { i18n } from '@/i18n';
import { ApiErrorResponseError } from '@/js/errors';
import { useAccountsStore } from '@/stores/accounts';
import { useCurrenciesStore } from '@/stores/currencies';
import {
  BANK_STATEMENT_MAX_FILES,
  BANK_STATEMENT_MAX_FILE_BYTES,
  BANK_STATEMENT_MAX_TRANSACTIONS,
  SSE_EVENT_TYPES,
  type BankStatementFile,
  type BankStatementProvider,
  type BankStatementReviewResponse,
  type BankStatementImportProgress,
  type BankStatementExecuteRequest,
} from '@bt/shared/types';
import { useQueryClient } from '@tanstack/vue-query';
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';

export interface StatementUpload {
  fileId: string;
  file: File;
  accountId: string;
  importerId: string;
  excluded: boolean;
  parsed: BankStatementFile | null;
  error: string | null;
}

export function readStatementFile({ file }: { file: File }): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('Unable to read file'));
    reader.readAsDataURL(file);
  });
}

export function providerAccept({ providers }: { providers: BankStatementProvider[] }): string {
  return [
    ...new Set(
      providers.flatMap((provider) =>
        provider.supportedFormats.map((format) =>
          format.includes('/') || format.startsWith('.') ? format.toLowerCase() : `.${format.toLowerCase()}`,
        ),
      ),
    ),
  ].join(',');
}

export function supportsStatementFile({ provider, file }: { provider: BankStatementProvider; file: File }): boolean {
  return providerAccept({ providers: [provider] })
    .split(',')
    .some(
      (format) =>
        !!format &&
        (format.startsWith('.') ? file.name.toLowerCase().endsWith(format) : file.type.toLowerCase() === format),
    );
}

export const useBankStatementsStore = defineStore('bank-statements', () => {
  const queryClient = useQueryClient();
  const accounts = useAccountsStore();
  const providers = ref<BankStatementProvider[]>([]);
  const configured = ref(false);
  const catalogLoading = ref(false);
  const catalogError = ref(false);
  const uploads = ref<StatementUpload[]>([]);
  const review = shallowRef<BankStatementReviewResponse | null>(null);
  const skipRows = ref<BankStatementExecuteRequest['skipRows']>([]);
  const step = ref<'upload' | 'review' | 'results'>('upload');
  const busy = ref(false);
  const error = ref<string | null>(null);
  const confirmation = shallowRef<BankStatementExecuteRequest | null>(null);
  let revision = 0;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const message = ({ key }: { key: string }) => i18n.global.t(`pages.bankStatements.${key}`);
  const parsedFiles = computed(() =>
    uploads.value.filter((item) => !item.excluded && item.parsed).map((item) => item.parsed!),
  );
  const recognized = computed(() => parsedFiles.value.reduce((sum, file) => sum + file.transactions.length, 0));
  const seamKeys = computed(
    () => new Set(review.value?.bankSeamRows.map((row) => `${row.fileId}:${row.transactionIndex}`)),
  );
  const duplicateRows = computed(() => [
    ...new Map(
      review.value?.duplicates.map(({ fileId, transactionIndex }) => [
        `${fileId}:${transactionIndex}`,
        { fileId, transactionIndex },
      ]),
    ).values(),
  ]);
  const duplicateCount = computed(() => duplicateRows.value.length);
  const skippedKeys = computed(() => new Set(skipRows.value.map((row) => `${row.fileId}:${row.transactionIndex}`)));
  const toImport = computed(() =>
    Math.max(0, recognized.value - new Set([...seamKeys.value, ...skippedKeys.value]).size),
  );
  const canReview = computed(
    () =>
      parsedFiles.value.length > 0 &&
      recognized.value <= BANK_STATEMENT_MAX_TRANSACTIONS &&
      uploads.value.every((item) => item.excluded || !!item.parsed),
  );
  const dirty = computed(() => uploads.value.length > 0 && step.value !== 'results');

  const job = useImportJobProgress<BankStatementImportProgress>({
    sseEventType: SSE_EVENT_TYPES.BANK_STATEMENT_IMPORT_PROGRESS,
    fetchStatus: bankApi.getBankStatementImportStatus,
    onComplete: async () => {
      step.value = 'results';
      queryClient.invalidateQueries();
      await Promise.allSettled([accounts.refetchAccounts(), useCurrenciesStore().loadCurrencies({ force: true })]);
    },
    onFailure: () => {
      step.value = 'results';
    },
    onLostContact: () => {
      step.value = 'results';
    },
  });
  const locked = computed(() => busy.value || !!confirmation.value);

  function invalidate() {
    revision++;
    review.value = null;
    skipRows.value = [];
    confirmation.value = null;
    error.value = null;
    step.value = 'upload';
  }

  async function loadProviders() {
    if (catalogLoading.value) return;
    const current = revision;
    catalogLoading.value = true;
    catalogError.value = false;
    try {
      const result = await bankApi.getBankStatementProviders();
      if (current !== revision) return;
      configured.value = result.configured;
      providers.value = result.providers;
    } catch {
      if (current === revision) catalogError.value = true;
    } finally {
      if (current === revision) catalogLoading.value = false;
    }
  }

  function setFiles({ files }: { files: File[] }) {
    if (locked.value) return;
    invalidate();
    if (
      files.length > BANK_STATEMENT_MAX_FILES ||
      files.some((file) => file.size > BANK_STATEMENT_MAX_FILE_BYTES || file.size === 0)
    ) {
      error.value = message({ key: 'fileLimits' });
      return;
    }
    uploads.value = files.map(
      (file) =>
        uploads.value.find((item) => item.file === file) ?? {
          fileId: crypto.randomUUID(),
          file,
          accountId: '',
          importerId: '',
          excluded: false,
          parsed: null,
          error: null,
        },
    );
  }

  function changeFile({
    fileId,
    accountId,
    importerId,
    excluded,
  }: {
    fileId: string;
    accountId?: string;
    importerId?: string;
    excluded?: boolean;
  }) {
    if (locked.value) return;
    const item = uploads.value.find((upload) => upload.fileId === fileId);
    if (!item) return;
    invalidate();
    if (accountId !== undefined || importerId !== undefined) {
      item.parsed = null;
      item.error = null;
    }
    if (accountId !== undefined) item.accountId = accountId;
    if (importerId !== undefined) item.importerId = importerId;
    if (excluded !== undefined) item.excluded = excluded;
    if (recognized.value > BANK_STATEMENT_MAX_TRANSACTIONS) error.value = message({ key: 'transactionLimit' });
  }

  async function parseFiles({ fileId }: { fileId?: string } = {}) {
    if (locked.value || !configured.value) return;
    invalidate();
    const current = revision;
    busy.value = true;
    try {
      // Sequential requests stay below the external provider's concurrency limit.
      for (const item of uploads.value) {
        if (item.excluded || item.parsed || (fileId && item.fileId !== fileId)) continue;
        item.error = null;
        const provider = providers.value.find((candidate) => candidate.id === item.importerId);
        const account = accounts.importLinkableAccounts.find((candidate) => String(candidate.id) === item.accountId);
        if (!provider || !account) {
          item.error = message({ key: 'selectRequired' });
          continue;
        }
        if (!supportsStatementFile({ provider, file: item.file })) {
          item.error = message({ key: 'unsupportedFormat' });
          continue;
        }
        try {
          const fileBase64 = await readStatementFile({ file: item.file });
          if (current !== revision) return;
          const result = await bankApi.parseBankStatement({
            accountId: item.accountId,
            importerId: item.importerId,
            fileName: item.file.name,
            fileBase64,
          });
          if (current !== revision) return;
          if (result.transactions.some((row) => row.currency !== account.currencyCode)) {
            item.error = message({ key: 'currencyMismatch' });
            continue;
          }
          if (recognized.value + result.transactions.length > BANK_STATEMENT_MAX_TRANSACTIONS) {
            item.error = message({ key: 'transactionLimit' });
            continue;
          }
          item.parsed = {
            fileId: item.fileId,
            fileName: item.file.name,
            accountId: item.accountId,
            importerId: item.importerId,
            transactions: result.transactions,
          };
        } catch (parseError) {
          if (current !== revision) return;
          const details = parseError instanceof ApiErrorResponseError ? parseError.data?.details : undefined;
          const reason = details && typeof details === 'object' && 'reason' in details ? details.reason : undefined;
          const key =
            reason === 'currency-mismatch'
              ? 'currencyMismatch'
              : reason === 'unsupported-format'
                ? 'unsupportedFormat'
                : 'parseFailed';
          item.error = message({ key });
        }
      }
    } finally {
      if (current === revision) busy.value = false;
    }
  }

  async function reviewFiles() {
    if (locked.value || !canReview.value) return;
    const current = revision;
    busy.value = true;
    error.value = null;
    try {
      const result = await bankApi.reviewBankStatements({ files: parsedFiles.value, timezone });
      if (current !== revision) return;
      review.value = result;
      skipRows.value = duplicateRows.value.map((row) => ({ ...row }));
      step.value = 'review';
    } catch {
      if (current === revision) error.value = message({ key: 'reviewFailed' });
    } finally {
      if (current === revision) busy.value = false;
    }
  }

  function toggleSkip({ fileId, transactionIndex, skip }: { fileId: string; transactionIndex: number; skip: boolean }) {
    if (locked.value || seamKeys.value.has(`${fileId}:${transactionIndex}`)) return;
    skipRows.value = skipRows.value.filter((row) => row.fileId !== fileId || row.transactionIndex !== transactionIndex);
    if (skip) skipRows.value.push({ fileId, transactionIndex });
  }

  function back() {
    if (!locked.value) invalidate();
  }

  async function execute() {
    if (busy.value || !review.value || toImport.value === 0) return;
    // Freeze the entire confirmation, not only its ID: retries cannot change the payload.
    const payload = (confirmation.value ??= {
      requestId: crypto.randomUUID(),
      files: parsedFiles.value,
      timezone,
      skipRows: skipRows.value.map((row) => ({ ...row })),
      bankSeamRows: review.value.bankSeamRows.map((row) => ({ ...row })),
    });
    const current = revision;
    busy.value = true;
    error.value = null;
    try {
      const { jobId } = await bankApi.executeBankStatements(payload);
      if (current !== revision) return;
      step.value = 'results';
      job.start({ initialProgress: { jobId, status: 'queued', processedCount: 0, totalCount: recognized.value } });
    } catch {
      if (current === revision) error.value = message({ key: 'executeFailed' });
    } finally {
      if (current === revision) busy.value = false;
    }
  }

  function resumeStatus() {
    if (job.progress.value) job.start({ initialProgress: job.progress.value });
  }

  function dispose() {
    revision++;
    job.stop();
    job.progress.value = null;
    job.setExecuteError(null);
    uploads.value = [];
    review.value = null;
    skipRows.value = [];
    confirmation.value = null;
    busy.value = false;
    catalogLoading.value = false;
    step.value = 'upload';
    error.value = null;
  }

  return {
    providers,
    configured,
    catalogLoading,
    catalogError,
    uploads,
    review,
    skipRows,
    step,
    busy,
    error,
    locked,
    dirty,
    parsedFiles,
    recognized,
    duplicateCount,
    seamKeys,
    skippedKeys,
    toImport,
    canReview,
    progress: job.progress,
    progressError: job.executeError,
    loadProviders,
    setFiles,
    changeFile,
    parseFiles,
    reviewFiles,
    toggleSkip,
    back,
    execute,
    resumeStatus,
    dispose,
  };
});
