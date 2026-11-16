# Architecture overview

## Topology

The storefront, POS, owner dashboard, and SaaS admin are independent clients. All call a shared, versioned API. Start with a modular monolith: one deployable API with clear domain boundaries, rather than premature microservices.

```text
Storefront ─┐
POS/PWA ────┤
Owner UI ───┼── HTTPS / WebSocket ── Fastify API ── PostgreSQL
SaaS Admin ─┘                         │    ├──── Redis
                                      │    └──── Object storage
                                      └── Payment / messaging providers
```

## Modules

Identity/access; tenant/subscription management; branches/warehouses; catalog/pricing; inventory ledger; purchasing/suppliers; sales/invoices/payments/returns; storefront/carts/orders; POS/offline sync; reporting; integrations/webhooks/notifications/audit.

## Tenant request lifecycle

1. Verify access token.
2. Resolve membership using trusted identity and request context.
3. Authorize role, branch scope, and requested action.
4. Start a database transaction and set transaction-local tenant context.
5. Run tenant-scoped queries under database row-level security.
6. Commit; publish side effects through a transactional outbox.

A tenant ID from an untrusted browser is never proof of access. The ordinary application DB role must not be superuser or have BYPASSRLS.

## Inventory consistency

Inventory movements are append-only ledger rows. Insert the movement and update its balance projection in one transaction. Use concurrency-safe stock reservation/deduction. Corrections use compensating movements, not edits to history.

## Offline POS

Persist approved catalog snapshots and pending sale events in IndexedDB. Each event has a device-generated UUID/idempotency key. The server validates, deduplicates, reconciles, and acknowledges events. Offline stock is only a local estimate; concurrent terminals can conflict. Do not independently allocate final GST invoice numbers on disconnected devices: use provisional references and a compliant server-side numbering workflow reviewed by a tax professional.

## Realtime/events

Use a transactional outbox to write domain changes and outbox records together. Publish after commit; consumers must be idempotent. An in-memory event emitter is not a durable business event system.

## Operations

Keep development, staging, and production separate. Apply reviewed migrations in production. Test backup restoration, not merely backup creation.
