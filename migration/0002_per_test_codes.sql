-- Add per-test ownership to access codes.
-- The base tests table already exists in 0001_initial.sql.

ALTER TABLE codes ADD COLUMN test_slug TEXT;

-- Preserve existing codes by assigning the original platform test.
UPDATE codes
SET test_slug = 'stress-map'
WHERE test_slug IS NULL;

CREATE INDEX IF NOT EXISTS idx_codes_test_slug
ON codes(test_slug);

CREATE INDEX IF NOT EXISTS idx_codes_code_hash
ON codes(code_hash);

CREATE INDEX IF NOT EXISTS idx_sessions_code_device
ON sessions(code_id, device_id);
