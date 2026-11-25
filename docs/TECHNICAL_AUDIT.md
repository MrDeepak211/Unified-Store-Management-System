# USMS technical audit — first pass and remediation

**Date:** 2026-11-22  
**Branch reviewed:** `staging`  
**Scope:** CI and staging workflows, package manifests, database smoke checks, API authentication, online checkout and Razorpay payment/webhook paths.

This is a targeted source review, not an independent security certification.

## Remediated in staging

### Checkout payment-order concurrency

The payment-start route now locks the pending USMS order row before checking or creating the Razorpay order, and keeps that lock until the provider order is persisted. Concurrent retries for the same order therefore serialize and reuse the stored provider order. The provider request has a 10-second timeout and uses a stable USMS receipt reference.

### Partial and duplicate refund safety

The webhook now compares the refund amount in paise with the captured payment amount. Partial or invalid/missing refund amounts are logged for manual reconciliation and do not trigger full-order restocking or a full-refund state transition. Automatic stock restock is limited to confirmed, unfulfilled orders. The payment row is re-locked and its status rechecked before stock is changed, preventing a second distinct refund webhook from restocking the same order again.

Unit tests cover exact full refunds, partial refunds, invalid amounts, and order status restock eligibility.

## Automated verification

The pull request was validated by GitHub Actions before merge to `staging`. All workflow steps passed:

- Dependency installation
- Database migrations against disposable CI PostgreSQL
- Tenant-isolation and stock-invariant smoke tests
- API authorization tests
- Fastify API route tests
- Authenticated tenant and role integration tests
- Payment refund-policy tests
- Typecheck
- Full monorepo build

Merged change: [PR #1 — checkout concurrency and refund inventory safety](https://github.com/MrDeepak211/Unified-Store-Management-System/pull/1).


### Request-bound idempotency across business mutations

POS sales and public storefront checkout now persist a canonical SHA-256 fingerprint of the normalized request alongside the idempotency key. An identical retry returns the original order; reuse of the same key with a different cart, branch, customer or checkout details returns HTTP 409 `IDEMPOTENCY_KEY_REUSED` rather than silently returning a prior order.

The same protection now covers purchase receipts, expenses, sales returns and inventory transfers. Legacy rows created before fingerprint migrations have a NULL fingerprint and are conservatively rejected as replays because their original request cannot be reconstructed safely. New schema changes are in migrations `0016_sales_order_request_fingerprint.sql` and `0017_business_mutation_request_fingerprints.sql`.

Both implementation PRs passed the full GitHub Actions CI suite, including PostgreSQL migrations and smoke tests, API authorization and integration tests, idempotency unit tests, typecheck and build:
- [PR #4 — POS and storefront request-bound idempotency](https://github.com/MrDeepak211/Unified-Store-Management-System/pull/4)
- [PR #5 — purchase, expense, return and transfer request-bound idempotency](https://github.com/MrDeepak211/Unified-Store-Management-System/pull/5)


### Offline POS queue tenant isolation

Offline sale events now persist their originating tenant ID in IndexedDB. The synchronizer submits an event only when its stored tenant matches the currently active tenant; events for other shops remain queued. Older queue entries without a tenant binding are quarantined for manual reconciliation instead of being assigned to whichever shop happens to be active after reconnecting. Authentication expiry, rate limiting, network failures and server errors remain retryable; permanent business/authorization failures retain an error reason for review.

The POS IndexedDB schema version was advanced to 2 and unit tests cover active-tenant matching, cross-tenant exclusion, failed-event exclusion and legacy unscoped events. The POS package owns this test and its Node test typings so frontend production bundles do not include test-only imports. See [PR #6 — offline queue tenant isolation](https://github.com/MrDeepak211/Unified-Store-Management-System/pull/6).


### POS credit-sale settlement correctness

POS sales recorded with payment method `credit` are now created with `payment_status = 'pending'`, rather than incorrectly marked as paid. Cash, UPI, card and bank-transfer selections retain their prior paid status, representing payment confirmation at the counter. This prevents credit invoices from being counted as collected cash in cashbook reporting. The rule is isolated in a pure helper and covered by CI tests. [PR #7 — POS credit receivables](https://github.com/MrDeepak211/Unified-Store-Management-System/pull/7) passed all 18 CI steps, including migrations, stock invariants, API tests, payment/idempotency/offline queue tests, typecheck and build.

## Remaining release blockers

### Reproducible dependencies

The repository still has no committed `pnpm-lock.yaml`. CI and staging currently use `pnpm install --no-frozen-lockfile` as a temporary bootstrap. Generate and commit the lockfile, then restore frozen installs and lockfile caching before production use.

### Real staging environment

The staging migration workflow requires the owner to create a disposable staging database and add `STAGING_MIGRATION_DATABASE_URL` to the GitHub `staging` environment. The workflow has not been run against a hosted staging database. Keep the API runtime database credential separate and least-privileged.

### Payment reconciliation

Partial refunds are intentionally not automated. They require a proper refund/returns ledger and operator reconciliation. Razorpay test-mode integration still needs to be exercised with a configured staging merchant account, including success, failure, duplicate webhook, late capture, full refund, partial refund and retry/reconciliation scenarios.

### Production readiness

Still required before production:

- End-to-end testing with a configured staging API and storefront
- Independent tenant-isolation and security review
- Least-privilege runtime database role: not owner/superuser and no `BYPASSRLS`
- Backups and a restore drill
- Rate limits, monitoring, error reporting and incident ownership
- GST invoice treatment reviewed by a qualified Indian tax professional
- Full offline conflict-resolution UX and remaining launch features listed in the README

## Release decision

**Not production-ready yet.** The code-level checkout/refund fixes and CI validation are complete, but no hosted staging migration, deployment, Razorpay test transaction, or production verification is claimed. Do not use real customer or financial data until the remaining release gates are complete.


### Credit receivables and collection ledger

Credit POS invoices now remain pending until actual collections settle the balance. A tenant-scoped collection ledger records partial and final payments, with branch access checks, sale-row locking, request-bound idempotency, over-collection rejection, and integer-paise arithmetic. The receivables API exposes outstanding invoices and accepts collection entries; a sale is marked paid only when its outstanding balance reaches zero. Migration: `0018_pos_credit_collections.sql`. [PR #8 — POS credit collections](https://github.com/MrDeepak211/Unified-Store-Management-System/pull/8).

Daily cashbook cash-in now includes cash actually collected against credit POS sales, while unpaid credit invoices remain excluded. Collection amounts are associated with their original sale for branch filtering. [PR #9 — cashbook credit collections](https://github.com/MrDeepak211/Unified-Store-Management-System/pull/9).

Both changes passed the GitHub Actions validation workflow, including PostgreSQL migrations, tenant/stock invariants, API authorization and route tests, authenticated tenant/role checks, refund/idempotency/POS settlement/receivables arithmetic/offline queue tests, typecheck and build. PR #9's workflow completed all 19 named validation steps.

## Additional remaining work — receivables workflow

The receivables backend is implemented, but the cashier-facing receivables screen, customer collection history and printable collection receipt still need implementation and acceptance testing. Route-level integration tests for the new receivables endpoints should be expanded beyond the current pure arithmetic coverage. Payment-method reporting for UPI, card and bank-transfer collections should also be reviewed so cashbook categories reconcile correctly.

The work above is code and disposable-CI verified only. It does not establish hosted staging runtime verification or production readiness. Hosted database/provider integration remains intentionally deferred.


## Inventory count reconciliation and supplier payment ledger — 2026-11-24

### Physical inventory count and reconciliation

Branch-scoped stock-count sessions now snapshot system quantities without changing live stock. Authorized staff can record physical quantities; only owners/admins can approve. Approval locks the session and stock rows, rejects incomplete or stale snapshots, prevents counts below reserved stock, and writes audited adjustment movements. Approval is request-key idempotent. The POS count workflow displays expected, counted and variance quantities and requires explicit approval.

Integration coverage now exercises tenant/branch boundaries, role permissions, incomplete counts, stale-stock atomicity, reserved-stock preservation, approval replay and audit movement uniqueness. See [PR #17 — inventory reconciliation integration tests](https://github.com/MrDeepak211/Unified-Store-Management-System/pull/17).

### Supplier payments and statements

Supplier payments are recorded in a separate tenant-scoped ledger with branch, actor, payment method, reference, notes and request fingerprint. Partial payments reduce supplier outstanding balances; overpayments are rejected using integer-cent arithmetic. Replaying the same idempotency key returns the original payment, while reusing a key for different details conflicts. Supplier statements present purchase receipts as debits and payments as credits with a running balance. Supplier list totals respect the actor's branch scope.

Purchase receipt creation increases inventory and records supplier liability; it does not itself represent a cash payment. Only actual cash supplier payments are included in cashbook cash-out. UPI, card and bank-transfer supplier payments remain separately identified and are not misreported as cash. See [PR #18 — supplier payment ledger and statements](https://github.com/MrDeepak211/Unified-Store-Management-System/pull/18).

### Verification and remaining limitations

PR #17 and PR #18 passed the repository GitHub Actions validation workflow against disposable CI PostgreSQL, including migrations, API integration tests, typecheck and monorepo build. This is code-level CI verification only. No hosted staging database, production deployment, live customer data or payment provider transaction was used.

Supplier ledger scope currently records supplier-level aggregate payments rather than allocating each payment to a particular purchase receipt. Supplier credit notes, purchase returns, payment reversals/refunds, GST input-credit treatment and a full three-way supplier statement reconciliation remain future work. Do not treat this feature as an accounting or tax certification.


## Supplier purchase returns and credit notes — 2026-11-24

Purchase returns can now be posted against a specific received goods receipt. The API locks the source receipt and receipt item rows, calculates the remaining unreturned quantity, and rejects over-returns. It removes only unreserved branch stock and records a negative inventory movement for each returned product. The return and stock updates run in one tenant transaction with request-key idempotency.

Posted supplier credit notes appear as credits in the supplier statement and reduce outstanding supplier liability and future payment limits. They do not create cashbook cash-in or cash-out because a credit note is not itself a cash settlement. Branch-scoped supplier outstanding totals include purchases, posted credit notes and payments for the actor's accessible branches.

PostgreSQL-backed CI verified the new migration, purchase return integration, idempotent replay, over-return rejection, stock/reserved quantity preservation, supplier statement totals, TypeScript typecheck and monorepo build. See [PR #21](https://github.com/MrDeepak211/Unified-Store-Management-System/pull/21).

Remaining accounting scope: allocation of supplier payments and credit notes to individual receipts, supplier credit-note reversal/void workflow, supplier statement export/print, and tax-professional review. This is not accounting or tax certification. Hosted staging integration and production deployment remain deferred.

### Supplier receipt allocation visibility — 2026-11-25

Supplier accounting read APIs expose receipt-level allocation summaries and supplier-level unapplied balances. Receipt balances separate allocated payments from allocated credit notes and report remaining receipt amounts. Supplier statements retain the supplier-level liability calculation while also reporting allocated and unapplied payment/credit totals. Allocation values are assignment detail; they do not create additional payments or credit notes.

Integration assertions cover receipt allocation totals, receipt outstanding, and unallocated source amounts. CI verification is required before merge. No hosted staging or production activity is included.

### Supplier allocation history — 2026-11-25

Added a tenant- and branch-scoped allocation history read endpoint. Each record identifies the source type and source ID, source reference, payment method when applicable, receipt reference, allocation batch, amount, and timestamp. It is an audit/read surface only and does not mutate balances. Automated integration coverage checks that a supplier's payment and credit-note allocations are both returned.
