function cseAuthorityFilteredPowercutEvents() {
  if (typeof getFilteredEvents === "function") return getFilteredEvents();
  return state?.payload?.events || [];
}

function cseAuthorityEventPostcodeDetails(event) {
  if (typeof eventPostcodeDetails === "function") return eventPostcodeDetails(event);
  return (event.postcodes || []).map((postcode) => ({
    postcode,
    local_authority_code: event.local_authority_code || "",
    local_authority_name: event.local_authority_name || "",
  })).filter((detail) => detail.postcode);
}

function cseAuthorityPowercutPostcodes(authorityCode) {
  const rowsByPostcode = new Map();

  for (const event of cseAuthorityFilteredPowercutEvents()) {
    const details = cseAuthorityEventPostcodeDetails(event).filter((detail) => detail.local_authority_code === authorityCode);
    if (!details.length) continue;

    for (const detail of details) {
      const postcode = String(detail.postcode || "").trim().toUpperCase();
      if (!postcode) continue;

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

  return [...rowsByPostcode.values()].sort((a, b) => a.postcode.localeCompare(b.postcode));
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

  const rows = cseAuthorityPowercutPostcodes(authorityCode).map((row) => [
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

function cseEnhancePopupHtml(html, row) {
  const postcodeCount = cseAuthorityPowercutPostcodes(row.local_authority_code).length;
  return `${html}<br/>
    Power cut postcodes in current filters: ${cseEscapeHtml(cseFmt(postcodeCount))}<br/>
    <button class="secondary small cse-postcode-download" data-authority-code="${cseEscapeHtml(row.local_authority_code)}">Download power cut postcodes</button>`;
}

(function initialiseCsePostcodeDownloads() {
  if (typeof csePopupHtml === "function") {
    const originalCsePopupHtml = csePopupHtml;
    csePopupHtml = function wrappedCsePopupHtml(row) {
      return cseEnhancePopupHtml(originalCsePopupHtml(row), row);
    };
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest(".cse-postcode-download");
    if (!button) return;

    const authorityCode = button.dataset.authorityCode;
    if (!authorityCode) return;

    downloadCseCsv(cseAuthorityDownloadFilename(authorityCode), cseAuthorityPostcodeCsv(authorityCode));
  });

  document.addEventListener("DOMContentLoaded", () => {
    const powercutToggle = document.getElementById("csePowercutOnly");
    const cseToggle = document.getElementById("cseToggle");
    const powercutLabel = powercutToggle?.closest("label");

    if (powercutLabel) {
      const textNode = [...powercutLabel.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      if (textNode) textNode.textContent = " Hide power cut layer";
    }

    cseToggle?.addEventListener("change", () => {
      if (!cseToggle.checked || !powercutToggle) return;
      powercutToggle.checked = true;
      window.setTimeout(() => {
        if (typeof drawCseLayer === "function") drawCseLayer();
      }, 0);
    });
  });
})();
