const DATA_BASE = "data/";

const state = { payload: null, map: null, layer: null };

const metricLabels = {
  outage_count: "Outages",
  total_customers_affected: "Customers affected",
  time_off_supply_hours_total_approx: "Time off supply (hours, approx.)",
};

const metricDescriptions = {
  outage_count: "Colour shows total outage count.",
  total_customers_affected: "Colour shows total customers affected.",
  time_off_supply_hours_total_approx: "Colour shows approximate total time off supply in hours.",
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fmt(v) {
  return Math.round(num(v)).toLocaleString("en-GB");
}

function fmtHours(v) {
  return num(v).toLocaleString("en-GB", { maximumFractionDigits: 1 });
}

function selectedNetwork() {
  return document.getElementById("networkSelect").value;
}

function selectedMetric() {
  return document.getElementById("metricSelect").value;
}

function parseWktPolygon(wkt) {
  if (!wkt || !wkt.startsWith("POLYGON")) return [];
  const body = wkt.replace(/^POLYGON\s*\(\(/i, "").replace(/\)\)\s*$/i, "");
  return body.split(",").map(pair => {
    const [lon, lat] = pair.trim().split(/\s+/).map(Number);
    return [lat, lon];
  }).filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
}

function getFilteredAreas() {
  const network = selectedNetwork();
  return (state.payload?.areas || []).filter(row => network === "ALL" || row.network === network);
}

function getFilteredSectors() {
  const network = selectedNetwork();
  return (state.payload?.sectors || []).filter(row => network === "ALL" || row.network === network);
}

function colourFor(value, maxValue) {
  const v = Math.log10(num(value) + 1);
  const max = Math.log10(num(maxValue) + 1) || 1;
  const t = Math.max(0, Math.min(1, v / max));
  const r = Math.round(255 - (45 * t));
  const g = Math.round(235 - (185 * t));
  const b = Math.round(180 - (155 * t));
  return `rgb(${r},${g},${b})`;
}

function updateCards() {
  const areas = getFilteredAreas();
  const sectors = getFilteredSectors();

  const totalOutages = sectors.reduce((s, r) => s + num(r.outage_count), 0);
  const customers = sectors.reduce((s, r) => s + num(r.total_customers_affected), 0);
  const hours = sectors.reduce((s, r) => s + num(r.time_off_supply_hours_total_approx), 0);

  document.getElementById("areasCard").textContent = areas.length.toLocaleString("en-GB");
  document.getElementById("sectorsCard").textContent = new Set(sectors.map(r => r.postcode_sector).filter(Boolean)).size.toLocaleString("en-GB");
  document.getElementById("outagesCard").textContent = fmt(totalOutages);
  document.getElementById("customersCard").textContent = fmt(customers);
  document.getElementById("timeCard").textContent = fmtHours(hours);
}

function updateTable() {
  const metric = selectedMetric();
  const rows = getFilteredAreas()
    .filter(r => r.geometry_wkt)
    .sort((a, b) => num(b[metric]) - num(a[metric]))
    .slice(0, 15);

  document.getElementById("metricHeader").textContent = metricLabels[metric];
  document.getElementById("metricNote").textContent = metricDescriptions[metric];

  const tbody = document.getElementById("topTable");
  tbody.innerHTML = "";

  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.postcode_area}</td>
      <td>${row.network || "–"}</td>
      <td>${metric === "time_off_supply_hours_total_approx" ? fmtHours(row[metric]) : fmt(row[metric])}</td>
    `;
    tbody.appendChild(tr);
  }
}

function updateMap() {
  const metric = selectedMetric();
  const areas = getFilteredAreas().filter(r => r.geometry_wkt);
  const maxValue = Math.max(...areas.map(r => num(r[metric])), 0);

  if (state.layer) state.layer.remove();

  const group = L.featureGroup();

  for (const row of areas) {
    const latlngs = parseWktPolygon(row.geometry_wkt);
    if (!latlngs.length) continue;

    const value = num(row[metric]);
    const polygon = L.polygon(latlngs, {
      color: "#ffffff",
      weight: 0.6,
      fillColor: colourFor(value, maxValue),
      fillOpacity: value > 0 ? 0.78 : 0.08,
    });

    polygon.bindPopup(`
      <strong>${row.postcode_area}</strong><br/>
      Network: ${row.network || "–"}<br/>
      Outages: ${fmt(row.outage_count)}<br/>
      Customers affected: ${fmt(row.total_customers_affected)}<br/>
      Time off supply: ${fmtHours(row.time_off_supply_hours_total_approx)} hrs
    `);

    polygon.addTo(group);
  }

  group.addTo(state.map);
  state.layer = group;
  if (areas.length) state.map.fitBounds(group.getBounds(), { padding: [20, 20] });
}

function buildMetaList() {
  const sectors = getFilteredSectors()
    .map(r => (r.postcode_sector || "").trim().toUpperCase())
    .filter(Boolean);
  return [...new Set(sectors)].sort().join(", ");
}

async function copyMetaList() {
  const text = buildMetaList();
  document.getElementById("metaOutput").value = text;
  try {
    await navigator.clipboard.writeText(text);
    document.getElementById("copyMetaBtn").textContent = "Copied";
    setTimeout(() => document.getElementById("copyMetaBtn").textContent = "Copy sectors for Meta", 1500);
  } catch {
    document.getElementById("copyMetaBtn").textContent = "Copy failed";
  }
}

function downloadMetaList() {
  const text = buildMetaList();
  document.getElementById("metaOutput").value = text;
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "meta-postcode-sectors.txt";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function loadData() {
  const file = document.getElementById("periodSelect").value;
  const response = await fetch(DATA_BASE + file, { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to load ${file}`);
  state.payload = await response.json();

  document.getElementById("sourceNote").textContent =
    `${state.payload.label}. Data is aggregated to the mapping file geography. Time off supply is approximate.`;

  updateAll();
}

function updateAll() {
  updateCards();
  updateTable();
  updateMap();
}

function initMap() {
  state.map = L.map("map", { zoomControl: true }).setView([55.4, -3.2], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 12,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(state.map);
}

document.addEventListener("DOMContentLoaded", async () => {
  initMap();
  document.getElementById("periodSelect").addEventListener("change", loadData);
  document.getElementById("networkSelect").addEventListener("change", updateAll);
  document.getElementById("metricSelect").addEventListener("change", updateAll);
  document.getElementById("copyMetaBtn").addEventListener("click", copyMetaList);
  document.getElementById("downloadMetaBtn").addEventListener("click", downloadMetaList);
  await loadData();
});
