// Applies a dedicated PSR CSE filter to the postcode-sector power cut layer when present.
// The standard PSR CSE overlay should not remove power cut sectors by itself.

function cseSectorFilterIsEnabled() {
  const filterToggle = document.getElementById("cseFilterPowercuts");
  return (
    Boolean(document.getElementById("cseToggle")?.checked) &&
    Boolean(filterToggle?.checked) &&
    typeof window.cseVisibleRows === "function"
  );
}

function cseSectorVisibleAuthorityCodes() {
  if (!cseSectorFilterIsEnabled()) return null;
  const codes = new Set(window.cseVisibleRows().map((row) => row.local_authority_code).filter(Boolean));
  return codes.size ? codes : null;
}

function cseSectorRowAuthorityCodes(row) {
  const codes = new Set();
  const details = Array.isArray(row.full_postcodes_detail) ? row.full_postcodes_detail : [];

  for (const detail of details) {
    if (detail.local_authority_code) codes.add(detail.local_authority_code);
  }

  String(row.local_authority_code || "")
    .split(";")
    .map((code) => code.trim())
    .filter(Boolean)
    .forEach((code) => codes.add(code));

  return codes;
}

function cseSectorRowsHaveAuthorityCodes(rows) {
  return rows.some((row) => cseSectorRowAuthorityCodes(row).size > 0);
}

function cseSectorRowMatches(row, visibleAuthorityCodes) {
  if (!visibleAuthorityCodes) return true;
  const rowCodes = cseSectorRowAuthorityCodes(row);
  if (!rowCodes.size) return false;
  return [...rowCodes].some((code) => visibleAuthorityCodes.has(code));
}

(function initialiseCseSectorFiltering() {
  const originalGetFilteredSectors = window.getFilteredSectors;

  if (typeof originalGetFilteredSectors === "function") {
    window.getFilteredSectors = function cseAwareGetFilteredSectors() {
      const rows = originalGetFilteredSectors();
      const visibleAuthorityCodes = cseSectorVisibleAuthorityCodes();

      if (!visibleAuthorityCodes) return rows;

      // Older cached dashboard JSON may not yet contain local_authority_code on outage postcodes.
      // Do not blank the map in that case; the filter will activate once the refreshed dashboard data is deployed.
      if (!cseSectorRowsHaveAuthorityCodes(rows)) return rows;

      return rows.filter((row) => cseSectorRowMatches(row, visibleAuthorityCodes));
    };
  }

  function refreshPowercutSectorsAfterCseChange() {
    if (typeof window.updateAll === "function") {
      window.updateAll();
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    ["cseToggle", "cseNeedSelect", "cseReachThreshold", "cseCouncilSearch", "csePowercutOnly"].forEach((id) => {
      const element = document.getElementById(id);
      if (!element) return;

      element.addEventListener("change", () => window.setTimeout(refreshPowercutSectorsAfterCseChange, 450));
      element.addEventListener("input", () => window.setTimeout(refreshPowercutSectorsAfterCseChange, 450));
    });
  });
})();
