CREATE TABLE IF NOT EXISTS codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,
  code_preview TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unused',
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  expires_at INTEGER,
  max_devices INTEGER NOT NULL DEFAULT 5,
  note TEXT
);
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_id INTEGER NOT NULL,
  device_token_hash TEXT NOT NULL,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE(code_id, device_token_hash),
  FOREIGN KEY(code_id) REFERENCES codes(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_id INTEGER NOT NULL,
  device_id INTEGER NOT NULL,
  session_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  FOREIGN KEY(code_id) REFERENCES codes(id) ON DELETE CASCADE,
  FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS tests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  subtitle TEXT,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO tests (slug,title,subtitle,description,enabled,sort_order) VALUES
('stress-map','压力地图','看见压力背后真正想保护的东西','测试内容暂未上线，等你完成题目与结果设计后接入。',0,1),
('meaning','人生意义探索','关于意义、方向与投入','测试内容暂未上线。',0,2);
