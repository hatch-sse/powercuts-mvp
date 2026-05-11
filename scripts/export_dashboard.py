from __future__ import annotations

import csv
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
EXPORTS = ROOT / "data" / "exports"
SECTORS = EXPORTS / "sectors"
DASHBOARD_DATA = ROOT / "docs" / "data"

SECTOR_BOUNDARIES_GEOJSON = ROOT / "data" / "mapping" / "ssen-postcode-sector-boundaries.geojson"

VALID_NETWORKS = {"SHEPD", "SEPD"}


def normalise(value: Any) -> str:
    return str(value or "").strip().upper()


def to_number(value: Any) -> float:
    try:
        if value is None or value == "":
            return 0.0
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def read_csv(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        print(f"Missing {path}, skipping")
        return []

    with path.open("r", newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


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

        if not sector:
            continue

        if boundary_network not in VALID_NETWORKS:
            continue

        if not geometry:
            continue

        boundaries[sector] = {
            "postcode_sector": sector,
            "boundary_network": boundary_network,
            "geometry": geometry,
        }

    if not boundaries:
        raise RuntimeError("No valid postcode sector boundaries found")

    print(f"Loaded {len(boundaries)} SSEN postcode sector boundaries")
    return boundaries


def filter_valid_sector_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    valid_rows: list[dict[str, Any]] = []

    for row in rows:
        network = normalise(row.get("network"))
        sector = normalise(row.get("postcode_sector"))

        if network not in VALID_NETWORKS:
            continue

        if not sector:
            continue

        row = dict(row)
        row["network"] = network
        row["postcode_sector"] = sector
        valid_rows.append(row)

    return valid_rows


def attach_boundaries(
    sector_rows: list[dict[str, Any]],
    boundaries: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    final_rows: list[dict[str, Any]] = []
    skipped_missing_boundary = 0
    skipped_network_mismatch = 0

    for row in sector_rows:
        sector = normalise(row.get("postcode_sector"))
        network = normalise(row.get("network"))

        boundary = boundaries.get(sector)

        if not boundary:
            skipped_missing_boundary += 1
            continue

        # This is the important patch filter:
        # keep the sector only if the sector boundary itself belongs to the same SSEN network.
        if boundary["boundary_network"] != network:
            skipped_network_mismatch += 1
            continue

        final_rows.append(
            {
                "postcode_sector": sector,
                "network": network,
                "outage_type": str(row.get("outage_type") or ""),
                "outage_count": to_number(row.get("outage_count")),
                "total_customers_affected": to_number(row.get("total_customers_affected")),
                "time_off_supply_hours_total_approx": to_number(
                    row.get("time_off_supply_hours_total_approx")
                ),
                "geometry": boundary["geometry"],
            }
        )

    print(f"Skipped {skipped_missing_boundary} sector rows with no SSEN boundary")
    print(f"Skipped {skipped_network_mismatch} sector rows where network did not match boundary")

    return final_rows


def build_dashboard_file(label: str, sector_csv: Path, out_json: Path) -> None:
    boundaries = read_sector_boundaries()
    sector_rows = filter_valid_sector_rows(read_csv(sector_csv))
    sector_rows = attach_boundaries(sector_rows, boundaries)

    payload = {
        "label": label,
        "generated_at": datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        "source_sector_file": str(sector_csv.relative_to(ROOT)) if sector_csv.exists() else str(sector_csv),
        "valid_networks": sorted(VALID_NETWORKS),
        "mapping_granularity": "postcode_sector",
        "notes": [
            "Dashboard is mapped at postcode sector level.",
            "Only sectors within the official SSEN SHEPD/SEPD licence areas are included.",
            "Out-of-patch postcode sectors are excluded before the dashboard data is written.",
            "Time off supply is approximate and based on captured outage windows.",
        ],
        "sectors": sector_rows,
    }

    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")

    print(f"Wrote {out_json} with {len(sector_rows)} mapped sector rows")


def main() -> int:
    DASHBOARD_DATA.mkdir(parents=True, exist_ok=True)

    build_dashboard_file(
        "Current year",
        SECTORS / "postcode_sectors_current_year.csv",
        DASHBOARD_DATA / "dashboard_current_year.json",
    )

    build_dashboard_file(
        "Current month",
        SECTORS / "postcode_sectors_current_month.csv",
        DASHBOARD_DATA / "dashboard_current_month.json",
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
