-- GPS 출퇴근 통합 버전 · D1 스키마
CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  radius_m INTEGER NOT NULL DEFAULT 50,
  kakao_place_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS store_location_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL,
  lat REAL, lng REAL, radius_m INTEGER,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL,
  store_id INTEGER NOT NULL,
  token TEXT UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attendance_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_record_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  store_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('IN','OUT')),
  recorded_at TEXT NOT NULL,
  server_received_at TEXT NOT NULL DEFAULT (datetime('now')),
  lat REAL, lng REAL, accuracy_m INTEGER,
  distance_m INTEGER,
  store_lat REAL, store_lng REAL, store_radius_m INTEGER,
  in_range INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  device_info TEXT
);

CREATE INDEX IF NOT EXISTS idx_att_user ON attendance_records(user_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_att_store ON attendance_records(store_id, recorded_at);
