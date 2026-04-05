PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS outages (
    outage_id TEXT PRIMARY KEY,
    name TEXT,
    outage_type TEXT,
    network TEXT,
    customers_affected INTEGER,
    logged_at_utc TEXT,
    estimated_restoration_utc TEXT,
    resolved INTEGER NOT NULL DEFAULT 0,
    first_seen_utc TEXT NOT NULL,
    last_seen_utc TEXT NOT NULL,
    raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outage_postcodes (
    outage_id TEXT NOT NULL,
    postcode TEXT NOT NULL,
    first_seen_utc TEXT NOT NULL,
    last_seen_utc TEXT NOT NULL,
    PRIMARY KEY (outage_id, postcode),
    FOREIGN KEY (outage_id) REFERENCES outages(outage_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fetched_at_utc TEXT NOT NULL,
    source_url TEXT NOT NULL,
    outage_count INTEGER NOT NULL,
    success INTEGER NOT NULL,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_outages_last_seen ON outages(last_seen_utc);
CREATE INDEX IF NOT EXISTS idx_outage_postcodes_last_seen ON outage_postcodes(last_seen_utc);
CREATE INDEX IF NOT EXISTS idx_outage_postcodes_postcode ON outage_postcodes(postcode);
