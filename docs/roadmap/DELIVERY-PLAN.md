# Delivery plan

## Phase 1 — platform foundation
Monorepo, API health endpoint, database package, migrations, identity integration, tenant membership, authorization, and tenant-isolation tests.

## Phase 2 — catalog and stock
Categories, products, variants, barcodes, units, pricing, warehouses, inventory movements, balance projections, adjustments, and transfers.

## Phase 3 — in-store commerce
POS sessions, sales, sale items, tender records, invoice sequencing, returns, refunds, and configurable tax. Have Indian GST and invoice workflows validated by a qualified professional.

## Phase 4 — offline POS
IndexedDB persistence, durable outbox, device registration, idempotent push/pull, acknowledgements, conflict review, and interrupted-sync recovery.

## Phase 5 — online storefront
Store configuration, custom domains, customer catalog, carts, checkout, orders, payment provider integration, signed webhooks, and fulfillment.

## Phase 6 — business operations
Suppliers, purchase orders, goods receipts, expenses, staff permissions, reporting, and accounting exports.

## Phase 7 — SaaS readiness
Plans, subscriptions, usage limits, tenant onboarding, super-admin workflows, observability, load/security testing, backups, restore drills, and controlled pilot.

## Release gates

No production release until tenant isolation, financial idempotency, concurrency-safe stock updates, offline conflict behavior, payment verification, and data recovery are tested.
