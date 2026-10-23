-- Preserve existing identities and historical snapshots while enabling controlled maintenance.
ALTER TABLE material_catalog ADD COLUMN IF NOT EXISTS active BIGINT NOT NULL DEFAULT 1 CHECK(active IN (0,1));
ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS cancelled_by BIGINT REFERENCES users(id);
ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS cancelled_at TEXT;
ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS cancel_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE material_requests DROP CONSTRAINT IF EXISTS material_requests_status_check;
ALTER TABLE material_requests ADD CONSTRAINT material_requests_status_check CHECK(status IN ('draft','submitted','cancelled'));
CREATE TABLE IF NOT EXISTS material_number_allocations(
  kind TEXT NOT NULL CHECK(kind IN ('catalog','request','opening','supplement')),
  sequence BIGINT NOT NULL CHECK(sequence>0), code TEXT NOT NULL CHECK(length(code)>0 AND length(code)<=64),
  created_at TEXT NOT NULL, PRIMARY KEY(kind,sequence), UNIQUE(kind,code)
);
INSERT INTO material_state(key,value) VALUES
  ('number_rule_catalog','{"template":"MAT-{YYYY}{MM}{DD}-{SEQ}","padding":6,"version":1,"actorId":null,"updatedAt":"","reason":""}'),
  ('number_rule_request','{"template":"WZ-{YYYY}{MM}{DD}-{SEQ}","padding":6,"version":1,"actorId":null,"updatedAt":"","reason":""}'),
  ('number_rule_opening','{"template":"QC-{YYYY}{MM}{DD}-{SEQ}","padding":6,"version":1,"actorId":null,"updatedAt":"","reason":""}'),
  ('number_rule_supplement','{"template":"BL-{YYYY}{MM}{DD}-{SEQ}","padding":6,"version":1,"actorId":null,"updatedAt":"","reason":""}'),
  ('number_sequence_catalog','0'),('number_sequence_request','0'),('number_sequence_opening','0'),('number_sequence_supplement','0')
  ON CONFLICT DO NOTHING;
