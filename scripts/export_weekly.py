from __future__ import annotations

import csv
from datetime import datetime, timedelta, timezone
from pathlib import Path

from db import get_connection, init_db

ROOT = Path(__file__).resolve().parents[1]
EXPORT_DIR = ROOT / "data" / "exports"


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso_z(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


def export_for_window(start: datetime, end: datetime) -> tuple[Path, int]:
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"postcodes_{start.date()}_to_{end.date()}.csv"
    path = EXPORT_DIR / filename

    query = """
        SELECT
            op.postcode AS postcode,
            COALESCE(o.network, '') AS network,
            GROUP_CONCAT(DISTINCT COALESCE(o.outage_type, '')) AS outage_type,
            COUNT(DISTINCT op.outage_id) AS outage_count,
            GROUP_CONCAT(DISTINCT op.outage_id) AS outage_refs,
            COALESCE(SUM(COALESCE(o.customers_affected, 0)), 0) AS total_customers_affected,
            MIN(op.first_seen_utc) AS first_seen,
            MAX(op.last_seen_utc) AS last_seen,
            ROUND(
                (julianday(MAX(op.last_seen_utc)) - julianday(MIN(op.first_seen_utc))) * 24,
                2
            ) AS time_off_supply_hours_approx
        FROM outage_postcodes op
        JOIN outages o
          ON o.outage_id = op.outage_id
        WHERE op.first_seen_utc <= ?
          AND op.last_seen_utc >= ?
        GROUP BY op.postcode, COALESCE(o.network, '')
        ORDER BY outage_count DESC, op.postcode ASC
    """

    with get_connection() as conn:
        rows = conn.execute(query, (iso_z(end), iso_z(start))).fetchall()

    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow([
            "postcode",
            "network",
            "outage_type",
            "outage_count",
            "outage_refs",
            "total_customers_affected",
            "first_seen",
            "last_seen",
            "time_off_supply_hours_approx",
        ])
        for row in rows:
            writer.writerow([
                row["postcode"],
                row["network"],
                row["outage_type"],
                row["outage_count"],
                row["outage_refs"],
                row["total_customers_affected"],
                row["first_seen"],
                row["last_seen"],
                row["time_off_supply_hours_approx"],
            ])

    latest_path = EXPORT_DIR / "postcodes_latest_7d.csv"
    latest_path.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")

    postcode_only_path = EXPORT_DIR / "postcodes_only_latest_7d.csv"
    with postcode_only_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["postcode", "network"])
        for row in rows:
            writer.writerow([row["postcode"], row["network"]])

    return path, len(rows)


def main() -> int:
    init_db()
    end = utc_now()
    start = end - timedelta(days=7)
    path, row_count = export_for_window(start, end)
    print(f"Exported {row_count} postcode rows to {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
