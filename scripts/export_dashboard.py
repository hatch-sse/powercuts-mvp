from __future__ import annotations

import csv
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
EXPORTS = ROOT / "data" / "exports"
SECTORS = EXPORTS / "sectors"
DASHBOARD_DATA = ROOT / "docs" / "data"

MAPPING_XLSX = ROOT / "data" / "mapping" / "postcode-boundaries.xlsx"
LICENCE_GEOJSON = ROOT / "data" / "mapping" / "ssen-licence-areas.geojson"

VALID_NETWORKS = {"SHEPD", "SEPD"}


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

    required = {"postcode_area", "geometry_wkt", "centroid_lat", "centroid_lon"}
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


def read_licence_features() -> list[dict[str, Any]]:
    if not LICENCE_GEOJSON.exists():
        raise RuntimeError(
            f"Missing licence boundary file: {LICENCE_GEOJSON}. "
            "Add ssen-licence-areas.geojson to data/mapping/."
        )

    data = json.loads(LICENCE_GEOJSON.read_text(encoding="utf-8"))
    features = data.get("features", [])
    if not isinstance(features, list):
        raise RuntimeError("Licence GeoJSON does not contain a features array")

    valid_features: list[dict[str, Any]] = []
    for feature in features:
        props = feature.get("properties", {})
        licence = normalise(props.get("licence_area"))

        if licence not in VALID_NETWORKS:
            continue

        geometry = feature.get("geometry", {})
        if not geometry:
            continue

        valid_features.append(
            {
                "licence_area": licence,
                "geometry": geometry,
            }
        )

    if not valid_features:
        raise RuntimeError("No SHEPD or SEPD features found in licence GeoJSON")

    return valid_features


def point_in_ring(lon: float, lat: float, ring: list[list[float]]) -> bool:
    """
    Ray-casting point-in-polygon test.
    Coordinates are expected as [lon, lat].
    """
    inside = False
    j = len(ring) - 1

    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]

        intersects = ((yi > lat) != (yj > lat)) and (
            lon < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi
        )

        if intersects:
            inside = not inside

        j = i

    return inside


def point_in_polygon(lon: float, lat: float, polygon: list[Any]) -> bool:
    """
    Polygon coordinates are [outer_ring, hole1, hole2...].
    Point must be inside outer ring and not inside holes.
    """
    if not polygon:
        return False

    outer = polygon[0]
    if not point_in_ring(lon, lat, outer):
        return False

    for hole in polygon[1:]:
        if point_in_ring(lon, lat, hole):
            return False

    return True


def point_in_geometry(lon: float, lat: float, geometry: dict[str, Any]) -> bool:
    geom_type = geometry.get("type")
    coords = geometry.get("coordinates")

    if geom_type == "Polygon":
        return point_in_polygon(lon, lat, coords)

    if geom_type == "MultiPolygon":
        return any(point_in_polygon(lon, lat, polygon) for polygon in coords)

    return False


def licence_for_point(
    lon: float | None,
    lat: float | None,
    licence_features: list[dict[str, Any]],
) -> str:
    if lon is None or lat is None:
        return ""

    for feature in licence_features:
        if point_in_geometry(lon, lat, feature["geometry"]):
            return feature["licence_area"]

    return ""


def filter_mapping_to_ssen_patch(
    mapping_rows: list[dict[str, Any]],
    licence_features: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    filtered: list[dict[str, Any]] = []

    for row in mapping_rows:
        licence = licence_for_point(
            row.get("centroid_lon"),
            row.get("centroid_lat"),
            licence_features,
        )

        if licence not in VALID_NETWORKS:
            continue

        row = dict(row)
        row["licence_area_from_boundary"] = licence
        filtered.append(row)

    print(f"Filtered mapping rows from {len(mapping_rows)} to {len(filtered)} inside SSEN licence areas")
    return filtered


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

        # Critical SSEN patch rule:
        # if the area is not inside the official SSEN licence boundary, drop it.
        mapping = mapping_by_code.get(area)
        if not mapping:
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

        if value["outage_count"] <= 0:
            continue

        final.append(
            {
                "postcode_area": value["postcode_area"],
                "network": value["network"],
                "licence_area_from_boundary": mapping.get("licence_area_from_boundary", ""),
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
    licence_features = read_licence_features()
    mapping_rows = read_mapping_rows()
    mapping_rows = filter_mapping_to_ssen_patch(mapping_rows, licence_features)

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
            "Postcode areas outside the official SSEN SHEPD/SEPD licence boundary are excluded.",
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
