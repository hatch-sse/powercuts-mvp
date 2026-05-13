from __future__ import annotations

import csv
import gzip
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from shapely.geometry import LineString, MultiLineString, MultiPolygon, Polygon, mapping, shape
from shapely.ops import unary_union

from db import get_connection, init_db

ROOT = Path(__file__).resolve().parents[1]
DASHBOARD_DATA = ROOT / "docs" / "data"
SECTOR_BOUNDARIES_GEOJSON = ROOT / "data" / "mapping" / "ssen-postcode-sector-boundaries.geojson"
POSTCODE_LA_LOOKUP_GZ = DASHBOARD_DATA / "postcode-local-authority-lookup-live-uk.csv.gz"
LOCAL_AUTHORITY_BOUNDARIES_GEOJSON = DASHBOARD_DATA / "local-authorities-uk-2024-wgs84-web.geojson"
CSE_LOCAL_AUTHORITY_JSON = DASHBOARD_DATA / "cse-local-authority-psr.json"

VALID_NETWORKS = {"SHEPD", "SEPD"}
ROLLING_DAYS = 365
BOUNDARY_SIMPLIFY_TOLERANCE = 0.003


def normalise(value: Any) -> str:
    return str(value or "").strip().upper()


def normalise_postcode(value: Any) -> str:
    return " ".join(str(value or "").strip().upper().split())


def compact_postcode(value: Any) -> str:
    return "".join(str(value or "").upper().split())


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
        raise RuntimeError(f"Missing sector boundary file: {SECTOR_BOUNDARIES_GEOJSON}")

    data = json.loads(SECTOR_BOUNDARIES_GEOJSON.read_text(encoding="utf-8"))
    boundaries: dict[str, dict[str, Any]] = {}

    for feature in data.get("features", []):
        props = feature.get("properties", {})
        sector = normalise(props.get("postcode_sector"))
        boundary_network = normalise(props.get("network"))
        geometry = feature.get("geometry")

        if sector and boundary_network in VALID_NETWORKS and geometry:
            boundaries[sector] = {
                "postcode_sector": sector,
                "network": boundary_network,
                "geometry": geometry,
            }

    if not boundaries:
        raise RuntimeError("No valid postcode sector boundaries found")

    print(f"Loaded {len(boundaries)} SSEN postcode sector boundaries")
    return boundaries


def read_cse_authorities() -> dict[str, dict[str, str]]:
    if not CSE_LOCAL_AUTHORITY_JSON.exists():
        print(f"CSE local authority data not found: {CSE_LOCAL_AUTHORITY_JSON}")
        return {}

    data = json.loads(CSE_LOCAL_AUTHORITY_JSON.read_text(encoding="utf-8"))
    rows = data.get("rows", [])
    authorities = {
        str(row.get("local_authority_code") or ""): {
            "local_authority_code": str(row.get("local_authority_code") or ""),
            "local_authority_name": str(row.get("local_authority_name") or ""),
        }
        for row in rows
        if row.get("local_authority_code") and row.get("local_authority_name")
    }
    print(f"Loaded {len(authorities)} CSE local authority rows")
    return authorities


def read_postcode_local_authority_lookup(cse_authorities: dict[str, dict[str, str]]) -> dict[str, dict[str, str]]:
    if not POSTCODE_LA_LOOKUP_GZ.exists():
        print(f"Postcode local authority lookup not found: {POSTCODE_LA_LOOKUP_GZ}")
        return {}

    lookup: dict[str, dict[str, str]] = {}

    with gzip.open(POSTCODE_LA_LOOKUP_GZ, "rt", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            postcode = normalise_postcode(row.get("postcode"))
            postcode_compact = compact_postcode(row.get("postcode_compact") or postcode)
            code = str(row.get("local_authority_code") or "").strip()
            if not postcode or not postcode_compact or not code:
                continue
            authority = cse_authorities.get(code, {})
            lookup[postcode_compact] = {
                "postcode": postcode,
                "postcode_sector": row.get("postcode_sector") or postcode_to_sector(postcode),
                "local_authority_code": code,
                "local_authority_name": authority.get("local_authority_name", ""),
                "local_authority_match_method": "full_postcode_lookup",
            }

    print(f"Loaded {len(lookup)} live postcode-to-local-authority lookup rows")
    return lookup


def build_sector_local_authority_lookup(boundaries: dict[str, dict[str, Any]], cse_authorities: dict[str, dict[str, str]]) -> dict[str, dict[str, str]]:
    """Fallback only: assigns a postcode sector to the LA with the largest overlap."""
    if not LOCAL_AUTHORITY_BOUNDARIES_GEOJSON.exists():
        print(f"Local authority boundary data not found: {LOCAL_AUTHORITY_BOUNDARIES_GEOJSON}")
        return {}

    if not cse_authorities:
        return {}

    local_authority_data = json.loads(LOCAL_AUTHORITY_BOUNDARIES_GEOJSON.read_text(encoding="utf-8"))
    local_authorities = []

    for feature in local_authority_data.get("features", []):
        props = feature.get("properties", {})
        code = str(props.get("LAD24CD") or "")
        if code not in cse_authorities:
            continue
        try:
            geometry = shape(feature.get("geometry"))
            if not geometry.is_valid:
                geometry = geometry.buffer(0)
        except Exception:
            continue
        if not geometry.is_empty:
            local_authorities.append((code, cse_authorities[code]["local_authority_name"], geometry))

    lookup: dict[str, dict[str, str]] = {}

    for sector, boundary in boundaries.items():
        try:
            sector_geometry = shape(boundary["geometry"])
            if not sector_geometry.is_valid:
                sector_geometry = sector_geometry.buffer(0)
        except Exception:
            continue

        best_code = ""
        best_name = ""
        best_area = 0.0

        for code, name, local_authority_geometry in local_authorities:
            if not sector_geometry.intersects(local_authority_geometry):
                continue
            area = sector_geometry.intersection(local_authority_geometry).area
            if area > best_area:
                best_code = code
                best_name = name
                best_area = area

        if best_code:
            lookup[sector] = {
                "local_authority_code": best_code,
                "local_authority_name": best_name,
                "local_authority_match_method": "postcode_sector_largest_boundary_overlap",
            }

    print(f"Built fallback local authority lookup for {len(lookup)} postcode sectors")
    return lookup


def exterior_lines_only(geometry: Any) -> MultiLineString:
    lines: list[LineString] = []

    if isinstance(geometry, Polygon):
        if not geometry.is_empty:
            lines.append(LineString(geometry.exterior.coords))
    elif isinstance(geometry, MultiPolygon):
        for polygon in geometry.geoms:
            if not polygon.is_empty:
                lines.append(LineString(polygon.exterior.coords))
    elif hasattr(geometry, "geoms"):
        for part in geometry.geoms:
            lines.extend(exterior_lines_only(part).geoms)

    return MultiLineString(lines)


def build_licence_boundary_overlay(boundaries: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    overlays: list[dict[str, Any]] = []

    for network in sorted(VALID_NETWORKS):
        geoms = []
        for boundary in boundaries.values():
            if boundary["network"] != network:
                continue
            try:
                geom = shape(boundary["geometry"])
                if not geom.is_valid:
                    geom = geom.buffer(0)
            except Exception:
                continue
            if not geom.is_empty:
                geoms.append(geom)

        if not geoms:
            continue

        unioned = unary_union(geoms)
        simplified = unioned.simplify(BOUNDARY_SIMPLIFY_TOLERANCE, preserve_topology=True)
        outline = exterior_lines_only(simplified)
        overlays.append({"type": "Feature", "properties": {"network": network, "label": f"{network} licence area outer boundary"}, "geometry": mapping(outline)})

    print(f"Built {len(overlays)} licence boundary overlays")
    return overlays


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

        events.append({
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
        })

    events.sort(key=lambda r: (r["last_seen"], r["postcode_sector"], r["outage_id"]))
    return events


def filter_events_to_boundary(events: list[dict[str, Any]], boundaries: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    filtered: list[dict[str, Any]] = []
    skipped_missing_boundary = 0
    skipped_network_mismatch = 0

    for event in events:
        boundary = boundaries.get(event["postcode_sector"])
        if not boundary:
            skipped_missing_boundary += 1
            continue
        if boundary["network"] != event["network"]:
            skipped_network_mismatch += 1
            continue
        filtered.append(event)

    print(f"Skipped {skipped_missing_boundary} events with no SSEN boundary")
    print(f"Skipped {skipped_network_mismatch} events where network did not match boundary")
    return filtered


def enrich_events_with_local_authorities(
    events: list[dict[str, Any]],
    postcode_lookup: dict[str, dict[str, str]],
    sector_lookup: dict[str, dict[str, str]],
) -> list[dict[str, Any]]:
    events_with_full_postcode_matches = 0
    events_with_sector_fallback = 0

    for event in events:
        postcode_details: list[dict[str, str]] = []
        authority_codes: set[str] = set()
        authority_names: set[str] = set()
        methods: set[str] = set()
        sector_match = sector_lookup.get(event["postcode_sector"])

        for postcode in event.get("postcodes", []):
            lookup_match = postcode_lookup.get(compact_postcode(postcode))
            match = lookup_match or sector_match

            detail = {
                "postcode": postcode,
                "postcode_sector": event["postcode_sector"],
            }

            if match:
                detail.update({
                    "local_authority_code": match.get("local_authority_code", ""),
                    "local_authority_name": match.get("local_authority_name", ""),
                    "local_authority_match_method": match.get("local_authority_match_method", ""),
                })
                if detail["local_authority_code"]:
                    authority_codes.add(detail["local_authority_code"])
                if detail["local_authority_name"]:
                    authority_names.add(detail["local_authority_name"])
                if detail["local_authority_match_method"]:
                    methods.add(detail["local_authority_match_method"])

            postcode_details.append(detail)

        if any(detail.get("local_authority_match_method") == "full_postcode_lookup" for detail in postcode_details):
            events_with_full_postcode_matches += 1
        elif any(detail.get("local_authority_match_method") == "postcode_sector_largest_boundary_overlap" for detail in postcode_details):
            events_with_sector_fallback += 1

        event["local_authority_code"] = "; ".join(sorted(authority_codes))
        event["local_authority_name"] = "; ".join(sorted(authority_names))
        event["local_authority_match_method"] = "; ".join(sorted(methods))
        event["postcodes_detail"] = postcode_details

    print(f"Enriched {events_with_full_postcode_matches} events using full postcode lookup")
    print(f"Enriched {events_with_sector_fallback} events using sector fallback")
    return events


def build_dashboard() -> None:
    init_db()
    DASHBOARD_DATA.mkdir(parents=True, exist_ok=True)

    now = datetime.now(timezone.utc).replace(microsecond=0)
    cutoff = now - timedelta(days=ROLLING_DAYS)

    boundaries = read_sector_boundaries()
    licence_boundaries = build_licence_boundary_overlay(boundaries)
    cse_authorities = read_cse_authorities()
    postcode_lookup = read_postcode_local_authority_lookup(cse_authorities)
    sector_local_authority_lookup = build_sector_local_authority_lookup(boundaries, cse_authorities)
    events = fetch_rolling_events(cutoff)
    events = filter_events_to_boundary(events, boundaries)
    events = enrich_events_with_local_authorities(events, postcode_lookup, sector_local_authority_lookup)

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
        "local_authority_mapping": {
            "method": "full_postcode_lookup_with_sector_fallback",
            "postcode_lookup_file": "postcode-local-authority-lookup-live-uk.csv.gz",
            "note": "Full postcodes are matched to local authority using the ONSPD lookup. If a postcode is missing from the lookup, the postcode sector boundary overlap fallback is used.",
        },
        "notes": [
            "Dashboard is mapped at postcode sector level.",
            "Only sectors within the official SSEN SHEPD/SEPD licence areas are included.",
            "Dashboard data is limited to a rolling 12-month window to keep the public site lightweight.",
            "Time off supply is approximate and based on captured outage windows.",
            "Licence boundary overlay is generated from the outer edge of the SSEN postcode sector boundary file.",
            "Local authority matching uses the ONSPD full postcode lookup where possible, with postcode sector boundary overlap as a fallback.",
        ],
        "boundaries": boundary_rows,
        "licence_boundaries": licence_boundaries,
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
