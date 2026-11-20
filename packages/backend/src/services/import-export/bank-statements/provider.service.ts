import {
  API_ERROR_CODES,
  BANK_STATEMENT_MAX_FILE_BYTES,
  BANK_STATEMENT_MAX_TRANSACTIONS,
  type BankStatementParseRequest,
  type BankStatementProvidersResponse,
  type BankStatementTransaction,
} from '@bt/shared/types';
import { t } from '@i18n/index';
import { CustomError } from '@js/errors';
import { z } from 'zod';

import { fail, filenameSchema, importerIdSchema, loadTarget, providerSchema, transactionSchema } from './validation';

function configuredUrl(): URL | null {
  const configured = process.env.BANK_STATEMENT_API_URL;
  if (!configured) return null;
  try {
    const url = new URL(configured);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url;
  } catch {
    return upstreamError({ status: 503 });
  }
}

function upstreamError({ status }: { status: number }): never {
  throw new CustomError(
    status,
    API_ERROR_CODES.unexpected,
    t({ key: 'importExport.bankStatements.providerUnavailable' }),
  );
}

/** Bounded, uncached responses. Neither diagnostics nor upstream payloads enter errors/logs. */
async function request({
  path,
  body,
  maxBytes,
}: {
  path: string;
  body?: FormData;
  maxBytes: number;
}): Promise<unknown> {
  const base = configuredUrl();
  if (!base) return upstreamError({ status: 503 });
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 60_000);
  try {
    const response = await fetch(new URL(path, base), {
      method: body ? 'POST' : 'GET',
      body,
      signal: timeout.signal,
      redirect: 'error',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel();
      return upstreamError({ status: [400, 413, 415, 429].includes(response.status) ? response.status : 502 });
    }
    if (!response.headers.get('content-type')?.includes('application/json')) return upstreamError({ status: 502 });
    const reader = response.body?.getReader();
    if (!reader) return upstreamError({ status: 502 });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return upstreamError({ status: 502 });
      }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof CustomError) throw error;
    return upstreamError({ status: timeout.signal.aborted ? 504 : 502 });
  } finally {
    clearTimeout(timer);
  }
}

export async function getProviders(): Promise<BankStatementProvidersResponse> {
  if (!configuredUrl()) return { configured: false, providers: [] };
  const parsed = z
    .array(providerSchema)
    .max(1000)
    .safeParse(await request({ path: '/api/importers', maxBytes: 1024 * 1024 }));
  if (!parsed.success || new Set(parsed.data.map((p) => p.id)).size !== parsed.data.length)
    return upstreamError({ status: 502 });
  return { configured: true, providers: parsed.data };
}

export async function parseStatement({
  userId,
  ...input
}: BankStatementParseRequest & { userId: number }): Promise<{ transactions: BankStatementTransaction[] }> {
  const account = await loadTarget({ userId, accountId: input.accountId });
  if (!filenameSchema.safeParse(input.fileName).success || !importerIdSchema.safeParse(input.importerId).success)
    return fail({ reason: 'invalid-file' });
  const encoded = input.fileBase64;
  if (
    !encoded ||
    encoded.length > 4 * Math.ceil(BANK_STATEMENT_MAX_FILE_BYTES / 3) ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  )
    return fail({ reason: 'invalid-file' });
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > BANK_STATEMENT_MAX_FILE_BYTES || bytes.toString('base64') !== encoded)
    return fail({ reason: 'invalid-file' });
  if (!configuredUrl()) return upstreamError({ status: 503 });
  const { providers } = await getProviders();
  const provider = providers.find((p) => p.id === input.importerId);
  const extension = input.fileName.split('.').pop()!.toLowerCase();
  if (!provider?.supportedFormats.some((format) => format.toLowerCase() === extension))
    return fail({ reason: 'unsupported-format' });
  const body = new FormData();
  body.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }), input.fileName);
  body.append('importerId', input.importerId);
  const parsed = z
    .array(transactionSchema)
    .max(BANK_STATEMENT_MAX_TRANSACTIONS)
    .safeParse(await request({ path: '/api/imports', body, maxBytes: 64 * 1024 * 1024 }));
  if (!parsed.success) return upstreamError({ status: 502 });
  if (parsed.data.some((tx) => tx.currency !== account.currencyCode)) return fail({ reason: 'currency-mismatch' });
  // Account rights/link state may have changed during external processing.
  const current = await loadTarget({ userId, accountId: input.accountId });
  if (parsed.data.some((tx) => tx.currency !== current.currencyCode)) return fail({ reason: 'currency-mismatch' });
  return { transactions: parsed.data };
}
