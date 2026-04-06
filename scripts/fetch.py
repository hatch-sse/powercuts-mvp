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


def normalize_postcode(value: str) -> str:
    return " ".join(value.strip().upper().split())


def extract_outage_list(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]

    if isinstance(data, dict):
        print(f"Top-level keys: {list(data.keys())[:20]}")

        preferred_keys = [
            "outages",
            "data",
            "items",
            "results",
            "faults",
            "powerCuts",
        ]
        for key in preferred_keys:
            value = data.get(key)
            if isinstance(value, list) and all(isinstance(item, dict) for item in value):
                print(f"Using list from key: {key}")
                return value

        for key, value in data.items():
            if isinstance(value, list) and value and all(isinstance(item, dict) for item in value):
                print(f"Using first matching list-of-dicts from key: {key}")
                return value

        if all(isinstance(value, dict) for value in data.values()) and data:
            maybe_list = list(data.values())
            print("Using top-level dict values as outage records")
            return maybe_list

    raise RuntimeError(f"Unexpected JSON structure: {type(data).__name__}")


def fetch_json(url: str) -> list[dict[str, Any]]:
    req = Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        },
    )

    try:
        with urlopen(req, timeout=TIMEOUT_SECONDS) as response:
            raw = response.read().decode("utf-8")
            data = json.loads(raw)

        print(f"Fetched URL: {url}")
        print(f"Top-level JSON type: {type(data).__name__}")

        outages = extract_outage_list(data)
        return [item for item in outages if isinstance(item, dict)]

    except HTTPError as exc:
        raise RuntimeError(f"HTTP error {exc.code} when fetching outage feed") from exc
    except URLError as exc:
        raise RuntimeError(f"URL error when fetching outage feed: {exc.reason}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError("Response was not valid JSON") from exc


def upsert_outage(conn: Any, outage: dict[str, Any], now_iso: str) -> str:
    outage_id = str(
        outage.get("reference")
        or outage.get("jobID")
        or outage.get("id")
        or outage.get("outage_id")
        or outage.get("faultId")
        or ""
    ).strip()

    if not outage_id:
        raw_name = str(outage.get("name") or "unknown")
        raise RuntimeError(f"Encountered outage record without a usable outage ID: {raw_name}")

    name = outage.get("name")
    outage_type = outage.get("type") or outage.get("faultType")
    network = outage.get("network")
    customers_affected = outage.get("customersAffected") or outage.get("customers_affected")
    logged_at_utc = outage.get("loggedAt") or outage.get("faultLogTime")
    estimated_restoration_utc = (
        outage.get("estimatedRestoration")
        or outage.get("estimatedTimeOfRestoration")
    )
    resolved = outage.get("resolved")

    if isinstance(resolved, bool):
        resolved_int = int(resolved)
    elif resolved in (0, 1):
        resolved_int = int(resolved)
    else:
        resolved_int = 0

    raw_json = json.dumps(outage, separators=(",", ":"), ensure_ascii=False)

    conn.execute(
        """
        INSERT INTO outages (
            outage_id,
            name,
            outage_type,
            network,
            customers_affected,
            logged_at_utc,
            estimated_restoration_utc,
            resolved,
            first_seen_utc,
            last_seen_utc,
            raw_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            name,
            outage_type,
            network,
            customers_affected,
            logged_at_utc,
            estimated_restoration_utc,
            resolved_int,
            now_iso,
            now_iso,
            raw_json,
        ),
    )

    return outage_id


def extract_postcodes(outage: dict[str, Any]) -> list[str]:
    raw_areas = outage.get("affectedAreas", [])

    if not isinstance(raw_areas, list):
        return []

    postcodes: list[str] = []
    for value in raw_areas:
        if isinstance(value, str):
            normalized = normalize_postcode(value)
            if normalized:
                postcodes.append(normalized)

    return sorted(set(postcodes))


def upsert_outage_postcode(conn: Any, outage_id: str, postcode: str, now_iso: str) -> None:
    conn.execute(
        """
        INSERT INTO outage_postcodes (
            outage_id,
            postcode,
            first_seen_utc,
            last_seen_utc
        )
        VALUES (?, ?, ?, ?)
        ON CONFLICT(outage_id, postcode) DO UPDATE SET
            last_seen_utc = excluded.last_seen_utc
        """,
        (outage_id, postcode, now_iso, now_iso),
    )


def insert_snapshot(conn: Any, fetched_at_utc: str, outage_count: int) -> None:
    conn.execute(
        """
        INSERT INTO snapshots (
            fetched_at_utc,
            outage_count
        )
        VALUES (?, ?)
        """,
        (fetched_at_utc, outage_count),
    )


def main() -> int:
    now_iso = utc_now_iso()

    try:
        outages = fetch_json(SOURCE_URL)
        print(f"Fetched {len(outages)} outage records")

        conn = get_connection()
        init_db(conn)

        insert_snapshot(conn, now_iso, len(outages))

        postcode_rows = 0
        for outage in outages:
            outage_id = upsert_outage(conn, outage, now_iso)
            for postcode in extract_postcodes(outage):
                upsert_outage_postcode(conn, outage_id, postcode, now_iso)
                postcode_rows += 1

        conn.commit()
        conn.close()

        print(f"Stored {len(outages)} outages and {postcode_rows} outage-postcode rows")
        return 0

    except Exception as exc:
        print(f"Fetch failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
