# USMS production readiness checklist

The repository is an active development scaffold. Do not process live customer, payment or tax data until every applicable item below is completed and independently verified.

## Identity and tenant isolation

- [ ] Configure Supabase Auth with asymmetric ES256/RS256 signing keys and publish the correct JWKS URL and issuer.
- [ ] Create separate migration-owner and runtime database roles. Runtime role must not own tenant tables and must not have BYPASSRLS.
- [ ] Enable and test RLS under the actual runtime role (not a PostgreSQL superuser).
- [ ] Add shop onboarding, membership invitations, password/session policies and account recovery.
- [ ] Add branch-level permissions and audit logging for staff actions.

## Inventory and sales

- [ ] Apply migrations in a disposable test database and verify clean repeat runs.
- [ ] Add transactional online reservation, payment confirmation and reservation expiry/release.
- [ ] Add purchase receipts, returns, adjustments and stock reconciliation.
- [ ] Test concurrent POS/online sales against the same stock and prove no overselling.
- [ ] Add idempotency tests for retries, duplicate webhooks and offline POS replay.

## Payments, tax and customer data

- [ ] Complete provider marketplace onboarding and verify each merchant's settlement account.
- [ ] Verify payment signatures server-side; never trust browser payment status.
- [ ] Review Indian GST invoice, credit note, HSN/SAC and tax rounding behavior with a qualified tax professional.
- [ ] Publish privacy policy, terms, refund/return policy and data retention rules.
- [ ] Protect personal data, secrets and payment-provider credentials.

## Operations

- [ ] Configure HTTPS, production secrets, allowed origins and rate limits.
- [ ] Configure automated encrypted backups and perform a restore drill.
- [ ] Add structured logs, metrics, alerting and error tracking.
- [ ] Load-test checkout, stock updates and tenant isolation.
- [ ] Complete security review and production acceptance testing.
