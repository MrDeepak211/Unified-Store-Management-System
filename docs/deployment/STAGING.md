# USMS Staging Deployment Plan

**Target branch:** `staging`  
**Baseline:** `main` at `f04f93e56f1ab4447cbbecd6fa5817867e52471e` when staging branch was created.  
**Purpose:** validate the existing MVP in an isolated environment without rebuilding existing features or touching production.

## 1. Non-negotiable environment separation

Create one new Supabase staging project. It supplies both the isolated PostgreSQL database and Supabase Auth. Use synthetic test shops, users, products and orders only. Do not copy production personal or payment data. Keep production in a separate project.

Use separate database roles:
- Migration role: schema migration only.
- Runtime role: least privilege, not superuser, not table owner and without `BYPASSRLS`.

Use Razorpay test credentials only. Never commit secrets or put server-only credentials in Vite variables.

## 2. Existing deployment artefacts

- API container: root `Dockerfile.api`, listens on port 4000.
- Reservation worker: root `Dockerfile.worker`, separate always-on process.
- Render Blueprint: root `render.yaml`, defines the API and worker in Singapore on the `staging` branch; deployments are configured to wait for passing checks.
- Render background workers require a paid instance plan; confirm the displayed cost before approving resource creation.
- Business App: Vercel root directory `apps/pos`; existing `apps/pos/vercel.json`.
- Storefront: Vercel root directory `apps/storefront`; existing `apps/storefront/vercel.json`.
- Local database/cache: `docker-compose.yml` (not for production).

## 3. API staging environment variables

Configure these in the Render API service's environment. The committed `render.yaml` declares the required values as unsynced secrets, so secret values are not stored in Git. Use values from staging providers only. Render's web service must receive `PORT=4000` and `API_PORT=4000`, matching the existing Dockerfile's exposed port and API configuration.

```env
NODE_ENV=production
API_HOST=0.0.0.0
API_PORT=4000
LOG_LEVEL=info
DATABASE_URL=<STAGING_RUNTIME_DATABASE_URL>
PORT=4000
WEB_ORIGIN=<EXACT_STAGING_BUSINESS_APP_ORIGIN>
SUPABASE_URL=<STAGING_SUPABASE_URL>
SUPABASE_JWKS_URL=<STAGING_SUPABASE_JWKS_URL>
SUPABASE_JWT_ISSUER=<STAGING_SUPABASE_JWT_ISSUER>
SUPABASE_JWT_AUDIENCE=authenticated
ORDER_TRACKING_SECRET=<PRIVATE_RANDOM_SECRET_AT_LEAST_32_CHARACTERS>
PAYMENT_ENCRYPTION_KEY=<PRIVATE_RANDOM_32_BYTE_KEY_AS_64_HEX_CHARACTERS>
```

Only add `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_INVITE_REDIRECT_URL` if the staging test specifically covers staff invitations. Keep them server-side.

Use the Supabase session-mode pooler connection string from the Supabase Connect panel if the Render runtime cannot reach the direct database endpoint over IPv6. Enable `DATABASE_SSL=true`; do not hand-construct the pooler hostname or username. Health check: `GET /health` should return HTTP 200 and `{"status":"ok","service":"usms-api"}`.

## 4. Staging database migrations

The repository includes `.github/workflows/staging-database.yml`, a manual workflow restricted to the `staging` branch. Create a GitHub Actions environment named `staging` and add `STAGING_MIGRATION_DATABASE_URL` as an environment secret. Use the staging Supabase migration-capable connection string only. The workflow runs migrations and the database smoke test using this privileged connection. Do not give this credential to the API runtime. The API uses a separate least-privilege runtime database role.

The smoke test creates a temporary test role and therefore must run with the migration-capable role, not the restricted API runtime role.

## 5. Business App environment

Vercel project root: `apps/pos`.

```env
VITE_API_URL=<STAGING_API_ORIGIN>
VITE_SUPABASE_URL=<STAGING_SUPABASE_URL>
VITE_SUPABASE_ANON_KEY=<STAGING_SUPABASE_ANON_KEY>
```

## 6. Storefront environment

Vercel project root: `apps/storefront`.

```env
VITE_API_URL=<STAGING_API_ORIGIN>
```

Configure a staging test-store hostname only after the domain/DNS is available and assigned to the staging deployment. The API CORS configuration currently permits tenant subdomains matching `https://<slug>.usms.in`; verify the actual staging hostname and routing before testing.

## 7. Deployment order

1. Confirm local changes are safe and staging branch is current.
2. Create the new Supabase staging project; configure Auth and PostgreSQL.
3. Create separate migration and runtime database roles; configure GitHub environment secret and Render service secrets.
4. Link the Render Blueprint from the `staging` branch and review the service plan/cost before creating resources.
5. Run the manual `USMS Staging Database Release` workflow from the `staging` branch.
6. Deploy API using `Dockerfile.api`; verify `/health`.
7. Deploy worker using `Dockerfile.worker`; verify it stays running.
8. Connect the two existing Vercel projects to the `staging` branch with staging-only environment variables.
9. Configure staging origins/domains and test tenant resolution.
10. Execute the acceptance checklist below.

## 8. Acceptance checklist

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

## 9. Production release blockers

Do not onboard paying shops or enable live Razorpay until the security review, tax review, end-to-end payment/refund verification, tenant-isolation checks, backup restore drill and operational monitoring are complete.
