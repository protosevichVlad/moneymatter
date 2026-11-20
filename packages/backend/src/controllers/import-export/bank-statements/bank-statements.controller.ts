import { BANK_STATEMENT_MAX_FILE_BYTES } from '@bt/shared/types';
import { recordId } from '@common/lib/zod/custom-types';
import { createController } from '@controllers/helpers/controller-factory';
import { t } from '@i18n/index';
import { NotFoundError } from '@js/errors';
import {
  getBankStatementImportProgress,
  queueBankStatementImport,
} from '@services/import-export/bank-statements/import-queue';
import { getProviders, parseStatement } from '@services/import-export/bank-statements/provider.service';
import { reviewStatements } from '@services/import-export/bank-statements/review.service';
import {
  executeSchema,
  filenameSchema,
  importerIdSchema,
  reviewSchema,
} from '@services/import-export/bank-statements/validation';
import { z } from 'zod';

export const providersController = createController(z.object({}), async () => ({ data: await getProviders() }));
export const parseController = createController(
  z.object({
    body: z
      .object({
        accountId: recordId(),
        importerId: importerIdSchema,
        fileName: filenameSchema,
        fileBase64: z
          .string()
          .min(1)
          .max(4 * Math.ceil(BANK_STATEMENT_MAX_FILE_BYTES / 3)),
      })
      .strict(),
  }),
  async ({ user, body }) => ({ data: await parseStatement({ userId: user.id, ...body }) }),
);
export const reviewController = createController(z.object({ body: reviewSchema }), async ({ user, body }) => ({
  data: await reviewStatements({ userId: user.id, ...body }),
}));
export const executeController = createController(z.object({ body: executeSchema }), async ({ user, body }) => ({
  data: await queueBankStatementImport({ userId: user.id, input: body }),
}));
export const statusController = createController(
  z.object({ params: z.object({ jobId: z.string().min(1).max(200) }) }),
  async ({ user, params }) => {
    const progress = await getBankStatementImportProgress({ userId: user.id, jobId: params.jobId });
    if (!progress) throw new NotFoundError({ message: t({ key: 'importExport.bankStatements.jobNotFound' }) });
    return { data: progress };
  },
);
