function campaignUnique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function campaignCsvEscape(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function campaignDownloadText(filename, text, type = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function campaignCopyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const old = button.textContent;
    button.textContent = "Copied";
    window.setTimeout(() => (button.textContent = old), 1500);
  } catch {
    button.textContent = "Copy failed";
  }
}

function getVisibleCampaignSectors() {
  if (typeof getFilteredSectors !== "function") return [];
  return getFilteredSectors();
}

function cseCampaignFilterEnabled() {
  return Boolean(document.getElementById("cseToggle")?.checked) && typeof cseVisibleRows === "function";
}

function getVisibleCseAuthorityCodes() {
  if (!cseCampaignFilterEnabled()) return null;
  return new Set(cseVisibleRows().map((row) => row.local_authority_code).filter(Boolean));
}

function campaignPostcodeDetails(row) {
  if (Array.isArray(row.full_postcodes_detail) && row.full_postcodes_detail.length) {
    return row.full_postcodes_detail;
  }

  return (row.full_postcodes || []).map((postcode) => ({
    postcode,
    postcode_sector: row.postcode_sector || "",
    local_authority_code: row.local_authority_code || "",
    local_authority_name: row.local_authority_name || "",
  }));
}

function campaignSectorHasVisiblePostcodes(row, visibleCseCodes) {
  if (!visibleCseCodes) return true;
  return campaignPostcodeDetails(row).some((detail) => visibleCseCodes.has(detail.local_authority_code));
}

function getMetaSectors() {
  const visibleCseCodes = getVisibleCseAuthorityCodes();
  return campaignUnique(
    getVisibleCampaignSectors()
      .filter((row) => campaignSectorHasVisiblePostcodes(row, visibleCseCodes))
      .map((row) => String(row.postcode_sector || "").trim().toUpperCase())
  );
}

function getDoorDropRows() {
  const rowsByPostcode = new Map();
  const visibleCseCodes = getVisibleCseAuthorityCodes();

  for (const row of getVisibleCampaignSectors()) {
    const refs = campaignUnique(row.outage_refs || []);
    const postcodeDetails = campaignPostcodeDetails(row);

    for (const detail of postcodeDetails) {
      if (visibleCseCodes && !visibleCseCodes.has(detail.local_authority_code)) continue;

      const key = String(detail.postcode || "").toUpperCase();
      if (!key) continue;

      if (!rowsByPostcode.has(key)) {
        rowsByPostcode.set(key, {
          postcode: key,
          postcode_sector: detail.postcode_sector || row.postcode_sector || "",
          network: row.network || "",
          local_authority_code: detail.local_authority_code || row.local_authority_code || "",
          local_authority_name: detail.local_authority_name || row.local_authority_name || "",
          outage_types: new Set(),
          outage_refs: new Set(),
          outage_count: 0,
          total_customers_affected: 0,
          time_off_supply_hours_total_approx: 0,
          first_seen: row.first_seen || "",
          last_seen: row.last_seen || "",
        });
      }

      const output = rowsByPostcode.get(key);
      output.outage_count += Number(row.outage_count || 0);
      output.total_customers_affected += Number(row.total_customers_affected || 0);
      output.time_off_supply_hours_total_approx += Number(row.time_off_supply_hours_total_approx || 0);

      for (const ref of refs) output.outage_refs.add(ref);
      for (const type of String(row.outage_type || "").split(",")) {
        const clean = type.trim();
        if (clean) output.outage_types.add(clean);
      }

      if (row.first_seen && (!output.first_seen || row.first_seen < output.first_seen)) output.first_seen = row.first_seen;
      if (row.last_seen && (!output.last_seen || row.last_seen > output.last_seen)) output.last_seen = row.last_seen;
    }
  }

  return [...rowsByPostcode.values()]
    .map((row) => ({
      ...row,
      outage_types: [...row.outage_types].sort().join("; "),
      outage_refs: [...row.outage_refs].sort().join("; "),
    }))
    .sort((a, b) => a.postcode.localeCompare(b.postcode));
}

function buildMetaCsv() {
  const headers = ["postcode_sector"];
  const rows = getMetaSectors().map((sector) => [campaignCsvEscape(sector)].join(","));
  return [headers.join(","), ...rows].join("\n");
}

function buildDoorDropText() {
  return getDoorDropRows().map((row) => row.postcode).join(", ");
}

function buildDoorDropCsv() {
  const headers = [
    "postcode",
    "postcode_sector",
    "network",
    "local_authority_code",
    "local_authority_name",
    "outage_types",
    "outage_refs",
    "outage_count",
    "total_customers_affected",
    "time_off_supply_hours_total_approx",
    "first_seen",
    "last_seen",
  ];

  const rows = getDoorDropRows().map((row) =>
    headers.map((header) => campaignCsvEscape(row[header])).join(",")
  );

  return [headers.join(","), ...rows].join("\n");
}

function updateCampaignExportCounts() {
  const metaCount = document.getElementById("metaCount");
  const doorDropCount = document.getElementById("doorDropCount");

  const sectors = getMetaSectors();
  const postcodes = getDoorDropRows();
  const cseText = cseCampaignFilterEnabled() ? " matching the PSR CSE filters" : "";

  if (metaCount) {
    metaCount.textContent = `${sectors.length.toLocaleString("en-GB")} postcode sectors${cseText} ready for Meta Ads.`;
  }

  if (doorDropCount) {
    doorDropCount.textContent = `${postcodes.length.toLocaleString("en-GB")} full postcodes${cseText} ready for door-drop planning.`;
  }
}

function setupCampaignExportButtons() {
  document.getElementById("downloadMetaCsvBtn")?.addEventListener("click", () => {
    campaignDownloadText("meta-postcode-sectors.csv", buildMetaCsv(), "text/csv;charset=utf-8");
  });

  document.getElementById("copyDoorDropBtn")?.addEventListener("click", (event) => {
    const text = buildDoorDropText();
    const output = document.getElementById("metaOutput");
    if (output) output.value = text;
    campaignCopyText(text, event.currentTarget);
  });

  document.getElementById("downloadDoorDropTxtBtn")?.addEventListener("click", () => {
    campaignDownloadText("door-drop-full-postcodes.txt", buildDoorDropText());
  });

  document.getElementById("downloadDoorDropCsvBtn")?.addEventListener("click", () => {
    campaignDownloadText("door-drop-full-postcodes.csv", buildDoorDropCsv(), "text/csv;charset=utf-8");
  });
}

(function initialiseCampaignExports() {
  const originalUpdateAll = window.updateAll;

  if (typeof originalUpdateAll === "function") {
    window.updateAll = function wrappedUpdateAll() {
      originalUpdateAll();
      updateCampaignExportCounts();
    };
  }

  document.addEventListener("DOMContentLoaded", () => {
    setupCampaignExportButtons();
    window.setTimeout(updateCampaignExportCounts, 500);
  });
})();
