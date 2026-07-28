// popup.js  —  UI for both batches: products (store URLs) and reviews (links).

async function refresh() {
  const {
    productsTotal = 0,
    productStatus = "Idle",
    reviewsTotal = 0,
    reviewStatus = "Idle",
    apiEnabled = false,
    apiSent = 0,
    apiFailed = 0,
  } = await chrome.storage.local.get([
    "productsTotal",
    "productStatus",
    "reviewsTotal",
    "reviewStatus",
    "apiEnabled",
    "apiSent",
    "apiFailed",
  ]);
  document.getElementById("ptotal").textContent = productsTotal;
  document.getElementById("pstatus").textContent = productStatus;
  document.getElementById("rtotal").textContent = reviewsTotal;
  document.getElementById("rstatus").textContent = reviewStatus;
  document.getElementById("apiStatus").textContent = apiEnabled
    ? `API: on — sent ${apiSent}, failed ${apiFailed}`
    : "API: off";
}

// ─────────────────────── API settings ───────────────────────
async function loadApiConfig() {
  const { apiUrl = "", apiEnabled = false } = await chrome.storage.local.get(["apiUrl", "apiEnabled"]);
  document.getElementById("apiUrl").value = apiUrl;
  document.getElementById("apiEnabled").checked = apiEnabled;
}

document.getElementById("apiUrl").addEventListener("input", (ev) => {
  chrome.storage.local.set({ apiUrl: ev.target.value.trim() });
});
document.getElementById("apiEnabled").addEventListener("change", (ev) => {
  chrome.storage.local.set({ apiEnabled: ev.target.checked });
});
document.getElementById("apiTest").addEventListener("click", async () => {
  const url = document.getElementById("apiUrl").value.trim();
  const el = document.getElementById("apiStatus");
  if (!url) { el.textContent = "Enter an API URL first."; return; }
  el.textContent = "Testing…";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "test", raw: {}, metadata: { platform: "shopee", ping: true } }),
    });
    el.textContent = res.ok ? `Test OK (${res.status})` : `Test failed: HTTP ${res.status}`;
  } catch (e) {
    el.textContent = `Test error: ${e.message}`;
  }
});

// ─────────────────────── products (store URLs) ───────────────────────
document.getElementById("prodStart").addEventListener("click", async () => {
  const stores = document.getElementById("storeUrls").value
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.includes("shopee.co.id/"));
  if (!stores.length) {
    document.getElementById("pstatus").textContent = "Enter at least one store URL.";
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const maxPages = parseInt(document.getElementById("maxStorePages").value, 10) || 10;
  chrome.runtime.sendMessage(
    { type: "PRODUCTRUN_START", stores, tabId: tab.id, maxPages },
    (res) => {
      if (res && !res.ok) document.getElementById("pstatus").textContent = `Not started: ${res.error}`;
    }
  );
});

document.getElementById("prodStop").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "PRODUCTRUN_STOP" });
});

document.getElementById("prodReset").addEventListener("click", async () => {
  await chrome.storage.local.set({ storeDone: [], productsTotal: 0 });
  document.getElementById("pstatus").textContent = "Progress reset.";
});

// ─────────────────────── reviews (paste or file) ───────────────────────
let batchLinks = [];
const info = () => document.getElementById("linksInfo");

// Accept a JSON array OR newline/comma-separated URLs. Keep only product URLs.
function parseLinks(text) {
  const t = (text || "").trim();
  if (!t) return [];
  let arr = null;
  try {
    const p = JSON.parse(t);
    if (Array.isArray(p)) arr = p;
  } catch (e) {}
  if (!arr) arr = t.split(/[\n,]+/);
  return arr
    .map((s) => String(s).trim().replace(/^["']|["',]+$/g, ""))
    .filter((u) => u.includes("-i."));
}

async function showRemaining() {
  const { reviewDone = [] } = await chrome.storage.local.get(["reviewDone"]);
  const remaining = batchLinks.filter((l) => !reviewDone.includes(l)).length;
  info().textContent = `${batchLinks.length} links — ${remaining} remaining.`;
}

// Paste box (primary, works on all platforms)
document.getElementById("reviewLinksText").addEventListener("input", async (ev) => {
  batchLinks = parseLinks(ev.target.value);
  if (batchLinks.length) await showRemaining();
  else info().textContent = "No valid product links detected.";
});

// File picker (fallback; may close the popup on Linux)
document.getElementById("linksFile").addEventListener("change", async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  try {
    batchLinks = parseLinks(await file.text());
    if (!batchLinks.length) throw new Error("no product links in file");
    await showRemaining();
  } catch (e) {
    batchLinks = [];
    info().textContent = `Invalid file: ${e.message}`;
  }
});

document.getElementById("batchStart").addEventListener("click", async () => {
  if (!batchLinks.length) {
    // last-chance parse in case 'input' didn't fire
    batchLinks = parseLinks(document.getElementById("reviewLinksText").value);
  }
  if (!batchLinks.length) {
    info().textContent = "Paste links (or load a file) first.";
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const maxPages = parseInt(document.getElementById("maxReviewPages").value, 10) || 20;
  chrome.runtime.sendMessage(
    { type: "REVIEWRUN_START", links: batchLinks, tabId: tab.id, maxPages },
    (res) => {
      if (res && !res.ok) info().textContent = `Not started: ${res.error}`;
    }
  );
});

document.getElementById("batchStop").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "REVIEWRUN_STOP" });
});

document.getElementById("batchReset").addEventListener("click", async () => {
  await chrome.storage.local.set({ reviewDone: [], reviewFailed: [], reviewsTotal: 0 });
  info().textContent = `${batchLinks.length} links — ${batchLinks.length} remaining.`;
});

loadApiConfig();
refresh();
setInterval(refresh, 1000);
