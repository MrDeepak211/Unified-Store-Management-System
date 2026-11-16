# USMS individual storefront model

## Product decision

USMS is a multi-tenant retail SaaS. Every tenant operates its own branded online storefront (for example, `shop-slug.usms.in`) and its physical shop through the USMS Business App/POS. There is no shared consumer marketplace in the initial product.

## One source of truth

The PostgreSQL database is authoritative for product prices, stock, reservations, sales and online orders. The POS and storefront are clients of the same API. Neither browser is allowed to calculate or directly write authoritative stock.

## Stock rules

1. A POS sale and an online order use the same inventory balance for the selected branch and product.
2. Online checkout reserves stock inside a database transaction before payment is initiated.
3. Payment success confirms the order; payment failure or expiry releases the reservation.
4. POS sales atomically decrement available stock. A sale fails cleanly if available stock is insufficient.
5. Returns, purchases and manual adjustments create auditable inventory movements; finalized movements are not silently edited.
6. Every mutation accepts an idempotency key to prevent duplicate sales on retries.
7. Real-time events notify other clients after commit. Events are refresh signals, not the source of truth.

## Tenant and branch boundaries

Every tenant-owned row carries a tenant ID. Foreign keys include tenant ID wherever records refer to another tenant-owned record. The API must derive tenant access from an authenticated membership, never trust a tenant ID supplied by the browser. PostgreSQL row-level security and least-privilege database roles must be enabled before production.

## Initial delivery scope

- Tenant onboarding and branch setup
- Product catalogue and stock opening balances
- POS sale and receipt
- Individual online storefront with product catalogue and cart
- Transactional checkout reservation and order status
- Shared live stock refresh
- Basic sales and stock reports

Advanced accounting, loyalty, supplier automation, multi-warehouse transfers, marketplace functionality and complex offline reconciliation are later phases.
