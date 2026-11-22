# USMS technical audit — first pass

**Date:** 2026-11-22  
**Branch reviewed:** `staging`  
**Scope:** CI and staging workflows, package manifests, database smoke checks, API authentication, online checkout and Razorpay payment/webhook paths.

This is a targeted source review, not an independent security certification. No staging database was connected and no live or test payment was initiated during this review.

## Release decision

**Do not enable live payments or onboard real customer data yet.** Resolve the payment lifecycle findings below, run the complete CI suite against a real disposable staging database, and verify the fixes with automated tests first.

## Findings

### High — payment-order creation can race

The storefront payment-start route checks for an existing Razorpay order, commits the database transaction, and only then calls Razorpay to create a new provider order. Two concurrent requests can both pass the check and create separate Razorpay orders. The later database upsert can replace the first provider order ID, leaving a previously returned order unlinked to the USMS payment row. A payment against that orphaned order may not be reconciled by the webhook lookup.

**Required fix:** serialize payment-order creation per USMS order (for example, hold an order-row lock while creating and persisting the provider order, with bounded network timeouts), and add a concurrency test proving only one provider order is accepted and stored.

### High — partial refund events are treated like full refunds

The `refund.processed` webhook path does not compare the refund amount with the captured payment amount. For an order in `confirmed` status, it can restock every order item and mark the entire order as refunded even if the provider reports a partial refund.

**Required fix:** explicitly model full versus partial refunds. Until partial refunds and return quantities are implemented and tested, reject or safely quarantine unsupported partial-refund state transitions; never restock goods solely because money was refunded. Restocking must correspond to an actual physical return or a clearly defined unfulfilled-order cancellation policy.

### Medium — dependency installation is not reproducible yet

The `staging` branch has no `pnpm-lock.yaml`. The staging migration workflow previously required a frozen lockfile and referenced pnpm caching, which could fail before migrations. The workflow has been adjusted to install without a lockfile as a temporary unblocker.

**Required fix:** generate and commit the pnpm lockfile, then restore frozen installs and lockfile-based caching in CI and staging before production use.

### Staging gate — external setup is still required

The repository contains a staging runbook and a manually dispatched migration workflow restricted to the `staging` branch. The workflow still requires the owner to create a disposable staging database and add `STAGING_MIGRATION_DATABASE_URL` to the GitHub `staging` environment. Keep the API runtime database credential separate and least-privileged.

No staging migration or end-to-end staging verification is claimed as complete by this audit.

## Next engineering sequence

1. Fix and test payment-order creation concurrency.
2. Fix and test full/partial refund state handling and inventory restocking.
3. Add the missing lockfile and restore deterministic installs.
4. Run migrations, database RLS/stock smoke tests, API tests, authenticated tenant/role integration tests, typecheck and build in CI.
5. Run Razorpay test-mode scenarios in staging: success, failure, duplicate webhook, late capture, full refund, partial refund, and retry/reconciliation.
6. Only then begin the own-shop pilot with test data and no live payments.

## Safety constraints

- No production deployment, paid infrastructure, or live payment credentials are authorized by this audit.
- Do not use real customer or financial data in staging.
- Keep migration credentials separate from the API runtime role.
- Preserve the existing requirement that the runtime database role is not an owner or superuser and does not have `BYPASSRLS`.
