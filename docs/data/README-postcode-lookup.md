# Postcode to local authority lookup

Prepared from `ONSPD_NOV_2025.zip`.

## Recommended file to upload

Upload this file to the repository:

```text
docs/data/postcode-local-authority-lookup-live-uk.csv.gz
```

It contains current/live UK postcodes only. Terminated postcodes have been removed using the ONSPD `doterm` field.

## Columns

```csv
postcode,postcode_compact,postcode_sector,local_authority_code
```

- `postcode`: human-readable full postcode from ONSPD `pcds`
- `postcode_compact`: same postcode without spaces, useful for matching
- `postcode_sector`: derived sector, e.g. `AB10 1`
- `local_authority_code`: ONSPD `lad25cd`

## Notes

- Source: ONSPD November 2025
- Rows included: live/current postcodes only
- Rows excluded: terminated postcodes where `doterm` is populated
- The file is gzip-compressed so it is small enough to store in GitHub without loading the full ONSPD package into the app.
- This file should be used by the data build/export script, not fetched directly by the browser.
