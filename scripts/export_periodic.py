from __future__ import annotations

import csv
from datetime import datetime, timezone
from pathlib import Path

from db import get_connection, init_db

ROOT = Path(__file__).resolve().parents[1]
EXPORT_ROOT = ROOT / "data" / "exports"
ANNUAL_DIR = EXPORT_ROOT / "annual"
MONTHLY_DIR = EXPORT_ROOT / "monthly"


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso_z(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


def start_of_year(year: int) -> datetime:
    return datetime(year, 1, 1, tzinfo=timezone.utc)


def end_of_year(year: int) -> datetime:
    return datetime(year + 1, 1, 1, tzinfo=timezone.utc)


def start_of_month(year: int, month: int) -> datetime:
    return datetime(year, month, 1, tzinfo=timezone.utc)


def end_of_month(year: int, month: int) -> datetime:
    if month == 12:
        return datetime(year + 1, 1, 1, tzinfo=timezone.utc)
    return datetime(year, month + 1, 1, tzinfo=timezone.utc)


def month_key(year: int, month: int) -> str:
    return f"{year:04d}-{month:02d}"


def write_rows_to_csv(path: Path, rows) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)

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
        count = 0
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
            count += 1

    return count


def export_period(start: datetime, end: datetime, output_path: Path) -> int:
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
        WHERE op.first_seen_utc < ?
          AND op.last_seen_utc >= ?
        GROUP BY op.postcode, COALESCE(o.network, '')
        ORDER BY outage_count DESC, op.postcode ASC
    """

    with get_connection() as conn:
        rows = conn.execute(query, (iso_z(end), iso_z(start))).fetchall()

    return write_rows_to_csv(output_path, rows)


def get_years_present() -> list[int]:
    query = """
        SELECT DISTINCT substr(first_seen_utc, 1, 4) AS year_text
        FROM outage_postcodes
        WHERE first_seen_utc IS NOT NULL
        ORDER BY year_text
    """

    with get_connection() as conn:
        rows = conn.execute(query).fetchall()

    years: list[int] = []
    for row in rows:
        year_text = row["year_text"]
        if year_text and str(year_text).isdigit():
            years.append(int(year_text))

    return years


def get_months_present_for_year(year: int) -> list[int]:
    prefix = f"{year:04d}-"
    query = """
        SELECT DISTINCT substr(first_seen_utc, 6, 2) AS month_text
        FROM outage_postcodes
        WHERE first_seen_utc LIKE ?
        ORDER BY month_text
    """

    with get_connection() as conn:
        rows = conn.execute(query, (f"{prefix}%",)).fetchall()

    months: list[int] = []
    for row in rows:
        month_text = row["month_text"]
        if month_text and str(month_text).isdigit():
            months.append(int(month_text))

    return months


def main() -> int:
    init_db()
    now = utc_now()
    current_year = now.year
    current_month = now.month

    ANNUAL_DIR.mkdir(parents=True, exist_ok=True)
    MONTHLY_DIR.mkdir(parents=True, exist_ok=True)

    years = get_years_present()
    if current_year not in years:
        years.append(current_year)
    years = sorted(set(years))

    for year in years:
        annual_path = ANNUAL_DIR / f"postcodes_{year}.csv"
        row_count = export_period(start_of_year(year), end_of_year(year), annual_path)
        print(f"Wrote {row_count} rows to {annual_path}")

        if year == current_year:
            current_year_copy = ANNUAL_DIR / "postcodes_current_year.csv"
            current_year_copy.write_text(annual_path.read_text(encoding="utf-8"), encoding="utf-8")

        months = get_months_present_for_year(year)
        if year == current_year and current_month not in months:
            months.append(current_month)
        months = sorted(set(months))

        for month in months:
            monthly_path = MONTHLY_DIR / f"postcodes_{month_key(year, month)}.csv"
            monthly_count = export_period(
                start_of_month(year, month),
                end_of_month(year, month),
                monthly_path,
            )
            print(f"Wrote {monthly_count} rows to {monthly_path}")

            if year == current_year and month == current_month:
                current_month_copy = MONTHLY_DIR / "postcodes_current_month.csv"
                current_month_copy.write_text(monthly_path.read_text(encoding="utf-8"), encoding="utf-8")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
