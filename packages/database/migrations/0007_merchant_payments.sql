-- Per-shop payment credentials are encrypted by the API before persistence.
CREATE TABLE payment_gateway_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider IN ('razorpay')),
  key_id text NOT NULL,
  key_secret_ciphertext text NOT NULL,
  webhook_secret_ciphertext text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('test','live')),
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  sales_order_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('razorpay')),
  provider_order_id text,
  provider_payment_id text,
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  currency text NOT NULL DEFAULT 'INR',
  status text NOT NULL CHECK (status IN ('created','authorized','captured','failed','refund_pending','refunded')),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, sales_order_id),
  UNIQUE (tenant_id, provider_order_id),
  UNIQUE (tenant_id, provider_payment_id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, sales_order_id) REFERENCES sales_orders(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE payment_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider IN ('razorpay')),
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, provider_event_id)
);

ALTER TABLE payment_gateway_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_webhook_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY payment_gateway_accounts_tenant_policy ON payment_gateway_accounts
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY payments_tenant_policy ON payments
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY payment_webhook_events_tenant_policy ON payment_webhook_events
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
