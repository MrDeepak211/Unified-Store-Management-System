# Tenant isolation requirements

Tenant isolation is a release-blocking security property.

- Every tenant-owned row has a non-null tenant identifier.
- Use tenant-aware composite relationships where practical, such as (tenant_id, product_id).
- Check active membership, role, branch scope, and permission on every request.
- Enable row-level security on every tenant-owned table.
- The application database role must not bypass RLS.
- Set transaction-local tenant context only after authenticating and authorizing membership.
- Never trust browser-supplied tenant IDs, roles, prices, tax amounts, discounts, payment states, or stock quantities.
- Audit privileged actions and financial-record changes.
- Add cross-tenant allow/deny tests for every module.

## Production checklist

1. Review all RLS policies and both allowed and denied paths.
2. Test connection-pool reuse to detect context leakage.
3. Ensure background jobs establish tenant context explicitly.
4. Encrypt provider credentials and other secrets at rest.
5. Test backup restoration and key rotation.
6. Arrange an independent security review.
