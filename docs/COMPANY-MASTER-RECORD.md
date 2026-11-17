# USMS — Company & Product Master Record

> Living source of truth for company identity, product scope, architecture, decisions and delivery status. Update this document when a decision changes; do not silently redesign or duplicate an existing capability.

**Last updated:** 2026-11-17  
**Repository:** https://github.com/MrDeepak211/Unified-Store-Management-System  
**Default branch:** `main`  
**Working staging branch:** `staging`

## 1. Company working profile

| Field | Current record |
|---|---|
| Company/product name | Unified Store Management System (USMS) |
| Founder | Deepak |
| Founder structure | Solo founder at current project stage |
| Development stage | Working prototype / software development underway |
| Business category | Retail technology / multi-tenant SaaS |
| Business model | SaaS; commercial packaging and pricing not finalised |
| Legal entity / structure | Not finalised; do not represent an incorporation or registration as completed |
| Current delivery priority | Isolated staging deployment and end-to-end validation |

This record describes the current working project. Legal registration, company incorporation, trademarks, domains and tax registrations must be recorded only after independently confirmed.

## 2. Product vision and scope

USMS is a unified store-management ecosystem connecting a physical shop, billing counter, online storefront, inventory, customers, suppliers, staff, branches and owner operations through one shared backend and stock ledger.

**Core product model:** one Business App for shop operations plus one individual branded online store per shop. The same API and authoritative inventory ledger power both experiences.

**Initial release does not include a shared multi-seller marketplace.** Each shop has its own storefront address (for example, `shop-slug.usms.in`).

### Existing capability foundations — do not rebuild

- Tenant onboarding, memberships and Supabase JWT authentication
- Product catalogue, categories, SKU/barcode support
- Inventory ledger, stock adjustments and branch transfers
- POS sales and offline queue foundation
- Customers, suppliers and purchase receipts
- Returns, expenses and cashbook/reporting foundation
- Individual storefront publishing and online order flow
- Per-shop Razorpay integration, server verification and webhook handling foundation
- Invoice preview/numbering foundation
- Staff invitations and branch-scoped access foundation
- Early super-admin and dashboard application shells

The list records code/repository foundations, not a claim that every workflow is production-certified. Verify each capability end-to-end before release.

## 3. Repository and technology architecture

| Layer | Existing implementation |
|---|---|
| Monorepo | pnpm 9.15.4 + Turborepo |
| Runtime | Node.js 22 |
| API | Fastify 5, TypeScript |
| Database | PostgreSQL; SQL migration package |
| Authentication | Supabase Auth; JWT verification using JWKS |
| Business App / POS | React 18, Vite 6, TypeScript |
| Storefront | React 18, Vite 6, TypeScript |
| Payments | Razorpay per merchant/shop |
| API port (local) | 4000 |
| Storefront port (local) | 5173 |
| POS port (local) | 5174 |
| Legacy dashboard port (documented) | 5175 |
| Super-admin port (documented) | 5176 |

### Application directories

- `apps/api` — shared Fastify API
- `apps/pos` — Business App / POS
- `apps/storefront` — customer-facing individual shop storefront
- `apps/super-admin` — early internal administration shell
- `apps/dashboard` — legacy dashboard shell
- `packages/database` — migrations and database smoke tests
- `packages/contracts` — shared contracts

### Important architecture rules

1. PostgreSQL is the authoritative source of inventory and financial records.
2. Browser clients must not directly mutate stock.
3. Tenant isolation and branch-level authorization are release-critical.
4. Mutating financial/inventory operations must remain idempotent.
5. Online stock reservations, POS sales and webhook processing must be concurrency-safe.
6. Offline POS entries are provisional until server reconciliation accepts them.
7. Each shop connects its own Razorpay merchant account; USMS does not pool shop revenue.
8. Never expose Supabase service-role keys, database credentials, payment secrets or encryption keys in frontend variables or committed files.

## 4. Deployment model

### Environments

- **Local:** developer machine, local Docker PostgreSQL/Redis, local test identities.
- **Staging:** isolated database, isolated Supabase Auth project, staging API and worker, staging Business App and storefront deployments, test payment credentials only.
- **Production:** separate infrastructure and secrets; do not promote staging data or credentials.

### Existing deployment artefacts

- `Dockerfile.api`
- `Dockerfile.worker`
- `docker-compose.yml` (local development only)
- `apps/pos/vercel.json`
- `apps/storefront/vercel.json`
- `docs/deployment/PRODUCTION.md`

Staging hostnames are not yet confirmed. Do not assume that any suggested `staging-*.usms.in` hostname is already owned, configured or deployed.

## 5. Release gates

Before any live shop or live payment:

- Prove tenant isolation with at least two separate test tenants.
- Verify branch-scoped staff permissions.
- Test POS/online stock contention and simultaneous checkouts.
- Test offline queue reconciliation and conflict recovery.
- Test Razorpay test-mode success, failure, duplicate callbacks, webhook retries, reservation expiry and refunds.
- Review GST, tax, invoice and credit-note rules with a qualified Indian tax professional.
- Test database backup restoration and API/worker recovery.
- Add monitoring, error alerts, rate limits and log retention.
- Complete an independent security review.

The current invoice feature is a sales invoice preview, not a certified GST-compliant tax invoice.

## 6. Working agreements / change control

- Inspect the current repository before proposing or implementing a feature.
- Reuse existing modules, routes, migrations and components; do not create duplicate implementations.
- Do not restructure the monorepo or rename applications without a documented reason and founder approval.
- Work on `staging` for deployment validation; protect `main` as the stable baseline.
- Record every meaningful decision, completed task, blocker and deployment change in the project changelog or this record.
- Never record secret values. Record secret variable names and where they are configured, not their contents.
- Treat the founder as final decision-maker. AI support is advisory and implementation assistance.

## 7. Current CEO status — 2026-11-17

- [x] Repository reviewed; latest known main commit: `f04f93e56f1ab4447cbbecd6fa5817867e52471e`.
- [x] Existing CI last inspected as successful for migrations, database smoke test, typecheck and build.
- [x] Staging branch created from `main` for isolated deployment work.
- [ ] CI execution confirmed on `staging`.
- [ ] Local working-tree status confirmed by founder.
- [ ] Staging database and Supabase project provisioned.
- [ ] Staging API and reservation worker deployed.
- [ ] Business App and storefront deployed to staging.
- [ ] End-to-end staging acceptance checklist completed.

Update this section as work is completed. Do not mark a task complete based only on a plan or configuration suggestion.
