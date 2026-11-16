# Unified Store Management System (USMS)

A multi-tenant retail SaaS platform: one shared backend and data platform powering the customer storefront, physical-store POS, business dashboard, and SaaS administration.

## Applications

| App | Local URL | Purpose |
|---|---|---|
| API | http://localhost:4000 | Shared Fastify API; `/health` and `/api/v1/meta` are available |
| Storefront | http://localhost:5173 | Customer-facing online store shell |
| POS | http://localhost:5174 | Store terminal shell with a local IndexedDB pending-sale queue foundation |
| Business dashboard | http://localhost:5175 | Owner/manager workspace shell |
| Super admin | http://localhost:5176 | SaaS operations shell |

All four web applications are separate clients. They are intended to share the same API, business rules, tenant-aware database, and event infrastructure; they must not implement duplicate inventory or billing logic.

## Run locally

Requirements: Node.js 22+, Corepack/pnpm, and Docker Desktop or Docker Engine.

1. Clone this repository.
2. From the repository root, enable pnpm: `corepack enable`.
3. Install packages: `pnpm install`.
4. Copy `apps/api/.env.example` to `apps/api/.env`.
5. Start the local infrastructure: `docker compose up -d`.
6. Start all applications: `pnpm dev`.

You can also start an individual app with `pnpm --filter @usms/api dev`, `pnpm --filter @usms/storefront dev`, `pnpm --filter @usms/pos dev`, `pnpm --filter @usms/dashboard dev`, or `pnpm --filter @usms/super-admin dev`.

## Monorepo layout

- `apps/api` — Fastify API (initial health and metadata endpoints)
- `apps/storefront` — customer-facing React/Vite app
- `apps/pos` — React/Vite POS app and IndexedDB queue helper
- `apps/dashboard` — business owner dashboard shell
- `apps/super-admin` — SaaS administration shell
- `packages/contracts` — shared TypeScript API/domain contracts
- `packages/` — planned database, validation, API client, shared UI, and sync packages
- `docs/` — architecture, tenant-isolation, data-integrity, API conventions, and delivery plan

## Architecture rules

- Modular monolith first; do not split into microservices prematurely.
- Tenant membership and authorization are checked by the backend. A tenant ID supplied by the browser is never proof of access.
- Tenant-owned tables require row-level security and tenant-aware relationships.
- Inventory movements are an append-only ledger with transactional balance projections.
- Use PostgreSQL NUMERIC for persisted money, not binary floating-point.
- Make payments, sales, webhooks, and offline sync idempotent.
- Offline POS stores events locally; the server validates and reconciles them after reconnect. A local stock snapshot is not a guarantee of global stock availability.

## Current implementation status

This commit series is the **initial foundation**, not a completed retail product. The API currently exposes health and metadata endpoints; the web apps are UI shells; POS has a local queue helper. Authentication, tenant provisioning, database schema/migrations, product catalog, inventory transactions, GST invoices, checkout/payment integrations, end-to-end sync, reporting, and subscription billing still need implementation and tests.

Do not use this scaffold for live financial or customer data yet. GST/invoice workflows need review by a qualified Indian tax professional, and tenant isolation/payment flows need security testing before launch.
