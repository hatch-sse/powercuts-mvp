const DATA_BASE = "data/";

const state = {
  payload: null,
  map: null,
  layer: null,
};

const metricLabels = {
  outage_count: "Outages",
  total_customers_affected: "Customers affected",
  time_off_supply_hours_total_approx: "Time off supply (hours, approx.)",
};

const metricDescriptions = {
  outage_count: "Colour shows total outage count by postcode sector.",
  total_customers_affected: "Colour shows total customers affected by postcode sector.",
  time_off_supply_hours_total_approx:
    "Colour shows approximate total time off supply in hours by postcode sector.",
};

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function fmt(value) {
  return Math.round(num(value)).toLocaleString("en-GB");
}

function fmtHours(value) {
  return num(value).toLocaleString("en-GB", {
    maximumFractionDigits: 1,
  });
}

function selectedNetwork() {
  return document.getElementById("networkSelect").value;
}

function selectedMetric() {
  return document.getElementById("metricSelect").value;
}

function getFilteredSectors() {
  const network = selectedNetwork();
  const rows = state.payload?.sectors || [];

  return rows.filter((row) => {
    if (!row.postcode_sector) return false;
    if (!row.geometry) return false;
    if (network !== "ALL" && row.network !== network) return false;
    return true;
  });
}

function colourFor(value, maxValue) {
  const v = Math.log10(num(value) + 1);
  const max = Math.log10(num(maxValue) + 1) || 1;
  const t = Math.max(0, Math.min(1, v / max));

  // SSEN-ish scale: pale cyan to deep navy
  const r = Math.round(210 - 185 * t);
  const g = Math.round(242 - 160 * t);
  const b = Math.round(240 - 95 * t);

  return `rgb(${r},${g},${b})`;
}

function geometryToLatLngs(geometry) {
  if (!geometry || !geometry.coordinates) return [];

  if (geometry.type === "Polygon") {
    return geometry.coordinates.map((ring) =>
      ring.map(([lon, lat]) => [lat, lon])
    );
  }

  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.map((polygon) =>
      polygon.map((ring) => ring.map(([lon, lat]) => [lat, lon]))
    );
  }

  return [];
}

function createGeometryLayer(row, colour) {
  const latLngs = geometryToLatLngs(row.geometry);

  if (!latLngs.length) return null;

  const options = {
    color: "#ffffff",
    weight: 0.45,
    fillColor: colour,
    fillOpacity: num(row[selectedMetric()]) > 0 ? 0.8 : 0.05,
  };

  if (row.geometry.type === "MultiPolygon") {
    return L.multiPolygon(latLngs, options);
  }

  return L.polygon(latLngs, options);
}

function updateCards() {
  const sectors = getFilteredSectors();

  const totalOutages = sectors.reduce(
    (sum, row) => sum + num(row.outage_count),
    0
  );

  const customers = sectors.reduce(
    (sum, row) => sum + num(row.total_customers_affected),
    0
  );

  const hours = sectors.reduce(
    (sum, row) => sum + num(row.time_off_supply_hours_total_approx),
    0
  );

  document.getElementById("areasCard").textContent =
    sectors.length.toLocaleString("en-GB");

  document.getElementById("sectorsCard").textContent =
    new Set(sectors.map((row) => row.postcode_sector).filter(Boolean)).size.toLocaleString("en-GB");

  document.getElementById("outagesCard").textContent = fmt(totalOutages);
  document.getElementById("customersCard").textContent = fmt(customers);
  document.getElementById("timeCard").textContent = fmtHours(hours);
}

function updateTable() {
  const metric = selectedMetric();

  const rows = getFilteredSectors()
    .sort((a, b) => num(b[metric]) - num(a[metric]))
    .slice(0, 20);

  document.getElementById("metricHeader").textContent = metricLabels[metric];
  document.getElementById("metricNote").textContent = metricDescriptions[metric];

  const tbody = document.getElementById("topTable");
  tbody.innerHTML = "";

  for (const row of rows) {
    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td>${row.postcode_sector}</td>
      <td>${row.network || "–"}</td>
      <td>${
        metric === "time_off_supply_hours_total_approx"
          ? fmtHours(row[metric])
          : fmt(row[metric])
      }</td>
    `;

    tbody.appendChild(tr);
  }
}

function updateMap() {
  const metric = selectedMetric();
  const sectors = getFilteredSectors();
  const maxValue = Math.max(...sectors.map((row) => num(row[metric])), 0);

  if (state.layer) {
    state.layer.remove();
  }

  const group = L.featureGroup();

  for (const row of sectors) {
    const value = num(row[metric]);
    const colour = colourFor(value, maxValue);
    const layer = createGeometryLayer(row, colour);

    if (!layer) continue;

    layer.bindPopup(`
      <strong>${row.postcode_sector}</strong><br/>
      Network: ${row.network || "–"}<br/>
      Outage type: ${row.outage_type || "–"}<br/>
      Outages: ${fmt(row.outage_count)}<br/>
      Customers affected: ${fmt(row.total_customers_affected)}<br/>
      Time off supply: ${fmtHours(row.time_off_supply_hours_total_approx)} hrs
    `);

    layer.addTo(group);
  }

  group.addTo(state.map);
  state.layer = group;

  if (sectors.length) {
    state.map.fitBounds(group.getBounds(), {
      padding: [20, 20],
    });
  }
}

function buildMetaList() {
  const sectors = getFilteredSectors()
    .map((row) => (row.postcode_sector || "").trim().toUpperCase())
    .filter(Boolean);

  return [...new Set(sectors)].sort().join(", ");
}

async function copyMetaList() {
  const text = buildMetaList();
  document.getElementById("metaOutput").value = text;

  try {
    await navigator.clipboard.writeText(text);
    document.getElementById("copyMetaBtn").textContent = "Copied";
    setTimeout(() => {
      document.getElementById("copyMetaBtn").textContent = "Copy sectors for Meta";
    }, 1500);
  } catch {
    document.getElementById("copyMetaBtn").textContent = "Copy failed";
  }
}

function downloadMetaList() {
  const text = buildMetaList();
  document.getElementById("metaOutput").value = text;

  const blob = new Blob([text], {
    type: "text/plain;charset=utf-8",
  });

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
  const response = await fetch(DATA_BASE + file, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Failed to load ${file}`);
  }

  state.payload = await response.json();

  document.getElementById("sourceNote").textContent =
    `${state.payload.label}. Dashboard is mapped at postcode sector level. ` +
    `Only sectors within SSEN SHEPD/SEPD licence areas are included. ` +
    `Time off supply is approximate.`;

  updateAll();
}

function updateAll() {
  updateCards();
  updateTable();
  updateMap();
}

function initMap() {
  state.map = L.map("map", {
    zoomControl: true,
  }).setView([55.4, -3.2], 6);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 12,
    attribution: "&copy; OpenStreetMap contributors",
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
