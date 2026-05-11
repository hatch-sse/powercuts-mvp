from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from db import get_connection, init_db

ROOT = Path(__file__).resolve().parents[1]
DASHBOARD_DATA = ROOT / "docs" / "data"
SECTOR_BOUNDARIES_GEOJSON = ROOT / "data" / "mapping" / "ssen-postcode-sector-boundaries.geojson"

VALID_NETWORKS = {"SHEPD", "SEPD"}
ROLLING_DAYS = 365


def normalise(value: Any) -> str:
    return str(value or "").strip().upper()


def normalise_postcode(value: Any) -> str:
    return " ".join(str(value or "").strip().upper().split())


def iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def postcode_to_sector(postcode: str) -> str:
    postcode = normalise_postcode(postcode)
    parts = postcode.split(" ")
    if len(parts) != 2 or not parts[1]:
        return ""
    return f"{parts[0]} {parts[1][0]}"


def to_number(value: Any) -> float:
    try:
        if value is None or value == "":
            return 0.0
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def read_sector_boundaries() -> dict[str, dict[str, Any]]:
    if not SECTOR_BOUNDARIES_GEOJSON.exists():
        raise RuntimeError(
            f"Missing sector boundary file: {SECTOR_BOUNDARIES_GEOJSON}. "
            "Add ssen-postcode-sector-boundaries.geojson to data/mapping/."
        )

    data = json.loads(SECTOR_BOUNDARIES_GEOJSON.read_text(encoding="utf-8"))
    features = data.get("features", [])

    if not isinstance(features, list):
        raise RuntimeError("Sector boundary GeoJSON does not contain a features array")

    boundaries: dict[str, dict[str, Any]] = {}

    for feature in features:
        props = feature.get("properties", {})
        sector = normalise(props.get("postcode_sector"))
        boundary_network = normalise(props.get("network"))
        geometry = feature.get("geometry")

        if not sector or boundary_network not in VALID_NETWORKS or not geometry:
            continue

        boundaries[sector] = {
            "postcode_sector": sector,
            "network": boundary_network,
            "geometry": geometry,
        }

    if not boundaries:
        raise RuntimeError("No valid postcode sector boundaries found")

    print(f"Loaded {len(boundaries)} SSEN postcode sector boundaries")
    return boundaries


def fetch_rolling_events(cutoff: datetime) -> list[dict[str, Any]]:
    query = """
        SELECT
            op.postcode AS postcode,
            op.outage_id AS outage_id,
            COALESCE(o.network, '') AS network,
            COALESCE(o.outage_type, '') AS outage_type,
            COALESCE(o.customers_affected, 0) AS customers_affected,
            op.first_seen_utc AS first_seen_utc,
            op.last_seen_utc AS last_seen_utc
        FROM outage_postcodes op
        JOIN outages o
          ON o.outage_id = op.outage_id
        WHERE op.last_seen_utc >= ?
    """

    with get_connection() as conn:
        rows = conn.execute(query, (iso_z(cutoff),)).fetchall()

    grouped: dict[tuple[str, str, str], dict[str, Any]] = {}

    for row in rows:
        postcode = normalise_postcode(row["postcode"])
        sector = postcode_to_sector(postcode)
        network = normalise(row["network"])
        outage_id = str(row["outage_id"] or "")

        if not postcode or not sector or not outage_id or network not in VALID_NETWORKS:
            continue

        key = (sector, network, outage_id)
        first_seen = str(row["first_seen_utc"] or "")
        last_seen = str(row["last_seen_utc"] or "")

        if key not in grouped:
            grouped[key] = {
                "postcode_sector": sector,
                "network": network,
                "outage_id": outage_id,
                "postcodes_set": set(),
                "outage_type_set": set(),
                "customers_affected": 0.0,
                "first_seen": first_seen,
                "last_seen": last_seen,
            }

        item = grouped[key]
        item["postcodes_set"].add(postcode)
        item["customers_affected"] = max(item["customers_affected"], to_number(row["customers_affected"]))

        if first_seen and (not item["first_seen"] or first_seen < item["first_seen"]):
            item["first_seen"] = first_seen

        if last_seen and (not item["last_seen"] or last_seen > item["last_seen"]):
            item["last_seen"] = last_seen

        outage_type = normalise(row["outage_type"])
        if outage_type:
            item["outage_type_set"].add(outage_type)

    events: list[dict[str, Any]] = []

    for value in grouped.values():
        first_dt = parse_iso(value["first_seen"])
        last_dt = parse_iso(value["last_seen"])
        duration_hours = 0.0
        if first_dt and last_dt and last_dt >= first_dt:
            duration_hours = round((last_dt - first_dt).total_seconds() / 3600, 2)

        events.append(
            {
                "postcode_sector": value["postcode_sector"],
                "network": value["network"],
                "outage_id": value["outage_id"],
                "postcodes": sorted(value["postcodes_set"]),
                "outage_type": ",".join(sorted(value["outage_type_set"])),
                "outage_count": 1,
                "total_customers_affected": round(value["customers_affected"], 2),
                "first_seen": value["first_seen"],
                "last_seen": value["last_seen"],
                "time_off_supply_hours_total_approx": duration_hours,
            }
        )

    events.sort(key=lambda r: (r["last_seen"], r["postcode_sector"], r["outage_id"]))
    return events


def filter_events_to_boundary(events: list[dict[str, Any]], boundaries: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    filtered: list[dict[str, Any]] = []
    skipped_missing_boundary = 0
    skipped_network_mismatch = 0

    for event in events:
        sector = event["postcode_sector"]
        network = event["network"]
        boundary = boundaries.get(sector)

        if not boundary:
            skipped_missing_boundary += 1
            continue

        if boundary["network"] != network:
            skipped_network_mismatch += 1
            continue

        filtered.append(event)

    print(f"Skipped {skipped_missing_boundary} events with no SSEN boundary")
    print(f"Skipped {skipped_network_mismatch} events where network did not match boundary")
    return filtered


def build_dashboard() -> None:
    init_db()
    DASHBOARD_DATA.mkdir(parents=True, exist_ok=True)

    now = datetime.now(timezone.utc).replace(microsecond=0)
    cutoff = now - timedelta(days=ROLLING_DAYS)

    boundaries = read_sector_boundaries()
    events = fetch_rolling_events(cutoff)
    events = filter_events_to_boundary(events, boundaries)

    used_sectors = {event["postcode_sector"] for event in events}
    boundary_rows = [boundaries[sector] for sector in sorted(used_sectors) if sector in boundaries]

    available_first = min((event["first_seen"] for event in events if event.get("first_seen")), default=iso_z(cutoff))
    available_last = max((event["last_seen"] for event in events if event.get("last_seen")), default=iso_z(now))

    payload = {
        "label": "Rolling 12 months",
        "generated_at": iso_z(now),
        "rolling_days": ROLLING_DAYS,
        "available_start": available_first[:10],
        "available_end": available_last[:10],
        "valid_networks": sorted(VALID_NETWORKS),
        "mapping_granularity": "postcode_sector",
        "notes": [
            "Dashboard is mapped at postcode sector level.",
            "Only sectors within the official SSEN SHEPD/SEPD licence areas are included.",
            "Dashboard data is limited to a rolling 12-month window to keep the public site lightweight.",
            "Time off supply is approximate and based on captured outage windows.",
        ],
        "boundaries": boundary_rows,
        "events": events,
    }

    out_json = DASHBOARD_DATA / "dashboard_rolling_12m.json"
    out_json.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {out_json} with {len(events)} events and {len(boundary_rows)} sector boundaries")


def main() -> int:
    build_dashboard()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
