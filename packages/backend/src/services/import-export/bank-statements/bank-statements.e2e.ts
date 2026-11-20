import { ImportSource, VEHICLE_CLASS, type BankStatementFile, type BankStatementTransaction } from '@bt/shared/types';
import { NONEXISTENT_ID } from '@common/lib/record-id-helpers';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as helpers from '@tests/helpers';
import * as bank from '@tests/helpers/bank-statements';
import { randomUUID } from 'node:crypto';

const provider = { id: 'catalog-id', bankName: 'Test bank', supportedFormats: ['pdf'] };
const row = (overrides: Partial<BankStatementTransaction> = {}): BankStatementTransaction => ({
  date: '2024-01-15',
  amount: -12.34,
  currency: global.BASE_CURRENCY.code,
  description: 'Coffee',
  accountName: '',
  ...overrides,
});
const file = ({
  accountId,
  transactions = [row()],
  fileId = 'file-a',
}: {
  accountId: string;
  transactions?: BankStatementTransaction[];
  fileId?: string;
}): BankStatementFile => ({ fileId, accountId, transactions, fileName: 'statement.PDF', importerId: provider.id });
const parsePayload = ({ accountId, fileName = 'statement.PDF' }: { accountId: string; fileName?: string }) => ({
  accountId,
  fileName,
  importerId: provider.id,
  fileBase64: Buffer.from('opaque statement content').toString('base64'),
});
const response = ({ data, status = 200 }: { data: unknown; status?: number }) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

/** Only the external network is mocked; all feature behavior is exercised over HTTP. */
describe('External bank statements HTTP API', () => {
  let originalUrl: string | undefined;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  beforeEach(() => {
    originalUrl = process.env.BANK_STATEMENT_API_URL;
    process.env.BANK_STATEMENT_API_URL = 'http://127.0.0.1:9999';
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url) =>
        response({ data: String(url).endsWith('/api/importers') ? [provider] : [row()] }),
      );
  });
  afterEach(() => {
    fetchMock.mockRestore();
    if (originalUrl === undefined) delete process.env.BANK_STATEMENT_API_URL;
    else process.env.BANK_STATEMENT_API_URL = originalUrl;
  });

  describe('providers', () => {
    it('discovers providers without caching', async () => {
      const result = await bank.bankStatementProviders();
      expect(result.statusCode).toBe(200);
      expect(result.header['cache-control']).toBe('no-store');
      expect(result.body.response).toEqual({ configured: true, providers: [provider] });
      await bank.bankStatementProviders();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it('returns an empty disabled catalog when unconfigured', async () => {
      delete process.env.BANK_STATEMENT_API_URL;
      expect(await bank.bankStatementProviders({ raw: true })).toEqual({ configured: false, providers: [] });
      expect(fetchMock).not.toHaveBeenCalled();
    });
    it('accepts an empty catalog', async () => {
      fetchMock.mockResolvedValue(response({ data: [] }));
      expect(await bank.bankStatementProviders({ raw: true })).toEqual({ configured: true, providers: [] });
    });
    it('does not expose upstream diagnostics', async () => {
      fetchMock.mockResolvedValue(response({ data: { detail: 'SECRET DOCUMENT DIAGNOSTICS' }, status: 500 }));
      const result = await bank.bankStatementProviders();
      expect(result.statusCode).toBe(502);
      expect(JSON.stringify(result.body)).not.toContain('SECRET');
      expect(result.header['cache-control']).toBe('no-store');
    });
    it('rejects non-loopback HTTP admin configuration', async () => {
      process.env.BANK_STATEMENT_API_URL = 'http://remote.example';
      expect((await bank.bankStatementProviders()).statusCode).toBe(503);
      expect(fetchMock).not.toHaveBeenCalled();
    });
    it('rejects invalid catalogs and network errors safely', async () => {
      fetchMock.mockResolvedValueOnce(response({ data: [{ id: 'bad' }] }));
      expect((await bank.bankStatementProviders()).statusCode).toBe(502);
      fetchMock.mockRejectedValueOnce(new Error('SECRET network diagnostics'));
      const result = await bank.bankStatementProviders();
      expect(result.statusCode).toBe(502);
      expect(JSON.stringify(result.body)).not.toContain('SECRET');
    });
  });

  it('requires a session on every endpoint', async () => {
    await helpers.withoutSession(async () => {
      expect((await bank.bankStatementProviders()).statusCode).toBe(401);
      expect((await bank.parseBankStatement({ payload: parsePayload({ accountId: NONEXISTENT_ID }) })).statusCode).toBe(
        401,
      );
      expect((await bank.reviewBankStatements({ payload: { files: [], timezone: 'UTC' } })).statusCode).toBe(401);
      expect(
        (
          await bank.executeBankStatements({
            payload: { files: [], timezone: 'UTC', requestId: randomUUID(), skipRows: [], bankSeamRows: [] },
          })
        ).statusCode,
      ).toBe(401);
      expect((await bank.bankStatementStatus({ jobId: 'missing' })).statusCode).toBe(401);
    });
  });

  it('blocks derived-balance accounts at parse, review and execute', async () => {
    const vehicle = await helpers.createVehicle({
      name: 'Car',
      currencyCode: global.BASE_CURRENCY.code,
      make: 'Test',
      model: 'Test',
      year: 2020,
      vehicleClass: VEHICLE_CLASS.sedan,
      purchasePrice: 10000,
      purchaseDate: '2024-01-01',
      raw: true,
    });
    const files = [file({ accountId: vehicle.accountId })];
    expect(
      (await bank.parseBankStatement({ payload: parsePayload({ accountId: vehicle.accountId }) })).statusCode,
    ).toBe(422);
    expect((await bank.reviewBankStatements({ payload: { files, timezone: 'UTC' } })).statusCode).toBe(422);
    expect(
      (
        await bank.executeBankStatements({
          payload: { files, timezone: 'UTC', requestId: randomUUID(), skipRows: [], bankSeamRows: [] },
        })
      ).statusCode,
    ).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks fully bank-owned accounts without a historical seam', async () => {
    const { connectionId } = await helpers.lunchflow.pair();
    const { syncedAccounts } = await helpers.bankDataProviders.connectSelectedAccounts({
      connectionId,
      accountExternalIds: ['1001'],
      raw: true,
    });
    const accountId = syncedAccounts[0]!.id;
    const files = [file({ accountId })];
    expect((await bank.parseBankStatement({ payload: parsePayload({ accountId }) })).statusCode).toBe(422);
    expect((await bank.reviewBankStatements({ payload: { files, timezone: 'UTC' } })).statusCode).toBe(422);
    expect(
      (
        await bank.executeBankStatements({
          payload: { files, timezone: 'UTC', requestId: randomUUID(), skipRows: [], bankSeamRows: [] },
        })
      ).statusCode,
    ).toBe(422);
  });

  describe('parse', () => {
    it('sends multipart with discovered importer and returns signed decimals', async () => {
      const account = await helpers.createAccount({ raw: true });
      const result = await bank.parseBankStatement({ payload: parsePayload({ accountId: account.id }) });
      expect(result.statusCode).toBe(200);
      expect(result.body.response.transactions).toEqual([row()]);
      expect(result.header['cache-control']).toBe('no-store');
      const init = fetchMock.mock.calls[1]![1]!;
      expect(init.cache).toBe('no-store');
      expect(init.signal).toBeDefined();
      expect((init.body as FormData).get('importerId')).toBe(provider.id);
      expect((init.body as FormData).get('file')).toBeDefined();
    });
    it.each([400, 413, 415, 429, 500])('maps external HTTP %s without document diagnostics', async (status) => {
      const account = await helpers.createAccount({ raw: true });
      fetchMock
        .mockResolvedValueOnce(response({ data: [provider] }))
        .mockResolvedValueOnce(
          response({ data: { title: 'SECRET document details', detail: 'SECRET diagnostics' }, status }),
        );
      const result = await bank.parseBankStatement({ payload: parsePayload({ accountId: account.id }) });
      expect(result.statusCode).toBe(status === 500 ? 502 : status);
      expect(result.header['cache-control']).toBe('no-store');
      expect(JSON.stringify(result.body)).not.toContain('SECRET');
    });
    it('returns successful empty statements', async () => {
      const account = await helpers.createAccount({ raw: true });
      fetchMock.mockResolvedValueOnce(response({ data: [provider] })).mockResolvedValueOnce(response({ data: [] }));
      expect(await bank.parseBankStatement({ payload: parsePayload({ accountId: account.id }), raw: true })).toEqual({
        transactions: [],
      });
    });
    it('accepts CSV when discovered and rejects formats absent from discovery', async () => {
      const account = await helpers.createAccount({ raw: true });
      const payload = parsePayload({ accountId: account.id, fileName: 'statement.CsV' });
      expect((await bank.parseBankStatement({ payload })).statusCode).toBe(422);
      fetchMock.mockImplementation(async (url) =>
        response({
          data: String(url).endsWith('/api/importers') ? [{ ...provider, supportedFormats: ['csv'] }] : [row()],
        }),
      );
      expect((await bank.parseBankStatement({ payload })).statusCode).toBe(200);
    });
    it.each([
      { currency: 'USD' },
      { amount: 1.234 },
      { amount: 0 },
      { amount: 1_000_000_001 },
      { date: '2024-02-30' },
      { currency: 'ZZZ' },
    ])('rejects invalid upstream transactions %j', async (override) => {
      const account = await helpers.createAccount({ raw: true });
      const bad =
        override.currency === 'USD' ? { currency: global.BASE_CURRENCY.code === 'USD' ? 'EUR' : 'USD' } : override;
      fetchMock
        .mockResolvedValueOnce(response({ data: [provider] }))
        .mockResolvedValueOnce(response({ data: [row(), row(bad)] }));
      const result = await bank.parseBankStatement({ payload: parsePayload({ accountId: account.id }) });
      expect([422, 502]).toContain(result.statusCode);
      expect(result.body.response).not.toHaveProperty('transactions');
    });
    it('rejects malformed base64, paths, unknown providers and oversized files', async () => {
      const account = await helpers.createAccount({ raw: true });
      const payload = parsePayload({ accountId: account.id });
      for (const override of [
        { fileBase64: '!!!!' },
        { fileBase64: 'YR==' },
        { fileName: '../statement.pdf' },
        { importerId: 'missing' },
        { fileBase64: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') },
      ]) {
        expect((await bank.parseBankStatement({ payload: { ...payload, ...override } })).statusCode).toBe(422);
      }
    });
    it('rejects missing or foreign accounts before external I/O', async () => {
      expect((await bank.parseBankStatement({ payload: parsePayload({ accountId: NONEXISTENT_ID }) })).statusCode).toBe(
        422,
      );
      const account = await helpers.createAccount({ raw: true });
      const other = await helpers.signUpSecondUser();
      await helpers.asUser({
        cookies: other.cookies,
        fn: async () => {
          expect((await bank.parseBankStatement({ payload: parsePayload({ accountId: account.id }) })).statusCode).toBe(
            422,
          );
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
    it('returns safe upstream busy and unconfigured errors', async () => {
      const account = await helpers.createAccount({ raw: true });
      fetchMock
        .mockResolvedValueOnce(response({ data: [provider] }))
        .mockResolvedValueOnce(response({ data: { detail: 'SECRET' }, status: 429 }));
      const result = await bank.parseBankStatement({ payload: parsePayload({ accountId: account.id }) });
      expect(result.statusCode).toBe(429);
      expect(JSON.stringify(result.body)).not.toContain('SECRET');
      delete process.env.BANK_STATEMENT_API_URL;
      expect((await bank.parseBankStatement({ payload: parsePayload({ accountId: account.id }) })).statusCode).toBe(
        503,
      );
    });
  });

  describe('review', () => {
    it('finds DB and cross-file duplicates with stable references', async () => {
      const account = await helpers.createAccount({ raw: true });
      await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: account.id,
          amount: 12.34,
          time: '2024-01-15T12:00:00Z',
        }),
        raw: true,
      });
      const files = [file({ accountId: account.id }), file({ accountId: account.id, fileId: 'file-b' })];
      const result = await bank.reviewBankStatements({ payload: { files, timezone: 'UTC' }, raw: true });
      expect(result.totalCount).toBe(2);
      expect(result.duplicates.filter((d) => d.match.kind === 'existing')).toHaveLength(2);
      expect(result.duplicates).toContainEqual({
        fileId: 'file-b',
        transactionIndex: 0,
        match: { kind: 'batch', fileId: 'file-a', transactionIndex: 0 },
      });
      expect(result.bankSeamRows).toEqual([]);
    });
    it('matches dates after timezone anchoring, not raw source dates', async () => {
      const account = await helpers.createAccount({ raw: true });
      await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: account.id,
          amount: 12.34,
          time: '2024-01-14T22:00:00Z',
        }),
        raw: true,
      });
      const result = await bank.reviewBankStatements({
        payload: { files: [file({ accountId: account.id })], timezone: 'Pacific/Kiritimati' },
        raw: true,
      });
      expect(result.duplicates).toHaveLength(1);
    });
    it('does not flag repeats inside the same file or different accounts/directions/descriptions', async () => {
      const a = await helpers.createAccount({ raw: true });
      const b = await helpers.createAccount({ raw: true });
      const files = [
        file({ accountId: a.id, transactions: [row(), row()] }),
        file({ accountId: b.id, fileId: 'other' }),
        file({ accountId: a.id, fileId: 'income', transactions: [row({ amount: 12.34 })] }),
        file({ accountId: a.id, fileId: 'different', transactions: [row({ description: 'Different merchant' })] }),
      ];
      expect((await bank.reviewBankStatements({ payload: { files, timezone: 'UTC' }, raw: true })).duplicates).toEqual(
        [],
      );
    });
    it('returns an empty review for an empty parsed file', async () => {
      const account = await helpers.createAccount({ raw: true });
      expect(
        await bank.reviewBankStatements({
          payload: { files: [file({ accountId: account.id, transactions: [] })], timezone: 'UTC' },
          raw: true,
        }),
      ).toEqual({ totalCount: 0, duplicates: [], bankSeamRows: [] });
    });
    it('rejects duplicate file IDs, bad timezones, excessive files and mismatching currencies', async () => {
      const account = await helpers.createAccount({ raw: true });
      const f = file({ accountId: account.id });
      for (const payload of [
        { files: [f, f], timezone: 'UTC' },
        { files: [f], timezone: 'Not/AZone' },
        { files: Array.from({ length: 21 }, (_, i) => ({ ...f, fileId: String(i) })), timezone: 'UTC' },
        { files: [{ ...f, transactions: [row({ currency: 'ZZZ' })] }], timezone: 'UTC' },
      ]) {
        expect((await bank.reviewBankStatements({ payload })).statusCode).toBe(422);
      }
    });
    it('reports bank-owned rows and rejects a changed reviewed seam', async () => {
      const account = await helpers.createSeamAccount({ currencyCode: global.BASE_CURRENCY.code });
      const seam = await helpers.seamDayOf({ accountId: account.id });
      const files = [file({ accountId: account.id, transactions: [row(), row({ date: seam })] })];
      const reviewed = await bank.reviewBankStatements({ payload: { files, timezone: 'UTC' }, raw: true });
      expect(reviewed.bankSeamRows).toEqual([{ fileId: 'file-a', transactionIndex: 1 }]);
      expect(
        (
          await bank.executeBankStatements({
            payload: { files, timezone: 'UTC', requestId: randomUUID(), skipRows: [], bankSeamRows: [] },
          })
        ).statusCode,
      ).toBe(422);
      const { jobId } = await bank.executeBankStatements({
        payload: { files, timezone: 'UTC', requestId: randomUUID(), skipRows: [], bankSeamRows: reviewed.bankSeamRows },
        raw: true,
      });
      const done = await bank.waitForBankStatementImport({ jobId });
      expect(done.status).toBe('completed');
      if (done.status === 'completed') {
        expect(done.summary.imported).toBe(1);
        expect(done.summary.skippedAfterBankSeam).toBe(1);
      }
    });
  });

  describe('execute and status', () => {
    it('imports sequential files, preserves source, skips chosen rows and is retry-idempotent', async () => {
      const account = await helpers.createAccount({ raw: true });
      const files = [
        file({ accountId: account.id }),
        file({ accountId: account.id, fileId: 'file-b', transactions: [row(), row({ amount: 20 })] }),
      ];
      const payload = {
        files,
        timezone: 'UTC',
        requestId: randomUUID(),
        skipRows: [{ fileId: 'file-b', transactionIndex: 0 }],
        bankSeamRows: [],
      };
      const { jobId } = await bank.executeBankStatements({ payload, raw: true });
      expect(await bank.executeBankStatements({ payload, raw: true })).toEqual({ jobId });
      const done = await bank.waitForBankStatementImport({ jobId });
      expect(done.status).toBe('completed');
      if (done.status === 'completed') {
        expect(done.summary).toMatchObject({ imported: 2, skipped: 1, failed: 0 });
        expect(done.summary.files).toHaveLength(2);
        const history = await helpers.getBatchesHistory({ raw: true });
        expect(history.totalCount).toBe(2);
        expect(history.items).toHaveLength(2);
        for (const importedFile of done.summary.files) {
          const summary = importedFile.summary!;
          const batch = history.items.find(({ batchId }) => batchId === summary.batchId);
          expect(batch).toMatchObject({
            source: ImportSource.bankStatement,
            transactionCount: 1,
            accountIds: [account.id],
          });
          const batchTransactions = await helpers.getTransactions({ batchId: summary.batchId, raw: true });
          expect(batchTransactions.map(({ id }) => id).toSorted()).toEqual(summary.newTransactionIds.toSorted());
          expect(batchTransactions).toHaveLength(1);
        }
        const transactions = await helpers.getTransactions({ raw: true });
        expect(transactions).toHaveLength(2);
        expect(transactions.map(({ id }) => id).toSorted()).toEqual(
          done.summary.files.flatMap(({ summary }) => summary!.newTransactionIds).toSorted(),
        );
      }
      expect(await bank.executeBankStatements({ payload, raw: true })).toEqual({ jobId });
      expect((await bank.executeBankStatements({ payload: { ...payload, files: [files[0]!] } })).statusCode).toBe(409);
      const status = await bank.bankStatementStatus({ jobId });
      expect(status.header['cache-control']).toBe('no-store');
      const other = await helpers.signUpSecondUser();
      await helpers.asUser({
        cookies: other.cookies,
        fn: async () => {
          expect((await bank.bankStatementStatus({ jobId })).statusCode).toBe(404);
        },
      });
    });
    it('completes an empty file without writes', async () => {
      const account = await helpers.createAccount({ raw: true });
      const { jobId } = await bank.executeBankStatements({
        payload: {
          files: [file({ accountId: account.id, transactions: [] })],
          timezone: 'UTC',
          requestId: randomUUID(),
          skipRows: [],
          bankSeamRows: [],
        },
        raw: true,
      });
      const done = await bank.waitForBankStatementImport({ jobId });
      expect(done.status).toBe('completed');
      if (done.status === 'completed') expect(done.summary.imported).toBe(0);
    });
    it('rejects out-of-range skip rows and invalid target IDs', async () => {
      const account = await helpers.createAccount({ raw: true });
      const payload = {
        files: [file({ accountId: account.id })],
        timezone: 'UTC',
        requestId: randomUUID(),
        skipRows: [{ fileId: 'file-a', transactionIndex: 1 }],
        bankSeamRows: [],
      };
      expect((await bank.executeBankStatements({ payload })).statusCode).toBe(422);
      expect(
        (
          await bank.executeBankStatements({
            payload: { ...payload, skipRows: [], files: [file({ accountId: NONEXISTENT_ID })] },
          })
        ).statusCode,
      ).toBe(422);
    });
    it('blocks currency mismatches for the whole submitted batch', async () => {
      const account = await helpers.createAccount({ raw: true });
      const currency = global.BASE_CURRENCY.code === 'USD' ? 'EUR' : 'USD';
      const files = [file({ accountId: account.id, transactions: [row(), row({ currency })] })];
      expect((await bank.reviewBankStatements({ payload: { files, timezone: 'UTC' } })).statusCode).toBe(422);
      expect(
        (
          await bank.executeBankStatements({
            payload: { files, timezone: 'UTC', requestId: randomUUID(), skipRows: [], bankSeamRows: [] },
          })
        ).statusCode,
      ).toBe(422);
      expect(await helpers.getTransactions({ raw: true })).toHaveLength(0);
    });
    it('rejects more than 50,000 aggregate rows before enqueue', async () => {
      const account = await helpers.createAccount({ raw: true });
      const files = [
        file({ accountId: account.id, transactions: Array.from({ length: 25001 }, () => row()) }),
        file({ accountId: account.id, fileId: 'second', transactions: Array.from({ length: 25000 }, () => row()) }),
      ];
      expect((await bank.reviewBankStatements({ payload: { files, timezone: 'UTC' } })).statusCode).toBe(422);
      expect(
        (
          await bank.executeBankStatements({
            payload: { files, timezone: 'UTC', requestId: randomUUID(), skipRows: [], bankSeamRows: [] },
          })
        ).statusCode,
      ).toBe(422);
    });
    it('returns 404 for missing jobs', async () => {
      expect((await bank.bankStatementStatus({ jobId: 'missing' })).statusCode).toBe(404);
    });
  });
});
