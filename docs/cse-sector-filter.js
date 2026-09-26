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
  // An empty set means no matches; only null means filtering is disabled.
  return new Set(window.cseVisibleRows().map((row) => row.local_authority_code).filter(Boolean));
}

function cseFilterSectorPostcodes(rows, visibleAuthorityCodes) {
  if (visibleAuthorityCodes === null) return rows;

  // Intersect after all outage thresholds, ranking and Top N limits. Never
  // refill excluded sectors or expand a sector from an authority-wide lookup.
  return rows.flatMap((row) => {
    const details = campaignPostcodeDetails(row).filter((detail) =>
      visibleAuthorityCodes.has(detail.local_authority_code)
    );
    if (!details.length) return [];
    return [{
      ...row,
      full_postcodes: campaignUnique(details.map((detail) => detail.postcode)),
      full_postcodes_detail: details,
      local_authority_code: campaignUnique(details.map((detail) => detail.local_authority_code)).join("; "),
      local_authority_name: campaignUnique(details.map((detail) => detail.local_authority_name)).join("; "),
    }];
  });
}

(function initialiseCseSectorFiltering() {
  const originalGetFilteredSectors = window.getFilteredSectors;

  if (typeof originalGetFilteredSectors === "function") {
    window.getFilteredSectors = function cseAwareGetFilteredSectors() {
      const rows = originalGetFilteredSectors();
      const visibleAuthorityCodes = cseSectorVisibleAuthorityCodes();

      return cseFilterSectorPostcodes(rows, visibleAuthorityCodes);
    };
  }

  function refreshPowercutSectorsAfterCseChange() {
    if (typeof window.updateAll === "function") {
      window.updateAll();
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    ["cseToggle", "cseFilterPowercuts", "cseNeedSelect", "cseReachThreshold", "cseCouncilSearch", "csePowercutOnly"].forEach((id) => {
      const element = document.getElementById(id);
      if (!element) return;

      element.addEventListener("change", refreshPowercutSectorsAfterCseChange);
      element.addEventListener("input", refreshPowercutSectorsAfterCseChange);
    });
  });
})();
