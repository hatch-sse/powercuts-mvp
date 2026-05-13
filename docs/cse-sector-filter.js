// Applies the active PSR CSE filters to the postcode-sector power cut layer.
// This keeps the blue postcode-sector polygons, cards, Top sectors list and campaign exports
// aligned with the selected CSE local-authority criteria.

function cseSectorFilterIsEnabled() {
  return Boolean(document.getElementById("cseToggle")?.checked) && typeof window.cseVisibleRows === "function";
}

function cseSectorVisibleAuthorityCodes() {
  if (!cseSectorFilterIsEnabled()) return null;
  return new Set(window.cseVisibleRows().map((row) => row.local_authority_code).filter(Boolean));
}

function cseSectorRowMatches(row, visibleAuthorityCodes) {
  if (!visibleAuthorityCodes) return true;

  const details = Array.isArray(row.full_postcodes_detail) ? row.full_postcodes_detail : [];
  if (details.length) {
    return details.some((detail) => visibleAuthorityCodes.has(detail.local_authority_code));
  }

  return String(row.local_authority_code || "")
    .split(";")
    .map((code) => code.trim())
    .some((code) => visibleAuthorityCodes.has(code));
}

(function initialiseCseSectorFiltering() {
  const originalGetFilteredSectors = window.getFilteredSectors;

  if (typeof originalGetFilteredSectors === "function") {
    window.getFilteredSectors = function cseAwareGetFilteredSectors() {
      const rows = originalGetFilteredSectors();
      const visibleAuthorityCodes = cseSectorVisibleAuthorityCodes();
      if (!visibleAuthorityCodes) return rows;
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
