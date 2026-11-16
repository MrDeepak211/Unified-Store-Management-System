# Data integrity rules

- Use PostgreSQL NUMERIC for currency, rates, and tax calculations; never binary floating-point as authoritative stored money.
- Keep currency explicit where multi-currency may be introduced.
- Keep finalized invoices and sales immutable; corrections use credit notes, returns, or reversal entries.
- Enforce invoice sequence uniqueness by tenant, branch, and financial year.
- Inventory ledger entries are append-only; update balance rows transactionally.
- Use idempotency keys for sale creation, payments, refunds, webhooks, and offline sync events.
- Enforce integrity with database constraints and foreign keys, not application validation alone.
- Journal entries must balance debits and credits before posting.
- Store timestamps in UTC and apply tenant time zone to display and business-day boundaries.
- Never silently merge conflicting offline edits.
