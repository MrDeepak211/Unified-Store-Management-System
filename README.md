# Unified Store Management System (USMS)

USMS is a multi-tenant retail platform with **one Business App for the physical shop** and **a separate branded online store for each shop**. Both channels use the same backend and authoritative inventory.

## Product experience

- **Business App:** secure sign-in, shop onboarding, product catalogue, stock adjustments and POS sales.
- **Individual online store:** branded catalogue, live available stock, cart, customer details and 15-minute stock reservation at checkout.
- **Shared platform:** one Fastify API and PostgreSQL database per environment, with tenant-aware database policies.
- **No shared marketplace in the first release.** Each shop sells from its own address, such as `shree-mart.usms.in`.

## Applications

| App | Local URL | Purpose |
|---|---|---|
| API | http://localhost:4000 | Shared Fastify API |
| Business App / POS | http://localhost:5174 | Sign-in, shop setup, catalogue, inventory and counter sales |
| Storefront | http://localhost:5173 | Customer-facing shop website |
| Super admin | http://localhost:5176 | Internal SaaS operations shell |

The older dashboard shell remains in the monorepo while the product experience is consolidated into the Business App.

## Local setup

Requirements: Node.js 22+, Corepack/pnpm 9, and Docker Desktop or Docker Engine.

1. Clone the repository and run `corepack enable`.
2. Run `pnpm install`.
3. Start PostgreSQL and Redis: `docker compose up -d`.
4. Copy `apps/api/.env.example` to `apps/api/.env`.
5. Set `DATABASE_URL=postgresql://usms:usms_dev_only@localhost:5432/usms`.
6. Configure Supabase Auth using asymmetric ES256 or RS256 JWT signing keys. Set the real `SUPABASE_JWKS_URL`, `SUPABASE_JWT_ISSUER`, and `SUPABASE_JWT_AUDIENCE` in the API environment.
7. Set `ORDER_TRACKING_SECRET` to a private random value of at least 32 characters.
8. Apply SQL migrations: `pnpm db:migrate`.
9. Copy `apps/pos/.env.example` to `apps/pos/.env`, then set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_API_URL`.
10. Copy `apps/storefront/.env.example` to `apps/storefront/.env` and set `VITE_API_URL`. For local testing, open the storefront with `?store=your-shop-slug`.
11. Run `pnpm dev`.

For local-only use, the Docker Compose PostgreSQL password is deliberately simple. Never reuse it in production.

## Implemented API slices

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | API health |
| POST | `/api/v1/onboarding/shop` | Create a shop, first branch and owner membership |
| GET | `/api/v1/me/shops` | List the signed-in user's shops |
| GET | `/api/v1/business/branches` | List branches in the selected tenant |
| GET / POST | `/api/v1/business/products` | List and create products |
| POST | `/api/v1/business/inventory/adjustments` | Audited stock adjustment |
| POST | `/api/v1/pos/sales` | Transactional POS sale with stock deduction |
| GET | `/api/v1/storefront/:slug` | Published shop catalogue and available stock |
| POST | `/api/v1/storefront/:slug/orders` | Reserve online order stock for 15 minutes |
| GET | `/api/v1/storefront/:slug/orders/:orderId` | Private token-based order status |

Authenticated business endpoints require a Supabase access token and an `X-USMS-Tenant` header. POS sale and stock adjustment mutations require an `Idempotency-Key` header.

## Shared stock guarantees

- The database is the source of truth; neither client can write stock directly.
- POS sales decrement `on_hand` only when unreserved stock is sufficient.
- Online checkout increments `reserved` atomically only when stock is available.
- Expired online reservations are released by the separate reservation worker: `pnpm --filter @usms/api worker:reservations`.
- Inventory movements are audited and idempotent.
- Monetary calculations in the API use integer paise and persisted PostgreSQL NUMERIC values.

## Current implementation status

Implemented foundation: database migrations for tenants, branches, products, balances, movements, sales/orders, memberships, storefront settings and online reservation fields; JWT verification and tenant membership checks; shop onboarding; product and branch APIs; stock adjustments; transactional POS sales; public storefront catalogue; online stock reservation; private order tracking; reservation expiry worker; Business App login/onboarding/product/stock/POS screens; responsive storefront catalogue/cart/reservation UI; GitHub Actions CI.

**Not yet production complete:** payment gateway and merchant settlement, online payment confirmation webhook, GST-compliant final invoices/credit notes, purchase receiving and supplier management, returns/refunds, staff invitations and branch permissions, full offline POS reconciliation, subscriptions, super-admin workflows, image uploads, email/SMS notifications, observability, backups and restore drills.

The storefront currently reserves stock but does not collect payment. Do not use this scaffold for live financial or customer data until the remaining flows, tenant isolation and payment security have been tested. GST workflows require review by a qualified Indian tax professional. Production database runtime credentials must use a non-owner, non-superuser role without BYPASSRLS.
