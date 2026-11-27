# USMS Project Status

Last updated: 2026-11-27
Branch reviewed: `staging`
Owner/founder: Deepak Tandale
Operating constraint: zero-budget/free-tier only; no paid service, production credentials, live payments, or real customer data without explicit approval.

## Product
Unified Store Management System (USMS): multi-tenant retail SaaS with one shared backend and stock ledger for a shop's POS/business app and its individual branded storefront. Initial pilot is Deepak's own shop. Offline POS is a core requirement.

## Current milestone
**Pre-staging release audit. Do not run the staging database release workflow until the audit/remediation gate is complete.**

## Confirmed repository state
- Repository: https://github.com/MrDeepak211/Unified-Store-Management-System
- Active branch: `staging`
- Latest observed CI run: #378, green, commit `494b451ead6d52c0d8d0d811810e781d7033b901` (2026-11-26).
- Staging release issue: #28 https://github.com/MrDeepak211/Unified-Store-Management-System/issues/28
- Dependency reproducibility blocker tracked in issue #29: https://github.com/MrDeepak211/Unified-Store-Management-System/issues/29
- GitHub staging environment secrets: **Deepak confirms these have already been configured.** Secret values are not accessible through the repository integration and must never be shared in chat.
- The staging release workflow is manual and restricted to `staging`; it applies migrations and runs DB smoke checks using the staging migration credential and CA certificate.
- No hosted staging migration/deployment or live payment test has been confirmed.

## First-pass audit findings (repository review)
- Monorepo contains API, POS, storefront, dashboard, super-admin shell, database package, and deployment workflows.
- 23 SQL migrations are present through `0023_supplier_payment_allocations.sql`.
- CI workflow includes migration against disposable PostgreSQL, RLS/tenant and stock smoke tests, API auth/route/integration tests, payment/refund/idempotency/receivable/offline queue tests, typecheck and build.
- Latest CI is green, but this is not full end-to-end or live staging verification.
- Tenant access code verifies Supabase JWT, membership, role/branch scope, and uses transaction-local tenant context. SQL migrations enable tenant RLS; runtime DB must not own tables or have BYPASSRLS.
- **Verified release issue:** `.github/workflows/ci.yml` and `.github/workflows/staging-database.yml` both use `pnpm install --no-frozen-lockfile`. Root `pnpm-lock.yaml` is absent on `staging`. CI generates/uploads a lockfile artifact, but dependency installs are not reproducible from a clean repository checkout. Issue #29 defines remediation and acceptance criteria.
- UI apps do not have a full browser end-to-end acceptance suite in the repo; production readiness checklist remains open.
- Repository explicitly lists remaining production work: independent security/tenant isolation review; staging E2E; Razorpay test-mode scenarios and refund reconciliation; GST invoice/credit-note review by qualified tax professional; offline conflict UX; backups/restore drill; monitoring/rate limits; and unfinished super-admin/product features.

## Verification limitation
This audit session could inspect repository files and CI records, but could not clone or execute the code locally because the execution environment could not resolve GitHub. Do not mark a local test run as completed. GitHub CI #378 is the last observed successful automated run.

## Next steps
1. Resolve issue #29: commit the workspace lockfile, use frozen installs, remove the generated artifact step, and verify clean CI.
2. Continue targeted security review of tenant authorization, database roles/RLS, and API route boundaries; record findings as issues.
3. Confirm a separate Supabase staging project and least-privilege runtime role (not the migration role).
4. Run the manual `USMS Staging Database Release` workflow only after audit gate; inspect logs.
5. Configure staging-only API/POS/storefront environments, then run acceptance checks with synthetic data.
6. Validate Razorpay test mode only; no live payments.
7. Keep production launch blocked until security, tax, payment, backup/restore, monitoring, and operational gates pass.

## Progress updates
Update this file after each verified milestone. Record status as **verified**, **user-confirmed**, or **pending** so plans are not confused with completed work.
