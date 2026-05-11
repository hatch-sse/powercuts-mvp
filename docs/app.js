const DATA_BASE = "data/";
const DATA_FILE = "dashboard_rolling_12m.json";

const state = {
  payload: null,
  map: null,
  layer: null,
  licenceLayer: null,
  boundaryBySector: new Map(),
  currentSectors: [],
};

const metricLabels = {
  outage_count: "Outages",
  total_customers_affected: "Customers affected",
  time_off_supply_hours_total_approx: "Total time off supply (hours, approx.)",
};

const metricDescriptions = {
  outage_count: "Colour shows distinct outage count by postcode sector for the selected date range.",
  total_customers_affected: "Colour shows total customers affected by postcode sector for the selected date range.",
  time_off_supply_hours_total_approx:
    "Colour shows approximate total time off supply in hours by postcode sector for the selected date range.",
};

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function fmt(value) {
  return Math.round(num(value)).toLocaleString("en-GB");
}

function fmtHours(value) {
  return num(value).toLocaleString("en-GB", { maximumFractionDigits: 1 });
}

function selectedNetwork() {
  return document.getElementById("networkSelect").value;
}

function selectedMetric() {
  return document.getElementById("metricSelect").value;
}

function selectedHotspotLimit() {
  return document.getElementById("hotspotLimit")?.value || "ALL";
}

function selectedOutageType() {
  return document.getElementById("outageTypeSelect")?.value || "ALL";
}

function thresholdValue(id) {
  return num(document.getElementById(id)?.value || 0);
}

function normalisePostcode(value) {
  const compact = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact.length <= 3) return compact;
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

function compact(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function postcodeToSector(postcode) {
  const cleaned = normalisePostcode(postcode);
  const parts = cleaned.split(" ");
  if (parts.length !== 2 || !parts[1]) return "";
  return `${parts[0]} ${parts[1][0]}`;
}

function parseDateOnly(value) {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function toDateInputValue(date) {
  return date.toISOString().slice(0, 10);
}

function formatDateUK(date) {
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatDateTimeUK(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function clampDate(date, minDate, maxDate) {
  if (date < minDate) return minDate;
  if (date > maxDate) return maxDate;
  return date;
}

function eventOverlapsRange(event, startDate, endDateExclusive) {
  const firstSeen = new Date(event.first_seen);
  const lastSeen = new Date(event.last_seen);
  if (Number.isNaN(firstSeen.getTime()) || Number.isNaN(lastSeen.getTime())) return false;
  return firstSeen < endDateExclusive && lastSeen >= startDate;
}

function eventMatchesOutageType(event) {
  const type = selectedOutageType();
  if (type === "ALL") return true;
  return String(event.outage_type || "")
    .toUpperCase()
    .split(",")
    .map((part) => part.trim())
    .includes(type);
}

function getDateRange() {
  const minDate = parseDateOnly(state.payload?.available_start);
  const maxDate = parseDateOnly(state.payload?.available_end);
  let startDate = parseDateOnly(document.getElementById("startDate").value);
  let endDate = parseDateOnly(document.getElementById("endDate").value);

  if (!minDate || !maxDate) {
    const today = new Date();
    return {
      startDate: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 30)),
      endDate,
      endDateExclusive: addDays(today, 1),
    };
  }

  startDate = startDate || addDays(maxDate, -30);
  endDate = endDate || maxDate;
  startDate = clampDate(startDate, minDate, maxDate);
  endDate = clampDate(endDate, minDate, maxDate);

  if (startDate > endDate) {
    const temp = startDate;
    startDate = endDate;
    endDate = temp;
  }

  return { startDate, endDate, endDateExclusive: addDays(endDate, 1) };
}

function getFilteredEvents() {
  const network = selectedNetwork();
  const events = state.payload?.events || [];
  const { startDate, endDateExclusive } = getDateRange();

  return events.filter((event) => {
    if (!event.postcode_sector) return false;
    if (!state.boundaryBySector.has(event.postcode_sector)) return false;
    if (network !== "ALL" && event.network !== network) return false;
    if (!eventMatchesOutageType(event)) return false;
    return eventOverlapsRange(event, startDate, endDateExclusive);
  });
}

function aggregateEventsToSectors(events) {
  const grouped = new Map();

  for (const event of events) {
    const key = `${event.postcode_sector}|${event.network}`;

    if (!grouped.has(key)) {
      grouped.set(key, {
        postcode_sector: event.postcode_sector,
        network: event.network,
        outage_type_set: new Set(),
        outage_ids: new Set(),
        postcodes_set: new Set(),
        total_customers_affected: 0,
        time_off_supply_hours_total_approx: 0,
        first_seen: event.first_seen,
        last_seen: event.last_seen,
        geometry: state.boundaryBySector.get(event.postcode_sector)?.geometry,
      });
    }

    const row = grouped.get(key);
    row.outage_ids.add(event.outage_id);
    for (const postcode of event.postcodes || []) row.postcodes_set.add(normalisePostcode(postcode));
    row.total_customers_affected += num(event.total_customers_affected);
    row.time_off_supply_hours_total_approx += num(event.time_off_supply_hours_total_approx);
    if (event.first_seen && (!row.first_seen || event.first_seen < row.first_seen)) row.first_seen = event.first_seen;
    if (event.last_seen && (!row.last_seen || event.last_seen > row.last_seen)) row.last_seen = event.last_seen;

    for (const part of String(event.outage_type || "").split(",")) {
      const clean = part.trim();
      if (clean) row.outage_type_set.add(clean);
    }
  }

  return [...grouped.values()].map((row) => ({
    postcode_sector: row.postcode_sector,
    network: row.network,
    outage_type: [...row.outage_type_set].sort().join(","),
    outage_refs: [...row.outage_ids].sort(),
    full_postcodes: [...row.postcodes_set].sort(),
    outage_count: row.outage_ids.size,
    total_customers_affected: row.total_customers_affected,
    time_off_supply_hours_total_approx: row.time_off_supply_hours_total_approx,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    geometry: row.geometry,
  }));
}

function passesThresholds(row) {
  return (
    num(row.outage_count) >= thresholdValue("minOutages") &&
    num(row.total_customers_affected) >= thresholdValue("minCustomers") &&
    num(row.time_off_supply_hours_total_approx) >= thresholdValue("minHours")
  );
}

function getFilteredSectors() {
  const metric = selectedMetric();
  let rows = aggregateEventsToSectors(getFilteredEvents()).filter(passesThresholds);
  rows = rows.sort((a, b) => num(b[metric]) - num(a[metric]));
  const limit = selectedHotspotLimit();
  if (limit !== "ALL") rows = rows.slice(0, Number(limit));
  return rows;
}

function colourFor(value, maxValue) {
  const v = Math.log10(num(value) + 1);
  const max = Math.log10(num(maxValue) + 1) || 1;
  const t = Math.max(0, Math.min(1, v / max));
  const r = Math.round(210 - 185 * t);
  const g = Math.round(242 - 160 * t);
  const b = Math.round(240 - 95 * t);
  return `rgb(${r},${g},${b})`;
}

function truncateList(values, limit = 80) {
  const list = [...new Set(values.filter(Boolean))].sort();
  if (!list.length) return "–";
  const shown = list.slice(0, limit).join(", ");
  return list.length > limit ? `${shown}, … plus ${list.length - limit} more` : shown;
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const old = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = old), 1500);
  } catch {
    button.textContent = "Copy failed";
  }
}

function updateCards() {
  const sectors = state.currentSectors;
  const totalOutages = sectors.reduce((sum, row) => sum + num(row.outage_count), 0);
  const customers = sectors.reduce((sum, row) => sum + num(row.total_customers_affected), 0);
  const hours = sectors.reduce((sum, row) => sum + num(row.time_off_supply_hours_total_approx), 0);

  document.getElementById("areasCard").textContent = sectors.length.toLocaleString("en-GB");
  document.getElementById("sectorsCard").textContent = new Set(sectors.map((row) => row.postcode_sector).filter(Boolean)).size.toLocaleString("en-GB");
  document.getElementById("outagesCard").textContent = fmt(totalOutages);
  document.getElementById("customersCard").textContent = fmt(customers);
  document.getElementById("timeCard").textContent = fmtHours(hours);
}

function updateTable() {
  const metric = selectedMetric();
  const rows = state.currentSectors.filter((row) => num(row[metric]) > 0).slice(0, 20);

  document.getElementById("metricHeader").textContent = metricLabels[metric];
  document.getElementById("metricNote").textContent = metricDescriptions[metric];
  document.getElementById("legendTitle").textContent = metricLabels[metric];

  const tbody = document.getElementById("topTable");
  tbody.innerHTML = "";

  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.postcode_sector}</td>
      <td>${row.network || "–"}</td>
      <td>${metric === "time_off_supply_hours_total_approx" ? fmtHours(row[metric]) : fmt(row[metric])}</td>
    `;
    tbody.appendChild(tr);
  }
}

function showSectorDetail(row) {
  const postcodes = row.full_postcodes || [];
  const refs = row.outage_refs || [];
  document.getElementById("sectorDetail").innerHTML = `
    <strong>${row.postcode_sector}</strong><br/>
    Network: ${row.network || "–"}<br/>
    Power cut type: ${row.outage_type || "–"}<br/>
    Outages: ${fmt(row.outage_count)}<br/>
    Customers affected: ${fmt(row.total_customers_affected)}<br/>
    Total time off supply: ${fmtHours(row.time_off_supply_hours_total_approx)} hrs<br/>
    First outage in period: ${formatDateTimeUK(row.first_seen)}<br/>
    Most recent outage: ${formatDateTimeUK(row.last_seen)}<br/>
    Meta targeting sector: ${row.postcode_sector}<br/>
    <br/><strong>Power cut references (${fmt(refs.length)})</strong><br/>
    <span class="wrap-list">${truncateList(refs)}</span><br/>
    <button class="secondary small inline-copy" id="copyRefsBtn">Copy references</button><br/>
    <br/><strong>Full postcodes recorded (${fmt(postcodes.length)})</strong><br/>
    <span class="wrap-list">${truncateList(postcodes)}</span><br/>
    <button class="secondary small inline-copy" id="copyPostcodesBtn">Copy full postcodes</button>
  `;

  document.getElementById("copyRefsBtn")?.addEventListener("click", (event) => copyText(refs.join(", "), event.currentTarget));
  document.getElementById("copyPostcodesBtn")?.addEventListener("click", (event) => copyText(postcodes.join(", "), event.currentTarget));
}

function updateEmptyState(sectors) {
  const empty = document.getElementById("emptyState");
  if (sectors.length) {
    empty.hidden = true;
    empty.textContent = "";
    return;
  }
  const { startDate, endDate } = getDateRange();
  empty.hidden = false;
  empty.textContent = `No outages found for ${selectedNetwork()} between ${formatDateUK(startDate)} and ${formatDateUK(endDate)}. Try widening the date range or lowering the thresholds.`;
}

function drawLicenceBoundary() {
  if (state.licenceLayer) state.licenceLayer.remove();
  const selected = selectedNetwork();
  const features = (state.payload?.licence_boundaries || []).filter((feature) => {
    const network = feature?.properties?.network;
    return selected === "ALL" || network === selected;
  });
  if (!features.length) return;

  state.licenceLayer = L.geoJSON({ type: "FeatureCollection", features }, {
    style: {
      color: "#f28c28",
      weight: 3,
      opacity: 0.95,
      fillOpacity: 0,
      dashArray: "8 6",
      interactive: false,
    },
  }).addTo(state.map);
  state.licenceLayer.bringToFront();
}

function updateMap() {
  const metric = selectedMetric();
  const sectors = state.currentSectors.filter((row) => num(row[metric]) > 0 && row.geometry);
  const maxValue = Math.max(...sectors.map((row) => num(row[metric])), 0);

  if (state.layer) state.layer.remove();
  const group = L.featureGroup();

  for (const row of sectors) {
    const colour = colourFor(row[metric], maxValue);
    const feature = { type: "Feature", properties: { postcode_sector: row.postcode_sector }, geometry: row.geometry };

    const layer = L.geoJSON(feature, {
      style: { color: "#003865", weight: 0.9, fillColor: colour, fillOpacity: 0.75 },
      onEachFeature: function (_, leafletLayer) {
        leafletLayer.on("click", () => showSectorDetail(row));
        leafletLayer.bindPopup(`<strong>${row.postcode_sector}</strong><br/>${metricLabels[metric]}: ${metric === "time_off_supply_hours_total_approx" ? fmtHours(row[metric]) : fmt(row[metric])}`);
      },
    });
    layer.addTo(group);
  }

  group.addTo(state.map);
  state.layer = group;
  drawLicenceBoundary();
  updateEmptyState(sectors);

  if (sectors.length > 0) state.map.fitBounds(group.getBounds(), { padding: [30, 30], maxZoom: 9 });
}

function buildMetaList() {
  return [...new Set(state.currentSectors.map((row) => (row.postcode_sector || "").trim().toUpperCase()).filter(Boolean))].sort().join(", ");
}

function updateMetaCount() {
  const count = new Set(state.currentSectors.map((row) => row.postcode_sector).filter(Boolean)).size;
  document.getElementById("metaCount").textContent = `${fmt(count)} postcode sectors ready for Meta Ads.`;
}

async function copyMetaList() {
  const text = buildMetaList();
  document.getElementById("metaOutput").value = text;
  await copyText(text, document.getElementById("copyMetaBtn"));
}

function downloadText(filename, text, type = "text/plain;charset=utf-8") {
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

function downloadMetaList() {
  const text = buildMetaList();
  document.getElementById("metaOutput").value = text;
  downloadText("meta-postcode-sectors.txt", text);
}

function csvEscape(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function downloadCurrentCsv() {
  const headers = ["postcode_sector", "network", "outage_type", "outage_refs", "full_postcodes", "outage_count", "total_customers_affected", "time_off_supply_hours_total_approx", "first_seen", "last_seen"];
  const rows = state.currentSectors.map((row) => headers.map((header) => csvEscape(Array.isArray(row[header]) ? row[header].join("; ") : row[header])).join(","));
  downloadText("powercut-current-view.csv", [headers.join(","), ...rows].join("\n"), "text/csv;charset=utf-8");
}

function summariseEvents(events) {
  const outageIds = new Set(events.map((event) => event.outage_id).filter(Boolean));
  const outageTypes = new Set();
  const networks = new Set();
  const postcodes = new Set();
  let customers = 0;
  let hours = 0;
  for (const event of events) {
    customers += num(event.total_customers_affected);
    hours += num(event.time_off_supply_hours_total_approx);
    if (event.network) networks.add(event.network);
    for (const postcode of event.postcodes || []) postcodes.add(normalisePostcode(postcode));
    for (const part of String(event.outage_type || "").split(",")) {
      const clean = part.trim();
      if (clean) outageTypes.add(clean);
    }
  }
  return {
    outageCount: outageIds.size,
    customers,
    hours,
    refs: [...outageIds].sort(),
    postcodes: [...postcodes].sort(),
    networks: [...networks].sort().join(", ") || "–",
    outageTypes: [...outageTypes].sort().join(", ") || "–",
  };
}

function eventHasExactPostcode(event, postcode) {
  return (event.postcodes || []).some((candidate) => normalisePostcode(candidate) === postcode);
}

function eventMatchesSearch(event, query) {
  const q = compact(query);
  if (!q) return false;
  const sector = compact(event.postcode_sector);
  const ref = compact(event.outage_id);
  if (ref.includes(q)) return true;
  if (sector.includes(q) || q.startsWith(sector) || sector.startsWith(q)) return true;
  return (event.postcodes || []).some((postcode) => compact(postcode).includes(q) || q.includes(compact(postcode)));
}

function handleSearch() {
  const input = document.getElementById("postcodeSearch");
  const result = document.getElementById("postcodeResult");
  const raw = String(input.value || "").trim();
  const q = compact(raw);

  if (!q) {
    result.innerHTML = "Enter a postcode or reference to search the selected date range.";
    return;
  }

  const events = getFilteredEvents();
  const matchedEvents = events.filter((event) => eventMatchesSearch(event, raw));

  if (!matchedEvents.length) {
    result.innerHTML = `<strong>${raw.toUpperCase()}</strong><br/>No matching outage history found in the selected date range, network and power cut type filters.`;
    return;
  }

  const summary = summariseEvents(matchedEvents);
  const exactPostcode = normalisePostcode(raw);
  const hasExact = exactPostcode.includes(" ") && matchedEvents.some((event) => eventHasExactPostcode(event, exactPostcode));
  const sectors = [...new Set(matchedEvents.map((event) => event.postcode_sector).filter(Boolean))].sort();

  result.innerHTML = `
    <strong>${raw.toUpperCase()}</strong><br/>
    ${hasExact ? "Exact postcode match found." : "Matched by postcode, postcode sector, partial postcode, or power cut reference."}<br/>
    Matching sectors: ${truncateList(sectors, 30)}<br/>
    Network: ${summary.networks}<br/>
    Power cut type: ${summary.outageTypes}<br/>
    Outages: ${fmt(summary.outageCount)}<br/>
    Customers affected: ${fmt(summary.customers)}<br/>
    Approx. total time off supply: ${fmtHours(summary.hours)} hrs<br/>
    Power cut references (${fmt(summary.refs.length)}): <span class="wrap-list">${truncateList(summary.refs, 50)}</span><br/>
    Full postcodes recorded (${fmt(summary.postcodes.length)}): <span class="wrap-list">${truncateList(summary.postcodes, 80)}</span><br/>
    <button class="secondary small inline-copy" id="copySearchRefsBtn">Copy references</button>
    <button class="secondary small inline-copy" id="copySearchPostcodesBtn">Copy full postcodes</button>
  `;

  document.getElementById("copySearchRefsBtn")?.addEventListener("click", (event) => copyText(summary.refs.join(", "), event.currentTarget));
  document.getElementById("copySearchPostcodesBtn")?.addEventListener("click", (event) => copyText(summary.postcodes.join(", "), event.currentTarget));
}

function setQuickRange(range) {
  const minDate = parseDateOnly(state.payload?.available_start);
  const maxDate = parseDateOnly(state.payload?.available_end);
  if (!minDate || !maxDate) return;
  let startDate;
  const endDate = maxDate;
  if (range === "ytd") startDate = new Date(Date.UTC(endDate.getUTCFullYear(), 0, 1));
  else startDate = addDays(endDate, -Number(range) + 1);
  startDate = clampDate(startDate, minDate, maxDate);
  document.getElementById("startDate").value = toDateInputValue(startDate);
  document.getElementById("endDate").value = toDateInputValue(endDate);
  updateAll();
}

function initialiseDateInputs() {
  const minDate = parseDateOnly(state.payload?.available_start);
  const maxDate = parseDateOnly(state.payload?.available_end);
  if (!minDate || !maxDate) return;
  const startInput = document.getElementById("startDate");
  const endInput = document.getElementById("endDate");
  startInput.min = toDateInputValue(minDate);
  startInput.max = toDateInputValue(maxDate);
  endInput.min = toDateInputValue(minDate);
  endInput.max = toDateInputValue(maxDate);
  startInput.value = toDateInputValue(clampDate(addDays(maxDate, -29), minDate, maxDate));
  endInput.value = toDateInputValue(maxDate);
  document.getElementById("dateRangeNote").textContent = `Available data: ${formatDateUK(minDate)} to ${formatDateUK(maxDate)}. Date filtering is limited to the rolling ${state.payload.rolling_days || 365} days.`;
}

async function loadData() {
  const response = await fetch(DATA_BASE + DATA_FILE, { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to load ${DATA_FILE}`);
  state.payload = await response.json();
  state.boundaryBySector = new Map((state.payload.boundaries || []).map((boundary) => [boundary.postcode_sector, boundary]));
  initialiseDateInputs();
  document.getElementById("freshnessNote").textContent = `Last updated: ${formatDateTimeUK(state.payload.generated_at)}`;
  document.getElementById("sourceNote").textContent = `${state.payload.label}. Dashboard is mapped at postcode sector level. Only sectors within SSEN SHEPD/SEPD licence areas are included. Orange dashed line shows the licence-area boundary generated from the postcode-sector boundary file. Total time off supply is approximate.`;
  updateAll();
}

function updateAll() {
  state.currentSectors = getFilteredSectors();
  updateCards();
  updateTable();
  updateMap();
  updateMetaCount();
  const lookupValue = document.getElementById("postcodeSearch")?.value;
  if (lookupValue) handleSearch();
}

function initMap() {
  state.map = L.map("map", { zoomControl: true }).setView([55.4, -3.2], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 12,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(state.map);
}

document.addEventListener("DOMContentLoaded", async () => {
  initMap();
  ["startDate", "endDate", "networkSelect", "metricSelect", "hotspotLimit", "outageTypeSelect", "minOutages", "minCustomers", "minHours"].forEach((id) => {
    document.getElementById(id).addEventListener("change", updateAll);
    document.getElementById(id).addEventListener("input", updateAll);
  });
  document.getElementById("copyMetaBtn").addEventListener("click", copyMetaList);
  document.getElementById("downloadMetaBtn").addEventListener("click", downloadMetaList);
  document.getElementById("downloadCsvBtn").addEventListener("click", downloadCurrentCsv);
  document.getElementById("postcodeSearchBtn").addEventListener("click", handleSearch);
  document.getElementById("postcodeSearch").addEventListener("keydown", (event) => {
    if (event.key === "Enter") handleSearch();
  });
  document.querySelectorAll("[data-range]").forEach((button) => {
    button.addEventListener("click", () => setQuickRange(button.dataset.range));
  });
  await loadData();
});
