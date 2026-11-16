# USMS API conventions

Base URL: `/api/v1`

## Authentication and tenant selection

Business endpoints require `Authorization: Bearer <Supabase access token>` and `X-USMS-Tenant: <tenant UUID>`. The API verifies the JWT using the configured Supabase JWKS URL and issuer, then checks an active membership for the token subject and selected tenant. A tenant ID supplied by the browser is only a selector; it is never proof of authorization.

Public storefront routes resolve a tenant by its unique shop slug and set transaction-local tenant scope before querying tenant-owned records.

## Implemented routes

- `POST /onboarding/shop` — authenticated first-shop creation.
- `GET /me/shops` — list only the authenticated user's active shop memberships.
- `GET /business/branches` — list branches for the selected tenant.
- `GET /business/products` — product catalogue with summed available stock.
- `POST /business/products` — create a product and its initial zero-stock branch balance.
- `POST /business/inventory/adjustments` — append an audited stock adjustment.
- `POST /pos/sales` — create a POS sale and atomically decrement available stock.
- `GET /storefront/:slug` — public published catalogue and available stock.
- `POST /storefront/:slug/orders` — create an online order and reserve stock.
- `GET /storefront/:slug/orders/:orderId?token=...` — retrieve an order using its high-entropy tracking token.

## Mutation requirements

POS sale and stock adjustment endpoints require an `Idempotency-Key` header. The API serializes duplicate idempotency keys per tenant, validates all product and branch references inside the transaction, computes totals server-side, and rolls back the entire sale if any item cannot be fulfilled.

Online checkout reserves stock for 15 minutes. Each shop may connect its own Razorpay account; the API encrypts merchant secrets, verifies Checkout signatures and signed webhook events, and commits reserved stock only after payment capture. The reservation expiry worker releases stock for expired pending orders. The customer-facing tracking token is HMAC-derived using the server-only `ORDER_TRACKING_SECRET`; only its hash is stored.

## Error envelope

Errors use `{ "error": { "code": "...", "message": "...", "requestId": "..." } }`. Internal server errors do not expose SQL or stack details to clients.
