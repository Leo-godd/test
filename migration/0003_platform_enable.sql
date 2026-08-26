-- Enable the current test catalog.
UPDATE tests
SET enabled = 1
WHERE slug IN ('stress-map', 'meaning');
