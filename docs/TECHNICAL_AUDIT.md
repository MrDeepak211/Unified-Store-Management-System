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
