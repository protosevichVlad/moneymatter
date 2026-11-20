import {
  executeController,
  parseController,
  providersController,
  reviewController,
  statusController,
} from '@controllers/import-export/bank-statements/bank-statements.controller';
import { authenticateSession } from '@middlewares/better-auth';
import { checkBaseCurrencyLock } from '@middlewares/check-base-currency-lock';
import { csvImportRateLimit } from '@middlewares/rate-limit';
import { Router } from 'express';

const router = Router();
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
router.use(authenticateSession);
router.get('/providers', providersController);
router.post('/parse', checkBaseCurrencyLock, csvImportRateLimit, parseController);
router.post('/review', checkBaseCurrencyLock, csvImportRateLimit, reviewController);
router.post('/execute', checkBaseCurrencyLock, csvImportRateLimit, executeController);
router.get('/execute/status/:jobId', statusController);
export default router;
