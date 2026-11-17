# USMS staging runbook

This runbook is for the first private staging deployment. Do not use production customer data or live payment credentials.

## 1. Create the staging database

1. Create a Supabase project for USMS staging in the Supabase dashboard.
2. In **Project Settings → Database**, copy the direct/session connection string for the database migration account. Prefer the direct connection for schema migrations.
3. Keep the project region close to the intended users. The free plan has usage, pause and availability limits; it is suitable for a prototype, not a production uptime promise.
4. Do not commit connection strings, JWT signing secrets, service-role keys or payment secrets to Git.

## 2. Configure GitHub

In the repository, open **Settings → Environments** and create an environment named `staging`.

Add this environment secret:

| Secret | Purpose |
|---|---|
| `STAGING_MIGRATION_DATABASE_URL` | Staging PostgreSQL connection string used only by the manually dispatched migration workflow |

The workflow is restricted to the `staging` branch. After adding the secret, open **Actions → USMS Staging Database Release → Run workflow**, select `staging`, and run it. Review the migration log before proceeding.

Do not point this secret at a production database. The migration account needs schema-change privileges; it must not be used as the API runtime account.

## 3. Configure the API runtime

Deploy the Fastify API as a separate Node.js service. Configure server-side environment variables from `apps/api/.env.example`:

- `DATABASE_URL`: a least-privilege runtime database connection, not the migration account.
- `DATABASE_SSL=true` when the provider requires TLS.
- `SUPABASE_JWKS_URL`, `SUPABASE_JWT_ISSUER`, and `SUPABASE_JWT_AUDIENCE`: values from the staging Supabase Auth project.
- `WEB_ORIGIN`: exact HTTPS origins of the staging POS and storefront.
- `ORDER_TRACKING_SECRET`: a unique random secret of at least 32 characters.
- `PAYMENT_ENCRYPTION_KEY`: a unique 32-byte key encoded as 64 hexadecimal characters.
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`: only if staff invitations are being tested. Keep the service-role key server-side.

Set the API health-check path to `/health`. Confirm `GET /api/v1/meta` returns the expected API identity. Never expose server secrets through `VITE_*` variables.

## 4. Configure the web apps

Deploy the POS and storefront separately or as separate applications from the monorepo. Set only browser-safe values in their build environments:

- POS: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_API_URL`.
- Storefront: `VITE_API_URL`.

Add the final HTTPS POS and storefront origins to the API's `WEB_ORIGIN` value, then redeploy the API. Confirm sign-in, shop onboarding, product creation and storefront catalogue reads using test accounts.

## 5. Payment verification

Use a staging Razorpay test-mode merchant account only. Verify order creation, signature validation, webhook signature validation, duplicate webhook handling, reservation expiry and refund paths before considering live mode. Never use live customer payments during staging.

## 6. Go-live gate

Staging is not production-ready until all of the following are evidenced:

- CI passes migrations, database smoke tests, API tests, authenticated tenant/role integration tests, typecheck and build.
- A least-privilege API runtime database role is used and tenant isolation is independently reviewed.
- Payment and refund flows pass in test mode.
- Backups and a restore drill are demonstrated.
- GST invoice treatment is reviewed by a qualified Indian tax professional.
- Rate limits, logging, monitoring, error reporting and incident ownership are configured.
- No real customer or payment data is present in staging.

A free hosting/database tier may sleep, pause, impose quotas or change limits. Treat it as a demo/staging environment only; confirm current provider limits before any commercial launch.
