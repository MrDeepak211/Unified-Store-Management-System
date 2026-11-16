# Unified Store Management System (USMS)

USMS is a multi-tenant retail SaaS: each shop gets one Business App for physical operations and its own branded online shopping website. Both channels use the same backend and authoritative inventory.

## Product model

- **Business App:** POS billing, products, stock, purchases, customers, staff and reports.
- **Individual online storefront:** a separate branded website for each shop (for example, `shop-slug.usms.in`).
- **Shared platform:** one API and PostgreSQL data platform per environment, with strict tenant and branch isolation.
- **No shared marketplace in the first release.** Each shop sells through its own storefront.

## Applications

| App | Local URL | Purpose |
|---|---|---|
| API | http://localhost:4000 | Shared Fastify API; `/health` and `/api/v1/meta` are available |
| Storefront | http://localhost:5173 | Customer-facing online store shell |
| POS | http://localhost:5174 | Physical-store POS shell and local pending-sale queue foundation |
| Business dashboard | http://localhost:5175 | Owner/manager workspace shell |
| Super admin | http://localhost:5176 | Internal SaaS operations shell |

The POS and business dashboard are currently separate development shells. Product direction is to combine them into one coherent Business App experience; they must share backend business rules rather than duplicate them.

## Run locally

Requirements: Node.js 22+, Corepack/pnpm, and Docker Desktop or Docker Engine.

1. Clone this repository.
2. From the repository root, enable pnpm: `corepack enable`.
3. Install packages: `pnpm install`.
4. Copy `apps/api/.env.example` to `apps/api/.env`.
5. Start local infrastructure: `docker compose up -d`.
6. Start applications: `pnpm dev`.

## Monorepo layout

- `apps/api` — shared Fastify API foundation
- `apps/storefront` — customer-facing React/Vite storefront
- `apps/pos` — physical POS React/Vite shell and offline queue foundation
- `apps/dashboard` — business management UI shell (to be unified with POS)
- `apps/super-admin` — internal SaaS administration shell
- `packages/contracts` — shared TypeScript contracts
- `packages/database` — PostgreSQL schema migrations and database package foundation
- `docs/` — architecture, tenant isolation, data-integrity and delivery guidance

## Non-negotiable architecture rules

- Modular monolith first; no premature microservices.
- Backend authentication and membership determine tenant access. A tenant ID supplied by a browser is never proof of access.
- Tenant-owned relationships must be tenant-aware; enable PostgreSQL row-level security and least-privilege roles before production.
- POS sales and online orders update the same authoritative inventory balance transactionally.
- Online checkout reserves stock before payment; failed/expired payments release reservations.
- Inventory movements are auditable and append-only; all mutation endpoints are idempotent.
- PostgreSQL NUMERIC is used for persisted money, never binary floating-point.
- Real-time events notify clients after a committed database change; the database remains the source of truth.
- Offline POS must reconcile safely after reconnect; local stock is not a guarantee of global availability.

## Current implementation status

This repository is an early foundation, not a completed retail product. The API currently exposes health and metadata endpoints; web apps are UI shells; POS has a local queue helper. An initial PostgreSQL migration now defines tenants, branches, products, shared inventory balances, inventory movements, and POS/online order records.

Authentication, tenant provisioning, database runtime integration, transactional inventory services, product APIs, GST invoices, checkout/payment integrations, end-to-end synchronization, reporting, and subscription billing still require implementation and automated tests.

**Do not use this scaffold for live financial or customer data yet.** GST workflows need review by a qualified Indian tax professional. Tenant isolation, payment handling, backups and restore procedures need security testing before launch.
