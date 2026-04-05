from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from db import get_connection, init_db

SOURCE_URL = "https://raw.githubusercontent.com/robintw/sse_powercuts/master/outages.json"
USER_AGENT = "ssen-powercuts-history-mvp/1.0 (+https://github.com/)"
TIMEOUT_SECONDS = 30


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def fetch_json(url: str) -> list[dict[str, Any]]:
    req = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urlopen(req, timeout=TIMEOUT_SECONDS) as response:
        body = response.read().decode("utf-8")
    data = json.loads(body)
    if not isinstance(data, list):
        raise ValueError("Expected top-level JSON list of outages")
    return data


def normalize_postcodes(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    postcodes: list[str] = []
    for item in value:
        if isinstance(item, str):
            cleaned = " ".join(item.strip().upper().split())
            if cleaned:
                postcodes.append(cleaned)
    return sorted(set(postcodes))


def upsert_outage(conn, outage: dict[str, Any], now_utc: str) -> None:
    outage_id = str(outage.get("reference") or "").strip()
    if not outage_id:
        return

    conn.execute(
        """
        INSERT INTO outages (
            outage_id, name, outage_type, network, customers_affected,
            logged_at_utc, estimated_restoration_utc, resolved,
            first_seen_utc, last_seen_utc, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(outage_id) DO UPDATE SET
            name = excluded.name,
            outage_type = excluded.outage_type,
            network = excluded.network,
            customers_affected = excluded.customers_affected,
            logged_at_utc = excluded.logged_at_utc,
            estimated_restoration_utc = excluded.estimated_restoration_utc,
            resolved = excluded.resolved,
            last_seen_utc = excluded.last_seen_utc,
            raw_json = excluded.raw_json
        """,
        (
            outage_id,
            outage.get("name"),
            outage.get("type"),
            outage.get("network"),
            outage.get("customersAffected"),
            outage.get("loggedAt"),
            outage.get("estimatedRestoration"),
            1 if bool(outage.get("resolved")) else 0,
            now_utc,
            now_utc,
            json.dumps(outage, sort_keys=True, ensure_ascii=False),
        ),
    )

    for postcode in normalize_postcodes(outage.get("affectedAreas", [])):
        conn.execute(
            """
            INSERT INTO outage_postcodes (outage_id, postcode, first_seen_utc, last_seen_utc)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(outage_id, postcode) DO UPDATE SET
                last_seen_utc = excluded.last_seen_utc
            """,
            (outage_id, postcode, now_utc, now_utc),
        )


def record_snapshot(conn, fetched_at_utc: str, outage_count: int, success: bool, error_message: str | None = None) -> None:
    conn.execute(
        """
        INSERT INTO snapshots (fetched_at_utc, source_url, outage_count, success, error_message)
        VALUES (?, ?, ?, ?, ?)
        """,
        (fetched_at_utc, SOURCE_URL, outage_count, 1 if success else 0, error_message),
    )


def main() -> int:
    init_db()
    now_utc = utc_now_iso()

    try:
        outages = fetch_json(SOURCE_URL)
    except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
        with get_connection() as conn:
            record_snapshot(conn, now_utc, 0, success=False, error_message=str(exc))
            conn.commit()
        print(f"Fetch failed: {exc}", file=sys.stderr)
        return 1

    with get_connection() as conn:
        for outage in outages:
            if isinstance(outage, dict):
                upsert_outage(conn, outage, now_utc)
        record_snapshot(conn, now_utc, len(outages), success=True)
        conn.commit()

    print(f"Fetched {len(outages)} outages at {now_utc}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
