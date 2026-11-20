---
id: bank-statement-import
type: module-design
title: Bank statement import via external API
status: draft
tags:
  - import
  - bank-statements
---

# Bank statement import via external API

## Responsibility and boundary

This importer turns an external parser's normalized transactions into MoneyMatter transactions on existing, user-selected accounts. It is separate from CSV column mapping and AI statement extraction. PDF/CSV parsing and language recognition belong entirely to the external service; this module must not introduce local file parsers or substitute fabricated transactions when the service is unavailable.

The administrator configures the external service URL on the backend. Browser requests never choose that URL. HTTPS is required outside loopback development. The browser holds an unfinished review only for its current page session; neither source files nor restorable drafts are persisted by this importer. The existing job infrastructure holds transaction data when a user explicitly starts a background import.

## External contract

ImportHelper discovery (`GET /api/importers`) supplies opaque importer IDs, bank display names and supported file extensions. The client derives format choices from that catalog rather than hardcoding banks or PDF-only behavior. Supporting another source format belongs to the service: a new catalog extension is sent through the same upload API, not parsed in MoneyMatter.

Conversion (`POST /api/imports`) sends exactly one `file` and one `importerId` as multipart. It returns an array of `{ date, amount, currency, description, accountName }`. Amounts are signed decimal currency units, dates are ISO date-only, and an empty array is successful. The target account comes from the user's selection, never from the returned account name. HTTP statuses, not localized error titles, determine failure handling. Statements and conversion results are not HTTP-cached or included in diagnostic errors.

## Review and write invariants

Every transaction must have a valid date, a bounded nonzero amount and a currency matching the selected account. Account ownership, eligibility and currency are checked on the server; browser validation is advisory. Dates are anchored using the import timezone for both duplicate detection and execution. Money arithmetic uses the backend Money type.

File identity plus row index identifies a review decision. Bank IDs are not available in this external contract, so duplicate detection is heuristic, not bank-reference idempotency. Review considers existing transactions and overlapping files targeting the same account. Potential duplicates remain a user choice. Rows owned by a linked bank from its seam onward are excluded under the common ledger rules.

Files are converted sequentially to respect the service's bounded concurrency. A failed file can be retried or explicitly removed before successful files proceed. The limits are 10 MiB per source file, 20 files and 50,000 aggregate transactions. Conversion is not repeated when review is confirmed.

Execution reuses the statement import writer and common import-job infrastructure rather than writing directly to ledger tables. Import source identity distinguishes these batches from AI extraction. Completed files remain committed if another file fails; results must distinguish imported, merged, deliberately skipped, seam-skipped and failed rows. Source payloads are cleared when the job settles; completed summaries remain available through the common job retention policy.

A stable confirmation request ID scopes queue retry idempotency to the authenticated user; this is distinct from transaction duplicate detection. Content-hash reservations are retained in Redis independently of job retention. They fail closed after ambiguous enqueue failures, favoring prevention of duplicate financial writes over automatic retries. This protection depends on Redis persistence: clearing that store also clears these reservations. A reserved request with a missing job requires checking import history before starting a new confirmation.
