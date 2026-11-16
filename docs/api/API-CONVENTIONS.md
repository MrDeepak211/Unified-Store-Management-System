# API conventions

Base path: `/api/v1`.

## Requests

- JSON request/response bodies.
- Bearer access token for authenticated requests.
- Resolve tenant context from authenticated membership, not an untrusted browser header alone.
- Validate input and output with shared schemas.
- Use cursor pagination for large collections.
- Require `Idempotency-Key` on non-repeatable financial and sync commands.
- Publish OpenAPI from route schemas.

## Error envelope

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request could not be validated.",
    "requestId": "req_..."
  }
}
```

Do not leak stack traces, SQL, secret values, or cross-tenant existence information.

## Initial route groups

`/auth`, `/tenants`, `/branches`, `/products`, `/categories`, `/inventory`, `/sales`, `/invoices`, `/returns`, `/payments`, `/customers`, `/suppliers`, `/purchases`, `/storefront`, `/carts`, `/orders`, `/pos/terminals`, `/sync`, `/integrations`, `/webhooks`, `/reports`.

The server calculates authoritative totals, taxes, stock effects, payment status, and invoice numbers. Verify online payments server-to-server and accept only signed, replay-protected, idempotent webhooks.
