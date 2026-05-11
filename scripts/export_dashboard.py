from __future__ import annotations

import csv
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
EXPORTS = ROOT / "data" / "exports"
SECTORS = EXPORTS / "sectors"
DASHBOARD_DATA = ROOT / "docs" / "data"

MAPPING_XLSX = ROOT / "data" / "mapping" / "postcode-boundaries.xlsx"

VALID_NETWORKS = {"SHEPD", "SEPD"}
ROLLING_DAYS = 365


def normalise(value: Any) -> str:
    return str(value or "").strip().upper()


def postcode_sector_to_letters(sector: str) -> str:
    match = re.match(r"^([A-Z]{1,2})", normalise(sector))
    return match.group(1) if match else ""


def to_number(value: Any) -> float:
    try:
        if value is None or value == "":
            return 0.0
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def to_float(value: Any) -> float | None:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def read_csv(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        print(f"Missing {path}, skipping")
        return []

    with path.open("r", newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def read_mapping_rows() -> list[dict[str, Any]]:
    if not MAPPING_XLSX.exists():
        raise RuntimeError(
            f"Missing mapping workbook: {MAPPING_XLSX}. "
            "Add postcode-boundaries.xlsx to data/mapping/."
        )

    import pandas as pd

    df = pd.read_excel(MAPPING_XLSX, engine="openpyxl")
    df.columns = [str(c).strip() for c in df.columns]

    required = {"postcode_area", "geometry_wkt"}
    missing = required - set(df.columns)
    if missing:
        raise RuntimeError(f"Mapping workbook missing required columns: {sorted(missing)}")

    rows: list[dict[str, Any]] = []
    for _, row in df.iterrows():
        code = normalise(row.get("postcode_area"))
        if not code:
            continue

        rows.append(
            {
                "postcode_area": code,
                "description": str(row.get("description") or ""),
                "centroid_lat": to_float(row.get("centroid_lat")),
                "centroid_lon": to_float(row.get("centroid_lon")),
                "geometry_wkt": str(row.get("geometry_wkt") or ""),
            }
        )

    return rows


def filter_valid_sector_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    valid_rows: list[dict[str, Any]] = []

    for row in rows:
        network = normalise(row.get("network"))
        sector = normalise(row.get("postcode_sector"))

        if network not in VALID_NETWORKS:
            continue

        if not sector:
            continue

        valid_rows.append(row)

    return valid_rows


def aggregate_to_mapping(
    sector_rows: list[dict[str, Any]],
    mapping_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    mapping_codes = {r["postcode_area"] for r in mapping_rows}
    mapping_is_broad = all(re.fullmatch(r"[A-Z]{1,2}", c or "") for c in mapping_codes if c)
    mapping_by_code = {r["postcode_area"]: r for r in mapping_rows}

    grouped: dict[tuple[str, str], dict[str, Any]] = {}

    for row in sector_rows:
        sector = normalise(row.get("postcode_sector"))
        network = normalise(row.get("network"))

        if network not in VALID_NETWORKS:
            continue

        if not sector:
            continue

        if mapping_is_broad:
            area = postcode_sector_to_letters(sector)
        else:
            area = sector.split()[0] if sector.split() else ""

        if not area:
            continue

        key = (area, network)

        if key not in grouped:
            grouped[key] = {
                "postcode_area": area,
                "network": network,
                "outage_type_set": set(),
                "outage_count": 0.0,
                "total_customers_affected": 0.0,
                "time_off_supply_hours_total_approx": 0.0,
                "sector_count": 0,
            }

        grouped[key]["outage_count"] += to_number(row.get("outage_count"))
        grouped[key]["total_customers_affected"] += to_number(row.get("total_customers_affected"))
        grouped[key]["time_off_supply_hours_total_approx"] += to_number(
            row.get("time_off_supply_hours_total_approx")
        )
        grouped[key]["sector_count"] += 1

        for part in str(row.get("outage_type") or "").split(","):
            part = part.strip()
            if part:
                grouped[key]["outage_type_set"].add(part)

    final: list[dict[str, Any]] = []

    for value in grouped.values():
        mapping = mapping_by_code.get(value["postcode_area"], {})

        # Only include areas that actually have SSEN outage data.
        if value["outage_count"] <= 0:
            continue

        final.append(
            {
                "postcode_area": value["postcode_area"],
                "network": value["network"],
                "outage_type": ",".join(sorted(value["outage_type_set"])),
                "outage_count": round(value["outage_count"], 2),
                "total_customers_affected": round(value["total_customers_affected"], 2),
                "time_off_supply_hours_total_approx": round(
                    value["time_off_supply_hours_total_approx"], 2
                ),
                "sector_count": value["sector_count"],
                "centroid_lat": mapping.get("centroid_lat"),
                "centroid_lon": mapping.get("centroid_lon"),
                "geometry_wkt": mapping.get("geometry_wkt", ""),
            }
        )

    return final


def build_dashboard_file(label: str, sector_csv: Path, out_json: Path) -> None:
    mapping_rows = read_mapping_rows()
    sector_rows = filter_valid_sector_rows(read_csv(sector_csv))
    area_rows = aggregate_to_mapping(sector_rows, mapping_rows)

    payload = {
        "label": label,
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "source_sector_file": str(sector_csv.relative_to(ROOT)) if sector_csv.exists() else str(sector_csv),
        "valid_networks": sorted(VALID_NETWORKS),
        "mapping_granularity": "postcode_area",
        "notes": [
            "Only SHEPD and SEPD rows are included.",
            "Outage sector data is aggregated to the geography supported by the mapping workbook.",
            "Time off supply is approximate and based on captured first/last seen outage windows.",
        ],
        "areas": area_rows,
        "sectors": sector_rows,
    }

    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    print(
        f"Wrote {out_json} with "
        f"{len(area_rows)} mapped area rows and {len(sector_rows)} valid sector rows"
    )


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
