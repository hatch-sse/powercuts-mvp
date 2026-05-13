const CSE_BOUNDARY_FILE = "data/local-authorities-uk-2024-wgs84-web.geojson";
const CSE_DATA_FILE = "data/cse-local-authority-psr.json";

const cseState = {
  boundaries: null,
  rowsByCode: new Map(),
  layer: null,
  enabled: false,
};

const cseNeedLabels = {
  overall: "Overall",
  over_65: "Over 65",
  disability: "Disability",
  child_under_5: "Child under 5",
  no_english: "No English",
  partial_sight: "Partial sight",
  blind: "Blind",
  hearing_impaired: "Hearing impaired",
  dementia: "Dementia",
  mental_health: "Mental health",
};

const cseMetricLabels = {
  psr_reach: "PSR reach",
  psr_records: "PSR records",
  eligibility_estimate: "Eligibility estimate",
};

function cseNum(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function cseFmt(value) {
  return Math.round(cseNum(value)).toLocaleString("en-GB");
}

function csePct(value) {
  return cseNum(value).toLocaleString("en-GB", {
    style: "percent",
    maximumFractionDigits: 1,
  });
}

function cseMetricValue(row) {
  const need = document.getElementById("cseNeedSelect")?.value || "overall";
  const metric = document.getElementById("cseMetricSelect")?.value || "psr_reach";
  return row?.needs?.[need]?.[metric];
}

function cseMetricDisplay(value) {
  const metric = document.getElementById("cseMetricSelect")?.value || "psr_reach";
  return metric === "psr_reach" ? csePct(value) : cseFmt(value);
}

function cseColourFor(value, maxValue) {
  const metric = document.getElementById("cseMetricSelect")?.value || "psr_reach";

  if (metric === "psr_reach") {
    const capped = Math.max(0, Math.min(1, cseNum(value)));
    const t = 1 - capped;
    const r = Math.round(210 + 30 * t);
    const g = Math.round(242 - 125 * t);
    const b = Math.round(240 - 165 * t);
    return `rgb(${r},${g},${b})`;
  }

  const max = cseNum(maxValue) || 1;
  const t = Math.max(0, Math.min(1, Math.log10(cseNum(value) + 1) / Math.log10(max + 1)));
  const r = Math.round(210 - 150 * t);
  const g = Math.round(242 - 105 * t);
  const b = Math.round(240 - 80 * t);
  return `rgb(${r},${g},${b})`;
}

function cseVisibleRows() {
  const need = document.getElementById("cseNeedSelect")?.value || "overall";
  const threshold = document.getElementById("cseReachThreshold")?.value || "ALL";
  const search = String(document.getElementById("cseCouncilSearch")?.value || "").trim().toLowerCase();
  const powercutOnly = document.getElementById("csePowercutOnly")?.checked || false;
  const sectors = state.currentSectors || [];
  const sectorAuthorityNames = new Set(
    sectors
      .map((row) => String(row.local_authority_name || row.local_authority || row.council_area || "").toLowerCase())
      .filter(Boolean)
  );

  return [...cseState.rowsByCode.values()].filter((row) => {
    if (!row?.needs?.[need]) return false;
    if (search && !String(row.local_authority_name || "").toLowerCase().includes(search)) return false;
    if (threshold !== "ALL" && cseNum(row.needs[need].psr_reach) > Number(threshold)) return false;

    // If the outage data does not carry local authority names yet, keep areas visible rather than hiding everything.
    if (powercutOnly && sectorAuthorityNames.size && !sectorAuthorityNames.has(String(row.local_authority_name || "").toLowerCase())) {
      return false;
    }

    return true;
  });
}

function cseVisibleCodes() {
  return new Set(cseVisibleRows().map((row) => row.local_authority_code));
}

function updateCseSummary() {
  const summary = document.getElementById("cseSummary");
  if (!summary) return;

  const rows = cseVisibleRows();
  const need = document.getElementById("cseNeedSelect")?.value || "overall";
  const metric = document.getElementById("cseMetricSelect")?.value || "psr_reach";

  if (!cseState.enabled) {
    summary.textContent = "Switch on PSR CSE data to show local authority reach and campaign priority.";
    return;
  }

  const lowReach = rows.filter((row) => cseNum(row.needs?.[need]?.psr_reach) < 0.75).length;
  summary.textContent = `${rows.length.toLocaleString("en-GB")} local authorities shown. ${lowReach.toLocaleString("en-GB")} have ${cseNeedLabels[need]} PSR reach below 75%. Current colour: ${cseMetricLabels[metric]}.`;
}

async function ensureCseDataLoaded() {
  if (cseState.boundaries && cseState.rowsByCode.size) return;

  const [boundaryResponse, dataResponse] = await Promise.all([
    fetch(CSE_BOUNDARY_FILE, { cache: "no-store" }),
    fetch(CSE_DATA_FILE, { cache: "no-store" }),
  ]);

  if (!boundaryResponse.ok) throw new Error(`Failed to load ${CSE_BOUNDARY_FILE}`);
  if (!dataResponse.ok) throw new Error(`Failed to load ${CSE_DATA_FILE}`);

  cseState.boundaries = await boundaryResponse.json();
  const cseData = await dataResponse.json();
  cseState.rowsByCode = new Map((cseData.rows || []).map((row) => [row.local_authority_code, row]));
}

function showCseControls(show) {
  document.querySelectorAll(".cse-controls").forEach((element) => {
    element.hidden = !show;
    element.setAttribute("aria-hidden", show ? "false" : "true");
  });
}

function csePopupHtml(row) {
  const need = document.getElementById("cseNeedSelect")?.value || "overall";
  const metric = document.getElementById("cseMetricSelect")?.value || "psr_reach";
  const values = row.needs?.[need] || {};
  const overall = row.needs?.overall || {};

  return `
    <strong>${row.local_authority_name}</strong><br/>
    Need group: ${cseNeedLabels[need]}<br/>
    ${cseMetricLabels[metric]}: ${cseMetricDisplay(values[metric])}<br/>
    PSR records: ${cseFmt(values.psr_records)}<br/>
    Eligibility estimate: ${cseFmt(values.eligibility_estimate)}<br/>
    PSR reach: ${csePct(values.psr_reach)}<br/>
    <br/>Overall PSR reach: ${csePct(overall.psr_reach)}
  `;
}

function drawCseLayer() {
  if (cseState.layer) {
    cseState.layer.remove();
    cseState.layer = null;
  }

  if (!cseState.enabled || !cseState.boundaries || !state.map) {
    updateCseSummary();
    return;
  }

  const visibleCodes = cseVisibleCodes();
  const metricValues = cseVisibleRows().map(cseMetricValue);
  const maxValue = Math.max(...metricValues.map(cseNum), 0);

  cseState.layer = L.geoJSON(cseState.boundaries, {
    filter: (feature) => visibleCodes.has(feature?.properties?.LAD24CD),
    style: (feature) => {
      const row = cseState.rowsByCode.get(feature?.properties?.LAD24CD);
      const value = cseMetricValue(row);
      return {
        color: "#ffffff",
        weight: 1.2,
        opacity: 0.9,
        fillColor: cseColourFor(value, maxValue),
        fillOpacity: 0.55,
      };
    },
    onEachFeature: (feature, layer) => {
      const row = cseState.rowsByCode.get(feature?.properties?.LAD24CD);
      if (!row) return;
      layer.bindPopup(csePopupHtml(row));
      layer.on("click", () => {
        const detail = document.getElementById("sectorDetail");
        if (detail) detail.innerHTML = csePopupHtml(row);
      });
    },
  }).addTo(state.map);

  if (state.layer) state.layer.bringToFront();
  if (state.licenceLayer) state.licenceLayer.bringToFront();
  updateCseSummary();
}

function cseCsvEscape(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function downloadCseCsv(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function buildCseAuthoritiesCsv() {
  const need = document.getElementById("cseNeedSelect")?.value || "overall";
  const headers = [
    "local_authority_code",
    "local_authority_name",
    "need_group",
    "psr_records",
    "eligibility_estimate",
    "psr_reach",
    "proportion_of_la_in_dno",
  ];

  const rows = cseVisibleRows().map((row) => {
    const values = row.needs?.[need] || {};
    return [
      row.local_authority_code,
      row.local_authority_name,
      need,
      values.psr_records,
      values.eligibility_estimate,
      values.psr_reach,
      row.proportion_of_la_in_dno,
    ].map(cseCsvEscape).join(",");
  });

  return [headers.join(","), ...rows].join("\n");
}

function buildCseCampaignCsv() {
  const need = document.getElementById("cseNeedSelect")?.value || "overall";
  const rowsBySector = state.currentSectors || [];
  const cseRows = cseVisibleRows();
  const headers = [
    "postcode_sector",
    "network",
    "outage_count",
    "full_postcodes",
    "local_authority_code",
    "local_authority_name",
    "need_group",
    "psr_reach",
    "psr_records",
    "eligibility_estimate",
  ];

  const rows = [];

  // The current outage dataset is postcode-sector based. Until sectors are tagged with LAD codes,
  // include visible sector export rows plus the selected CSE context for planning.
  for (const sector of rowsBySector) {
    for (const cseRow of cseRows) {
      const values = cseRow.needs?.[need] || {};
      rows.push([
        sector.postcode_sector,
        sector.network,
        sector.outage_count,
        (sector.full_postcodes || []).join("; "),
        cseRow.local_authority_code,
        cseRow.local_authority_name,
        need,
        values.psr_reach,
        values.psr_records,
        values.eligibility_estimate,
      ].map(cseCsvEscape).join(","));
    }
  }

  return [headers.join(","), ...rows].join("\n");
}

function setupCseControls() {
  document.getElementById("cseToggle")?.addEventListener("change", async (event) => {
    cseState.enabled = event.currentTarget.checked;
    showCseControls(cseState.enabled);

    if (cseState.enabled) {
      try {
        await ensureCseDataLoaded();
      } catch (error) {
        console.error(error);
        const summary = document.getElementById("cseSummary");
        if (summary) summary.textContent = "Unable to load PSR CSE data files.";
        return;
      }
    }

    drawCseLayer();
  });

  ["cseNeedSelect", "cseMetricSelect", "cseReachThreshold", "cseCouncilSearch", "csePowercutOnly"].forEach((id) => {
    const element = document.getElementById(id);
    if (!element) return;
    element.addEventListener("change", drawCseLayer);
    element.addEventListener("input", drawCseLayer);
  });

  document.getElementById("downloadCseAuthoritiesBtn")?.addEventListener("click", () => {
    downloadCseCsv("psr-cse-local-authorities.csv", buildCseAuthoritiesCsv());
  });

  document.getElementById("downloadCseCampaignBtn")?.addEventListener("click", () => {
    downloadCseCsv("psr-cse-combined-campaign-planning.csv", buildCseCampaignCsv());
  });
}

(function initialiseCseLayer() {
  const originalUpdateAll = window.updateAll;

  if (typeof originalUpdateAll === "function") {
    window.updateAll = function wrappedCseUpdateAll() {
      originalUpdateAll();
      drawCseLayer();
    };
  }

  document.addEventListener("DOMContentLoaded", () => {
    setupCseControls();
    showCseControls(false);
  });
})();
