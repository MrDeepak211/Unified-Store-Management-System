# USMS deployment runbook

This is a deployment guide for the current MVP scaffold. Complete the security and payment verification checklist before enabling live shops.

## 1. Infrastructure

Provision:

- Managed PostgreSQL with backups and point-in-time recovery.
- A managed container host for the Fastify API.
- A second long-running container using `Dockerfile.worker` for reservation expiry.
- Two Vercel projects for the Business App and storefront.
- A Supabase project for Auth.
- A DNS zone for `usms.in`.

Use HTTPS everywhere. Do not expose PostgreSQL or Redis publicly.

## 2. Database and migrations

Create two database roles:

- **Migration role:** owns schema objects and may create/alter tables and policies. Supply it only to the migration job as `MIGRATION_DATABASE_URL`.
- **API runtime role:** least-privilege login role. It must not be a superuser, table owner, or have `BYPASSRLS`. Supply it as `DATABASE_URL`.

Run migrations once from a controlled release job:

```bash
pnpm install --frozen-lockfile
pnpm db:migrate
```

The migration runner uses `MIGRATION_DATABASE_URL` when set, otherwise `DATABASE_URL`. Verify tenant RLS and branch assignment policies using the runtime role after migrations.

## 3. Supabase Auth

Configure Supabase Auth with asymmetric ES256 or RS256 JWT signing keys. Set:

- `SUPABASE_JWKS_URL`
- `SUPABASE_JWT_ISSUER`
- `SUPABASE_JWT_AUDIENCE`
- `SUPABASE_URL`

If shop owners will invite staff, set `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_INVITE_REDIRECT_URL` only in the API secret manager. Never place the service-role key in Vite/Vercel client variables.

## 4. API container

Build and deploy `Dockerfile.api`. Expose port 4000 and set:

- `DATABASE_URL` (runtime role)
- `WEB_ORIGIN=https://app.usms.in`
- Supabase JWT variables
- `ORDER_TRACKING_SECRET` (random, private, at least 32 characters)
- `PAYMENT_ENCRYPTION_KEY` (32 random bytes encoded as 64 hex characters)
- `API_HOST=0.0.0.0`, `API_PORT=4000`, `LOG_LEVEL=info`

Point `api.usms.in` to the API host. Confirm `https://api.usms.in/health` returns `{"status":"ok","service":"usms-api"}`.

The API CORS policy allows the configured Business App origin and tenant subdomains matching `https://<slug>.usms.in`. Add any other exact trusted origins to `WEB_ORIGIN`.

## 5. Reservation worker

Deploy `Dockerfile.worker` as a separate always-on process with the same runtime environment as the API. It releases expired online stock reservations every 30 seconds. Monitor its logs and restart policy.

Do not run the worker as a one-off short-lived web request.

## 6. Vercel projects

Create two Vercel projects from the same repository:

### Business App
- Root Directory: `apps/pos`
- Framework: Vite
- Environment: `VITE_API_URL=https://api.usms.in`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
- Domain: `app.usms.in`

### Storefront
- Root Directory: `apps/storefront`
- Framework: Vite
- Environment: `VITE_API_URL=https://api.usms.in`
- Domain: `*.usms.in` (wildcard domain; confirm your Vercel plan and DNS support)

Configure the wildcard DNS record exactly as Vercel instructs. The storefront resolves the shop slug from the first subdomain label. The API only serves published stores.

## 7. Payment setup

Set the API `PAYMENT_ENCRYPTION_KEY` before any shop saves merchant credentials. Each shop owner connects their own Razorpay merchant account. Follow [Razorpay setup](../payments/RAZORPAY.md), use test keys first, and configure signed webhooks for payment capture/failure and refund success/failure.

## 8. Release checks

- Run all GitHub Actions migration, tenant-isolation, typecheck and build jobs.
- Test two separate tenants and verify that no product, order, customer, report or stock data crosses tenant boundaries.
- Test branch-scoped staff permissions.
- Test POS vs online stock contention and simultaneous checkout attempts.
- Test offline queue reconciliation and conflict handling.
- Test payment success, payment failure, duplicate callbacks, webhook retries, reservation expiry and refund.
- Confirm invoice previews and tax calculations with a qualified Indian tax professional.
- Test database restore from backup and API/worker recovery.
- Add production monitoring, error alerting, rate limits and log retention.

**Do not switch to live Razorpay keys or onboard paying shops until an independent security review, tax review, and end-to-end payment/refund test are complete.**
