-- 0002_per_test_codes.sql
-- 为心理测试平台增加「测试」以及「测试专属验证码」能力

CREATE TABLE IF NOT EXISTS tests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 初始测试
INSERT OR IGNORE INTO tests (slug, title, description, active)
VALUES
(
  'stress-map',
  '压力地图',
  '看见压力背后真正想保护的东西，了解你正在承受什么。',
  1
),
(
  'meaning',
  '人生意义探索',
  '关于意义、方向、投入与存在感，探索什么正在支撑你继续向前。',
  1
);

-- 给原有 codes 表增加测试归属
ALTER TABLE codes ADD COLUMN test_slug TEXT;

-- 将历史验证码暂时归到压力地图。
-- 这样不会因为数据库升级导致原有验证码全部失效。
UPDATE codes
SET test_slug = 'stress-map'
WHERE test_slug IS NULL;

CREATE INDEX IF NOT EXISTS idx_codes_test_slug
ON codes(test_slug);

CREATE INDEX IF NOT EXISTS idx_codes_code
ON codes(code);

CREATE INDEX IF NOT EXISTS idx_sessions_code_device
ON sessions(code_id, device_id);
