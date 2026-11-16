CREATE TABLE product_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);
ALTER TABLE product_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_categories_tenant_policy ON product_categories
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE products ADD COLUMN barcode text;
ALTER TABLE products ADD COLUMN category_id uuid;
ALTER TABLE products ADD CONSTRAINT products_category_tenant_fk
  FOREIGN KEY (tenant_id, category_id) REFERENCES product_categories(tenant_id, id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX products_tenant_barcode_idx
  ON products (tenant_id, barcode) WHERE barcode IS NOT NULL;
CREATE INDEX products_tenant_category_idx ON products (tenant_id, category_id);
