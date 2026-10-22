-- Legacy permission upgrades retain their existing schema_migrations names and server logic.
-- Additive columns preserve old rows and snapshots; old application inserts keep working.
ALTER TABLE material_catalog ADD COLUMN IF NOT EXISTS remark TEXT NOT NULL DEFAULT '';
ALTER TABLE material_catalog ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE material_catalog ADD COLUMN IF NOT EXISTS merged_into BIGINT REFERENCES material_catalog(id);
ALTER TABLE material_request_items ADD COLUMN IF NOT EXISTS manufacturer TEXT NOT NULL DEFAULT '';
ALTER TABLE material_receipts ADD COLUMN IF NOT EXISTS manufacturer TEXT NOT NULL DEFAULT '';
ALTER TABLE material_receipts ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT '';
ALTER TABLE material_stock_movements ADD COLUMN IF NOT EXISTS manufacturer TEXT NOT NULL DEFAULT '';
ALTER TABLE material_stock_movements ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_material_catalog_identity ON material_catalog(name,spec,unit);
