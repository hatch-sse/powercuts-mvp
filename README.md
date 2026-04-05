# SSEN Power Cuts Weekly Postcode Export MVP

This GitHub-ready MVP polls the public outage JSON every 10 minutes, stores outage/postcode history in SQLite, and exports a weekly CSV of postcodes that had a power cut in the last 7 days.

## What it does

- Fetches `https://raw.githubusercontent.com/robintw/sse_powercuts/master/outages.json`
- Upserts outage history into `data/powercuts.db`
- Stores one row per outage + postcode pair
- Writes weekly exports to `data/exports/`
- Commits updated data back to the repository from GitHub Actions

## Files

- `schema.sql` – database schema
- `scripts/fetch.py` – fetches and upserts outage data
- `scripts/export_weekly.py` – writes weekly CSV exports
- `.github/workflows/poll.yml` – runs every 10 minutes and every Monday morning

## Setup

1. Create a new GitHub repository.
2. Copy these files into it.
3. Make sure Actions are enabled for the repo.
4. Push to the default branch.

The workflow commits updated SQLite and CSV files back into the repo automatically.

## Notes

- Scheduled workflows run in UTC by default on GitHub Actions.
- GitHub says schedules can be delayed under heavy load and only run from the default branch.
- In public repos, scheduled workflows are automatically disabled after 60 days of inactivity.

## Output

The weekly export lands in `data/exports/` and includes:

- `postcode`
- `outage_count`
- `outage_refs`
- `first_seen`
- `last_seen`

## Future improvements

- Add region / outward-code rollups
- Publish CSV to GitHub Pages or S3
- Switch from SQLite-in-repo to Postgres if history gets large
