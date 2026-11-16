# Unified Store Management System (USMS)

USMS is a multi-tenant retail SaaS: **one Business App for the physical shop and one individual branded online store for each shop**, both powered by the same API and authoritative stock ledger.

## Product model

- **Business App:** POS billing, products, barcode/SKU lookup, categories, inventory, purchases, customers, suppliers, returns, expenses, cashbook, invoices, branches, stock transfers, staff access and reports.
- **Individual online store:** branded catalogue, live availability, cart, delivery details, order reservation, Razorpay checkout, private tracking and order fulfilment.
- **One shared backend:** the same PostgreSQL tenant data and inventory balances are used by online and counter sales.
- **No shared marketplace in the initial release.** Each shop receives its own address such as `shree-mart.usms.in`.

## Applications

| App | Local URL | Purpose |
|---|---|---|
| API | http://localhost:4000 | Shared Fastify API |
| Business App / POS | http://localhost:5174 | Shop management and physical counter operations |
| Storefront | http://localhost:5173 | Customer-facing individual store |
| Super admin | http://localhost:5176 | Early internal administration shell |
| Dashboard | http://localhost:5175 | Legacy dashboard shell |

## Local setup

Requirements: Node.js 22+, Corepack/pnpm 9, and Docker Desktop or Docker Engine.

1. Clone the repository and run `corepack enable`.
2. Run `pnpm install`.
3. Start PostgreSQL and Redis: `docker compose up -d`.
4. Copy `apps/api/.env.example` to `apps/api/.env`.
5. Set `DATABASE_URL=postgresql://usms:usms_dev_only@localhost:5432/usms`.
6. Configure Supabase Auth with asymmetric ES256 or RS256 signing keys. Set real `SUPABASE_JWKS_URL`, `SUPABASE_JWT_ISSUER`, and `SUPABASE_JWT_AUDIENCE`.
7. Set `ORDER_TRACKING_SECRET` to a private random value of at least 32 characters.
8. Generate a random 32-byte key encoded as 64 hexadecimal characters for `PAYMENT_ENCRYPTION_KEY`. Keep it in a server-side secret manager.
9. Set `SUPABASE_SERVICE_ROLE_KEY` only if staff email invitations are required. Never expose this key to a browser.
10. Apply SQL migrations: `pnpm db:migrate`.
11. Copy `apps/pos/.env.example` to `apps/pos/.env` and set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_API_URL`.
12. Copy `apps/storefront/.env.example` to `apps/storefront/.env` and set `VITE_API_URL`. For local testing, open the storefront with `?store=your-shop-slug`.
13. Run `pnpm dev`.

The Docker Compose PostgreSQL password is for local development only. Never reuse it in production.

## Implemented API capabilities

| Capability | Endpoints |
|---|---|
| Onboarding and identity | `POST /api/v1/onboarding/shop`, `GET /api/v1/me/shops` |
| Branches and stock transfers | `GET/POST /api/v1/business/branches`, `POST /api/v1/business/inventory/transfers` |
| Products and categories | `GET/POST /api/v1/business/products`, `GET/POST /api/v1/business/categories` |
| POS and inventory | `POST /api/v1/pos/sales`, `POST /api/v1/business/inventory/adjustments` |
| Customers, suppliers and purchases | `GET/POST /api/v1/business/customers`, `GET/POST /api/v1/business/suppliers`, `GET/POST /api/v1/business/purchases/receipts` |
| Returns, expenses and reports | `POST /api/v1/business/sales/:saleId/returns`, `GET/POST /api/v1/business/expenses`, `GET /api/v1/business/reports/overview` |
| Storefront configuration | `GET/PUT /api/v1/business/storefront`, `GET /api/v1/storefront/:slug` |
| Online orders | `POST /api/v1/storefront/:slug/orders`, `GET /api/v1/business/online-orders`, fulfil/cancel/refund endpoints, private order tracking |
| Payments | Razorpay account configuration, server-created payment orders, Checkout verification and signed webhook events |
| Invoices and business identity | `GET/PUT /api/v1/business/profile`, `GET /api/v1/business/invoices`, `GET /api/v1/business/invoices/:orderId` |
| Staff | `GET /api/v1/business/staff`, `POST /api/v1/business/staff/invite`, `PATCH /api/v1/business/staff/:membershipId` |

Authenticated business endpoints require a Supabase access token and an `X-USMS-Tenant` header. Mutating sales, purchases, inventory, transfers and expenses require an `Idempotency-Key` header.

## Shared inventory guarantees

- PostgreSQL is the source of truth; browser clients cannot directly change stock.
- POS sales atomically decrement `on_hand` only when available unreserved stock is sufficient.
- Online checkout atomically reserves stock. Payment capture converts the reservation into a sale.
- Failed, expired or cancelled unpaid orders release reservations.
- A captured payment arriving after reservation expiry is not fulfilled; USMS requests a refund.
- Signed webhook events are deduplicated. A confirmed refund can restock an unfulfilled order.
- Branch transfers atomically decrement the source branch and increment the destination branch.
- Inventory movements are auditable and idempotent.
- Offline POS sale intents are stored in IndexedDB and reconciled after reconnect. They are **provisional until the server accepts them**; the server revalidates current stock and can reject conflicts.
- API monetary calculations use integer paise and persisted PostgreSQL NUMERIC values.

## Payment model

Each shop connects its **own Razorpay merchant account**. USMS does not pool shop revenue. Key Secret and Webhook Secret are encrypted with AES-256-GCM before persistence; only the public Key ID is returned to the browser. Follow [the Razorpay setup guide](docs/payments/RAZORPAY.md), configure the per-shop webhook URL and test all payment/refund events before enabling live mode.

## Current implementation status

The repository now contains a substantial MVP foundation: tenant onboarding and RLS migrations; Supabase JWT verification; branch-scoped memberships; product categories and barcodes; shared inventory ledger; POS sales and offline queue; customers and suppliers; purchase receipts; returns; branch transfers; expenses and cashbook summary; individual storefront publishing; online delivery checkout and order management; per-shop Razorpay checkout, server verification and webhooks; financial-year invoice numbering and printable sales invoice preview; staff invitations; and a responsive Business App and storefront.

**Still required before a production launch:** full automated end-to-end and concurrency tests; live Razorpay test-mode verification in a configured merchant account; GST statutory invoice/credit-note review and CGST/SGST/IGST rules; robust refund reconciliation and partial returns; full offline conflict resolution UX; customer accounts and shipment integrations; product image uploads; custom domains; subscription billing; complete super-admin workflows; observability, rate limits, backups and restore drills; deployment hardening and an independent security review.

The current invoice is a **sales invoice preview**, not a certified GST-compliant tax invoice. GST treatment and invoice format must be reviewed by a qualified Indian tax professional. Do not use this scaffold for live financial or customer data until the remaining work, tenant isolation and payment security have been tested. Production database credentials must use a least-privilege non-owner, non-superuser role without BYPASSRLS.
