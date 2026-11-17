# USMS Staging Deployment Plan — Zero-Budget Mode

**Target branch:** `staging`  
**Purpose:** validate the existing MVP without creating paid infrastructure or touching production.

## Budget guardrails

- Do not create a paid Render service, background worker, database, add-on or subscription.
- Do not enable live Razorpay or use real customer/payment data.
- Use free tiers only, subject to provider quotas, sleep/pause behavior and policy changes.
- If a provider asks for a paid plan or payment method, stop before confirming.
- The Render Blueprint in the repository provisions only one **Free** web service. It deliberately does not create a background worker.

## Zero-budget architecture

| Component | Staging approach |
|---|---|
| Source control and CI | GitHub repository and Actions |
| PostgreSQL and Auth | Separate Supabase Free staging project, synthetic data only |
| Business App | Existing Vercel project, staging branch/preview deployment |
| Storefront | Existing Vercel project, staging branch/preview deployment |
| API | Optional Render Free web service from `render.yaml`; it may spin down when idle |
| Reservation expiry worker | Run locally during staging; a continuously running hosted worker is deferred |
| Payments | Razorpay test mode only |

A free hosted API can be slow to respond after idle periods and is suitable only for development/pilot validation, not a production availability promise. The worker must be running locally when validating reservation expiry. Do not claim continuous background processing while it is stopped.

## Environment separation and database roles

Create a new Supabase project named for staging; do not reuse production. Use synthetic shops, staff, products, customers and orders only.

Keep separate database credentials:
- Migration role: privileged connection used only by the manual GitHub migration/smoke workflow.
- Runtime role: least privilege, not superuser, not table owner and without `BYPASSRLS`.

Use the Supabase Connect panel to obtain the correct connection string. If the runtime host cannot reach the direct endpoint over IPv6, use the session-mode pooler connection string. Set `DATABASE_SSL=true`. Never hand-construct the pooler hostname or username.

## API environment

Set these values in the optional Render Free API service. Secrets are deliberately not committed:

```env
NODE_ENV=production
API_HOST=0.0.0.0
API_PORT=4000
PORT=4000
LOG_LEVEL=info
DATABASE_SSL=true
DB_POOL_MAX=5
DATABASE_URL=<STAGING_RUNTIME_DATABASE_URL>
WEB_ORIGIN=<STAGING_BUSINESS_APP_ORIGIN>,<STAGING_STOREFRONT_ORIGIN>
SUPABASE_URL=<STAGING_SUPABASE_URL>
SUPABASE_JWKS_URL=<STAGING_SUPABASE_JWKS_URL>
SUPABASE_JWT_ISSUER=<STAGING_SUPABASE_JWT_ISSUER>
SUPABASE_JWT_AUDIENCE=authenticated
ORDER_TRACKING_SECRET=<PRIVATE_RANDOM_SECRET_AT_LEAST_32_CHARACTERS>
PAYMENT_ENCRYPTION_KEY=<PRIVATE_RANDOM_32_BYTE_KEY_AS_64_HEX_CHARACTERS>
```

The API CORS implementation accepts comma-separated exact origins and tenant subdomains matching `https://<slug>.usms.in`. Confirm the actual Vercel preview origins before setting `WEB_ORIGIN`. Health check: `GET /health` should return HTTP 200.

## Database migrations

The repository includes `.github/workflows/staging-database.yml`, manually dispatched from the `staging` branch. Create a GitHub Actions environment named `staging` and add `STAGING_MIGRATION_DATABASE_URL` as an environment secret. Use the staging migration-capable connection string only.

The workflow runs migrations and the database smoke test using this privileged connection. The smoke test creates a temporary test role, so it must not use the restricted API runtime credential. Never provide the migration credential to the API.

## Vercel configuration

Business App root directory: `apps/pos`.

```env
VITE_API_URL=<STAGING_API_ORIGIN>
VITE_SUPABASE_URL=<STAGING_SUPABASE_URL>
VITE_SUPABASE_ANON_KEY=<STAGING_SUPABASE_ANON_KEY>
```

Storefront root directory: `apps/storefront`.

```env
VITE_API_URL=<STAGING_API_ORIGIN>
```

Set these as staging/preview-only variables. Do not overwrite production variables. The storefront supports `?store=<shop-slug>` for preview testing without a custom domain.

## Local worker

Run the reservation expiry worker from the repository during staging validation:

```bash
pnpm --filter @usms/api worker:reservations
```

It must use the staging database URL and SSL settings, never production credentials. Stop it when testing is complete. A free hosted API does not imply that the worker is running.

## Deployment sequence

1. Confirm the GitHub `staging` branch CI is green.
2. Create a separate Supabase Free staging project; use synthetic data only.
3. Configure migration and runtime roles after reviewing the current database grants and RLS policies.
4. Add the GitHub environment secret and run the manual staging database workflow.
5. Optionally create the Render Free API from `render.yaml`; inspect the final plan and total price before confirming. If anything is paid, cancel.
6. Configure the two existing Vercel projects for staging previews and staging-only environment variables.
7. Start the local reservation worker when validating expiry behavior.
8. Run the acceptance checks below.

## Acceptance checklist

- [ ] API health endpoint returns HTTP 200.
- [ ] Business App authenticates against staging Supabase.
- [ ] Storefront resolves the correct synthetic staging shop.
- [ ] Two tenants cannot read or mutate one another's data.
- [ ] Branch-scoped staff permissions are enforced.
- [ ] POS sale atomically decrements stock.
- [ ] Online order reserves stock; payment capture converts reservation to sale.
- [ ] Failed, cancelled and expired unpaid orders release reservations.
- [ ] Duplicate payment callbacks/webhooks are safely deduplicated.
- [ ] Razorpay test-mode refund path is verified.
- [ ] POS offline queue reconciles and surfaces conflicts.
- [ ] Local worker processes reservation expiry while running.
- [ ] Invoice/tax output is reviewed; do not represent preview as GST-certified.
- [ ] Backup restoration and API/worker restart recovery are tested.
- [ ] Staging uses only synthetic data and test payment credentials.

## Production blockers

Free staging is not production readiness. Before onboarding paying shops, complete independent security review, tenant-isolation tests, end-to-end payment/refund verification, qualified Indian tax review, backup restore drill, monitoring and reliable always-on worker hosting. Do not enable live Razorpay before these gates pass.
