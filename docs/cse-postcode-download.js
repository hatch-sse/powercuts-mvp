function buildCseAuthorityPowercutPostcodes(sectors) {
  // Preserve event metadata, but intersect with the thresholded, ranked and
  // PSR-filtered sector/postcode population used by all campaign exports.
  const allowedBySector = new Map(sectors.map((row) => [
    sectorKey(row), new Set(campaignPostcodeDetails(row).map((detail) => detail.postcode)),
  ]));
  const rowsByAuthority = new Map();
  if (!allowedBySector.size) return rowsByAuthority;

  for (const event of getFilteredEvents()) {
    const allowed = allowedBySector.get(sectorKey(event));
    if (!allowed) continue;

    for (const detail of eventPostcodeDetails(event)) {
      const postcode = detail.postcode;
      const authorityCode = detail.local_authority_code;
      if (!authorityCode || !allowed.has(postcode)) continue;

      if (!rowsByAuthority.has(authorityCode)) rowsByAuthority.set(authorityCode, new Map());
      const rowsByPostcode = rowsByAuthority.get(authorityCode);
      if (!rowsByPostcode.has(postcode)) {
        rowsByPostcode.set(postcode, {
          postcode,
          local_authority_code: authorityCode,
          local_authority_name: detail.local_authority_name || "",
          outage_refs: new Set(),
          postcode_sector: new Set(),
          network: new Set(),
          outage_type: new Set(),
          first_seen: "",
          last_seen: "",
        });
      }

      const row = rowsByPostcode.get(postcode);
      if (event.outage_id) row.outage_refs.add(event.outage_id);
      if (event.postcode_sector) row.postcode_sector.add(event.postcode_sector);
      if (event.network) row.network.add(event.network);
      for (const part of String(event.outage_type || "").split(",")) {
        const clean = part.trim();
        if (clean) row.outage_type.add(clean);
      }
      if (event.first_seen && (!row.first_seen || event.first_seen < row.first_seen)) row.first_seen = event.first_seen;
      if (event.last_seen && (!row.last_seen || event.last_seen > row.last_seen)) row.last_seen = event.last_seen;
    }
  }

  return rowsByAuthority;
}

function cseAuthorityPowercutPostcodes(authorityCode, rowsByAuthority) {
  const rows = rowsByAuthority.get(authorityCode);
  return rows ? [...rows.values()].sort((a, b) => a.postcode.localeCompare(b.postcode)) : [];
}

function cseAuthorityPostcodeCsv(authorityCode) {
  const headers = [
    "postcode",
    "local_authority_code",
    "local_authority_name",
    "postcode_sector",
    "network",
    "outage_type",
    "outage_refs",
    "first_seen",
    "last_seen",
  ];

  const rows = cseAuthorityPowercutPostcodes(authorityCode, cseState.powercutPostcodesByAuthority).map((row) => [
    row.postcode,
    row.local_authority_code,
    row.local_authority_name,
    [...row.postcode_sector].sort().join("; "),
    [...row.network].sort().join("; "),
    [...row.outage_type].sort().join("; "),
    [...row.outage_refs].sort().join("; "),
    row.first_seen,
    row.last_seen,
  ].map(cseCsvEscape).join(","));

  return [headers.join(","), ...rows].join("\n");
}

function cseAuthorityDownloadFilename(authorityCode) {
  const row = cseState.rowsByCode.get(authorityCode);
  return `${String(row?.local_authority_name || authorityCode || "local-authority")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}-powercut-postcodes.csv`;
}

(function initialiseCsePostcodeDownloads() {
  document.addEventListener("click", (event) => {
    const button = event.target.closest(".cse-postcode-download");
    if (!button) return;

    const authorityCode = button.dataset.authorityCode;
    if (!authorityCode) return;

    downloadCseCsv(cseAuthorityDownloadFilename(authorityCode), cseAuthorityPostcodeCsv(authorityCode));
  });

  document.addEventListener("DOMContentLoaded", () => {
    const powercutToggle = document.getElementById("csePowercutOnly");
    const powercutLabel = powercutToggle?.closest("label");

    if (powercutLabel) {
      const textNode = [...powercutLabel.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      if (textNode) textNode.textContent = " Hide power cut layer";
    }
  });
})();
