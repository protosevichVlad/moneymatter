import { parseImportDate } from '@bt/shared/import-export/date-engine';
import { BANK_STATEMENT_MAX_FILES, BANK_STATEMENT_MAX_TRANSACTIONS } from '@bt/shared/types';
import { recordId } from '@common/lib/zod/custom-types';
import { Money } from '@common/types/money';
import { t } from '@i18n/index';
import { ValidationError } from '@js/errors';
import * as Accounts from '@models/accounts.model';
import { assertNotDerivedBalanceAccount } from '@services/accounts/derived-balance-guard';
import { assertImportTargetNotBankLinked } from '@services/import-export/core/assert-import-target-not-bank-linked';
import { anchorImportDate } from '@services/import-export/core/parse/anchor-import-date';
import cc from 'currency-codes';
import { z } from 'zod';

export const fail = ({ reason }: { reason: string }): never => {
  throw new ValidationError({
    message: t({ key: 'importExport.bankStatements.invalidStatement' }),
    details: { reason },
  });
};
export const filenameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (name) =>
      name.includes('.') &&
      [...name].every((character) => {
        const code = character.charCodeAt(0);
        return code > 31 && code !== 127 && character !== '/' && character !== '\\';
      }),
  );
export const importerIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((id) => Buffer.byteLength(id) <= 128);
export const providerSchema = z.object({
  id: importerIdSchema,
  bankName: z.string().min(1).max(256),
  supportedFormats: z
    .array(z.string().regex(/^[a-zA-Z0-9]{1,16}$/))
    .min(1)
    .max(32),
});
export const transactionSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((date) => {
      const parsed = parseImportDate({ value: date, format: { fieldOrder: 'day-first' } });
      const latest = new Date();
      latest.setUTCDate(latest.getUTCDate() + 1);
      latest.setUTCHours(23, 59, 59, 999);
      return (
        !!parsed &&
        !Number.isNaN(Date.parse(date)) &&
        new Date(date).toISOString().slice(0, 10) === date &&
        new Date(date) <= latest
      );
    }),
  amount: z
    .number()
    .finite()
    .refine((amount) => {
      if (!amount || Math.abs(amount) > 1_000_000_000) return false;
      return Money.fromCents(Money.fromDecimal(amount).toCents()).toNumber() === amount;
    }),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .refine((code) => !!cc.code(code)),
  description: z.string().max(10_000),
  accountName: z.string().max(512),
});
export const timezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((timezone) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone }).resolvedOptions();
      return true;
    } catch {
      return false;
    }
  });
export const rowRefSchema = z.object({ fileId: z.string().min(1).max(128), transactionIndex: z.number().int().min(0) });
export const filesSchema = z
  .array(
    z.object({
      fileId: z.string().min(1).max(128),
      fileName: filenameSchema,
      importerId: importerIdSchema,
      accountId: recordId(),
      transactions: z.array(transactionSchema).max(BANK_STATEMENT_MAX_TRANSACTIONS),
    }),
  )
  .min(1)
  .max(BANK_STATEMENT_MAX_FILES)
  .refine(
    (files) =>
      new Set(files.map((file) => file.fileId)).size === files.length &&
      files.reduce((sum, file) => sum + file.transactions.length, 0) <= BANK_STATEMENT_MAX_TRANSACTIONS,
  );
export const reviewSchema = z.object({ files: filesSchema, timezone: timezoneSchema });
export const executeSchema = reviewSchema.extend({
  requestId: z.string().uuid(),
  skipRows: z.array(rowRefSchema).max(BANK_STATEMENT_MAX_TRANSACTIONS),
  bankSeamRows: z.array(rowRefSchema).max(BANK_STATEMENT_MAX_TRANSACTIONS),
});
export type ExecuteInput = z.infer<typeof executeSchema>;

export async function loadTarget({ userId, accountId }: { userId: number; accountId: string }) {
  const account = await Accounts.getAccountById({ userId, id: accountId });
  if (!account) return fail({ reason: 'account-not-found' });
  // Ownership, not shared read access, is required for an import target.
  if (account.userId !== userId) return fail({ reason: 'account-not-found' });
  assertNotDerivedBalanceAccount({ account, actionPhrase: 'be an import target' });
  assertImportTargetNotBankLinked({ account, allowSeam: true });
  return account;
}

export function anchoredDate({ date, timezone }: { date: string; timezone: string }): Date {
  const parsed = parseImportDate({ value: date, format: { fieldOrder: 'day-first' } });
  if (!parsed) return fail({ reason: 'invalid-date' });
  return anchorImportDate({ parsed, timezone });
}
