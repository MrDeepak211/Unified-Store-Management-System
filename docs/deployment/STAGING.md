# USMS Staging Deployment Plan

**Target branch:** `staging`  
**Baseline:** `main` at `f04f93e56f1ab4447cbbecd6fa5817867e52471e` when staging branch was created.  
**Purpose:** validate the existing MVP in an isolated environment without rebuilding existing features or touching production.

## 1. Non-negotiable environment separation

Create a separate staging PostgreSQL database and a separate staging Supabase Auth project. Use synthetic test shops, users, products and orders only. Do not copy production personal or payment data.

Use separate database roles:
- Migration role: schema migration only.
- Runtime role: least privilege, not superuser, not table owner and without `BYPASSRLS`.

Use Razorpay test credentials only. Never commit secrets or put server-only credentials in Vite variables.

## 2. Existing deployment artefacts

- API container: root `Dockerfile.api`, listens on port 4000.
- Reservation worker: root `Dockerfile.worker`, separate always-on process.
- Business App: Vercel root directory `apps/pos`; existing `apps/pos/vercel.json`.
- Storefront: Vercel root directory `apps/storefront`; existing `apps/storefront/vercel.json`.
- Local database/cache: `docker-compose.yml` (not for production).

## 3. API staging environment variables

Configure these in the API host's secret manager. Values must come from the staging providers, never from production.

```env
NODE_ENV=production
API_HOST=0.0.0.0
API_PORT=4000
LOG_LEVEL=info
DATABASE_URL=<STAGING_RUNTIME_DATABASE_URL>
MIGRATION_DATABASE_URL=<STAGING_MIGRATION_DATABASE_URL>
WEB_ORIGIN=<EXACT_STAGING_BUSINESS_APP_ORIGIN>
SUPABASE_URL=<STAGING_SUPABASE_URL>
SUPABASE_JWKS_URL=<STAGING_SUPABASE_JWKS_URL>
SUPABASE_JWT_ISSUER=<STAGING_SUPABASE_JWT_ISSUER>
SUPABASE_JWT_AUDIENCE=authenticated
ORDER_TRACKING_SECRET=<PRIVATE_RANDOM_SECRET_AT_LEAST_32_CHARACTERS>
PAYMENT_ENCRYPTION_KEY=<PRIVATE_RANDOM_32_BYTE_KEY_AS_64_HEX_CHARACTERS>
```

Only add `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_INVITE_REDIRECT_URL` if the staging test specifically covers staff invitations. Keep them server-side.

Health check: `GET /health` should return HTTP 200 and `{"status":"ok","service":"usms-api"}`.

## 4. Business App environment

Vercel project root: `apps/pos`.

```env
VITE_API_URL=<STAGING_API_ORIGIN>
VITE_SUPABASE_URL=<STAGING_SUPABASE_URL>
VITE_SUPABASE_ANON_KEY=<STAGING_SUPABASE_ANON_KEY>
```

## 5. Storefront environment

Vercel project root: `apps/storefront`.

```env
VITE_API_URL=<STAGING_API_ORIGIN>
```

Configure a staging test-store hostname only after the domain/DNS is available and assigned to the staging deployment. The API CORS configuration currently permits tenant subdomains matching `https://<slug>.usms.in`; verify the actual staging hostname and routing before testing.

## 6. Deployment order

1. Confirm local changes are safe and staging branch is current.
2. Provision staging PostgreSQL and Supabase Auth.
3. Configure database roles and staging secrets.
4. Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm build`.
5. Run `pnpm db:migrate` with staging migration credentials only.
6. Run `pnpm --filter @usms/database smoke` against staging.
7. Deploy API using `Dockerfile.api`; verify `/health`.
8. Deploy worker using `Dockerfile.worker`; verify it stays running.
9. Deploy Business App and Storefront from the `staging` branch.
10. Configure staging origins/domains and test tenant resolution.
11. Execute the acceptance checklist below.

## 7. Acceptance checklist

- [ ] API health endpoint returns HTTP 200.
- [ ] Business App loads and authenticates using staging Supabase.
- [ ] Storefront resolves the correct staging shop.
- [ ] Two separate tenants cannot read or mutate one another's data.
- [ ] Branch-scoped staff permissions are enforced.
- [ ] POS sale atomically decrements stock.
- [ ] Online order reserves stock; payment capture converts reservation to sale.
- [ ] Failed, cancelled and expired unpaid orders release reservations.
- [ ] Duplicate payment callbacks/webhooks are safely deduplicated.
- [ ] Razorpay test-mode refund path is verified.
- [ ] POS offline queue reconciles and surfaces server-side conflicts.
- [ ] Worker processes reservation expiry continuously.
- [ ] Invoice/tax output is reviewed; do not represent preview as GST-certified.
- [ ] Backup restoration and API/worker restart recovery are tested.
- [ ] Staging uses only synthetic data and test payment credentials.

## 8. Production release blockers

Do not onboard paying shops or enable live Razorpay until the security review, tax review, end-to-end payment/refund verification, tenant-isolation checks, backup restore drill and operational monitoring are complete.
