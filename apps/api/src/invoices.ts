import type { PoolClient } from "pg";

function financialYearFor(timezone: string): string {
  let parts: Record<string, string> = {};
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
    }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  } catch {
    parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
    }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  }
  const year = Number(parts.year);
  const month = Number(parts.month);
  const start = month >= 4 ? year : year - 1;
  return `${String(start).slice(-2)}-${String(start + 1).slice(-2)}`;
}

export async function issueSalesInvoice(client: PoolClient, tenantId: string, orderId: string) {
  const existing = await client.query(
    "SELECT invoice_number AS \"invoiceNumber\", invoice_issued_at AS \"issuedAt\" FROM sales_orders WHERE tenant_id = $1 AND id = $2",
    [tenantId, orderId],
  );
  if (!existing.rowCount) throw new Error("Sales order not found while issuing invoice.");
  if (existing.rows[0].invoiceNumber) return existing.rows[0];

  const profile = await client.query("SELECT timezone FROM tenants WHERE id = $1", [tenantId]);
  const financialYear = financialYearFor(profile.rows[0]?.timezone ?? "Asia/Kolkata");
  const sequence = await client.query(
    `INSERT INTO invoice_sequences (tenant_id, financial_year, last_number)
     VALUES ($1, $2, 1)
     ON CONFLICT (tenant_id, financial_year)
     DO UPDATE SET last_number = invoice_sequences.last_number + 1
     RETURNING last_number`,
    [tenantId, financialYear],
  );
  const invoiceNumber = `${financialYear}/${String(sequence.rows[0].last_number).padStart(6, "0")}`;
  const updated = await client.query(
    `UPDATE sales_orders o
     SET invoice_number = $3,
         invoice_issued_at = now(),
         invoice_issuer_snapshot = (
           SELECT jsonb_build_object(
             'shopName', t.name, 'legalName', COALESCE(t.legal_name, t.name),
             'gstin', t.gstin, 'stateCode', t.state_code, 'address', t.business_address
           ) FROM tenants t WHERE t.id = $1
         ),
         invoice_customer_snapshot = (
           SELECT jsonb_build_object(
             'name', COALESCE(c.name, o.customer_name),
             'phone', COALESCE(c.phone, o.customer_phone),
             'email', c.email, 'gstin', c.gstin,
             'stateCode', c.state_code, 'billingAddress', c.billing_address
           )
           FROM sales_orders o
           LEFT JOIN customers c ON c.tenant_id = o.tenant_id AND c.id = o.customer_id
           WHERE o.tenant_id = $1 AND o.id = $2
         )
     WHERE o.tenant_id = $1 AND o.id = $2 AND o.invoice_number IS NULL
     RETURNING invoice_number AS \"invoiceNumber\", invoice_issued_at AS \"issuedAt\"`,
    [tenantId, orderId, invoiceNumber],
  );
  return updated.rows[0] ?? existing.rows[0];
}
