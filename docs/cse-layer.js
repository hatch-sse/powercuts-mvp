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

function cseReachThreshold() {
  const input = document.getElementById("cseReachThreshold");
  const raw = String(input?.value || "").trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value)) / 100;
}

function cseMetricValue(row) {
  const need = document.getElementById("cseNeedSelect")?.value || "overall";
  return row?.needs?.[need]?.psr_reach;
}

function cseMetricDisplay(value) {
  return csePct(value);
}

function cseColourFor(value) {
  const capped = Math.max(0, Math.min(1, cseNum(value)));
  const t = 1 - capped;
  const r = Math.round(210 + 30 * t);
  const g = Math.round(242 - 125 * t);
  const b = Math.round(240 - 165 * t);
  return `rgb(${r},${g},${b})`;
}

function selectedCouncilArea() {
  return document.getElementById("cseCouncilSearch")?.value || "ALL";
}

function populateCouncilDropdown() {
  const select = document.getElementById("cseCouncilSearch");
  if (!select || select.dataset.loaded === "true") return;

  const current = select.value || "ALL";
  const rows = [...cseState.rowsByCode.values()].sort((a, b) =>
    String(a.local_authority_name || "").localeCompare(String(b.local_authority_name || ""))
  );

  select.innerHTML = `<option value="ALL">All council areas</option>`;

  for (const row of rows) {
    const option = document.createElement("option");
    option.value = row.local_authority_code;
    option.textContent = row.local_authority_name;
    select.appendChild(option);
  }

  select.value = rows.some((row) => row.local_authority_code === current) ? current : "ALL";
  select.dataset.loaded = "true";
}

function cseVisibleRows() {
  const need = document.getElementById("cseNeedSelect")?.value || "overall";
  const threshold = cseReachThreshold();
  const selectedCouncil = selectedCouncilArea();

  return [...cseState.rowsByCode.values()].filter((row) => {
    if (!row?.needs?.[need]) return false;
    if (selectedCouncil !== "ALL" && row.local_authority_code !== selectedCouncil) return false;
    if (threshold !== null && cseNum(row.needs[need].psr_reach) > threshold) return false;
    return true;
  });
}

function cseVisibleCodes() {
  return new Set(cseVisibleRows().map((row) => row.local_authority_code));
}

function updateCampaignCountsAfterCseChange() {
  if (typeof window.updateCampaignExportCounts === "function") {
    window.updateCampaignExportCounts();
  }
}

function updateCseSummary() {
  const summary = document.getElementById("cseSummary");
  if (!summary) return;

  const rows = cseVisibleRows();
  const need = document.getElementById("cseNeedSelect")?.value || "overall";
  const threshold = cseReachThreshold();

  if (!cseState.enabled) {
    summary.textContent = "Switch on PSR CSE data to show local authority reach and campaign priority.";
    return;
  }

  const lowReach = rows.filter((row) => cseNum(row.needs?.[need]?.psr_reach) < 0.75).length;
  const thresholdText = threshold !== null ? ` Filtered to maximum PSR reach of ${csePct(threshold)}.` : "";
  summary.textContent = `${rows.length.toLocaleString("en-GB")} council areas shown. ${lowReach.toLocaleString("en-GB")} have ${cseNeedLabels[need]} PSR reach below 75%. Colour shows PSR reach.${thresholdText}`;
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
  populateCouncilDropdown();
}

function showCseControls(show) {
  document.querySelectorAll(".cse-controls").forEach((element) => {
    element.hidden = !show;
    element.setAttribute("aria-hidden", show ? "false" : "true");
  });
}

function csePowercutOverlapEnabled() {
  return Boolean(document.getElementById("csePowercutOnly")?.checked);
}

function updatePowercutLayerVisibility() {
  if (!state?.map) return;

  const hidePowercuts = cseState.enabled && csePowercutOverlapEnabled();

  if (state.layer) {
    if (hidePowercuts && state.map.hasLayer(state.layer)) state.layer.remove();
    if (!hidePowercuts && !state.map.hasLayer(state.layer)) state.layer.addTo(state.map);
  }

  if (state.licenceLayer) {
    if (hidePowercuts && state.map.hasLayer(state.licenceLayer)) state.licenceLayer.remove();
    if (!hidePowercuts && !state.map.hasLayer(state.licenceLayer)) state.licenceLayer.addTo(state.map);
  }
}

function csePopupHtml(row) {
  const need = document.getElementById("cseNeedSelect")?.value || "overall";
  const values = row.needs?.[need] || {};
  const overall = row.needs?.overall || {};

  return `
    <strong>${row.local_authority_name}</strong><br/>
    Needs group: ${cseNeedLabels[need]}<br/>
    PSR reach: ${cseMetricDisplay(values.psr_reach)}<br/>
    PSR records: ${cseFmt(values.psr_records)}<br/>
    Eligibility estimate: ${cseFmt(values.eligibility_estimate)}<br/>
    <br/>Overall PSR reach: ${csePct(overall.psr_reach)}
  `;
}

function drawCseLayer() {
  if (cseState.layer) {
    cseState.layer.remove();
    cseState.layer = null;
  }

  updatePowercutLayerVisibility();

  if (!cseState.enabled || !cseState.boundaries || !state.map) {
    updateCseSummary();
    updateCampaignCountsAfterCseChange();
    return;
  }

  const visibleCodes = cseVisibleCodes();

  cseState.layer = L.geoJSON(cseState.boundaries, {
    filter: (feature) => visibleCodes.has(feature?.properties?.LAD24CD),
    style: (feature) => {
      const row = cseState.rowsByCode.get(feature?.properties?.LAD24CD);
      const value = cseMetricValue(row);
      return {
        color: "#ffffff",
        weight: 1.2,
        opacity: 0.9,
        fillColor: cseColourFor(value),
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

  if (!csePowercutOverlapEnabled() && state.layer) state.layer.bringToFront();
  if (!csePowercutOverlapEnabled() && state.licenceLayer) state.licenceLayer.bringToFront();
  updateCseSummary();
  updateCampaignCountsAfterCseChange();
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
    "needs_group",
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
    "needs_group",
    "psr_reach",
    "psr_records",
    "eligibility_estimate",
  ];

  const rows = [];

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
        updateCampaignCountsAfterCseChange();
        return;
      }
    }

    drawCseLayer();
  });

  ["cseNeedSelect", "cseReachThreshold", "cseCouncilSearch", "csePowercutOnly"].forEach((id) => {
    const element = document.getElementById(id);
    if (!element) return;
    element.addEventListener("change", drawCseLayer);
    element.addEventListener("input", drawCseLayer);
  });

  document.getElementById("cseReachThreshold")?.addEventListener("input", (event) => {
    const value = String(event.currentTarget.value || "").replace(/[^0-9.]/g, "");
    event.currentTarget.value = value;
  });

  document.getElementById("downloadCseAuthoritiesBtn")?.addEventListener("click", () => {
    downloadCseCsv("psr-cse-local-authorities.csv", buildCseAuthoritiesCsv());
  });

  document.getElementById("downloadCseCampaignBtn")?.addEventListener("click", () => {
    downloadCseCsv("psr-cse-combined-campaign-planning.csv", buildCseCampaignCsv());
  });
}

(function initialiseCseLayer() {
  window.cseVisibleRows = cseVisibleRows;
  window.cseVisibleCodes = cseVisibleCodes;

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
