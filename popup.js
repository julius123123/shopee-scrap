async function refresh() {
  const {
    productsTotal = 0,
    productStatus = "Idle",
    reviewsTotal = 0,
    reviewStatus = "Idle",
  } = await chrome.storage.local.get([
    "productsTotal",
    "productStatus",
    "reviewsTotal",
    "reviewStatus",
  ]);
  document.getElementById("ptotal").textContent = productsTotal;
  document.getElementById("pstatus").textContent = productStatus;
  document.getElementById("rtotal").textContent = reviewsTotal;
  document.getElementById("rstatus").textContent = reviewStatus;
}

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

// ─────────────────────── reviews (links JSON) ───────────────────────
let batchLinks = [];

document.getElementById("linksFile").addEventListener("change", async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  const info = document.getElementById("linksInfo");
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!Array.isArray(parsed)) throw new Error("JSON must be an array of URLs");
    batchLinks = parsed.filter((u) => typeof u === "string" && u.includes("-i."));
    const { reviewDone = [] } = await chrome.storage.local.get(["reviewDone"]);
    const remaining = batchLinks.filter((l) => !reviewDone.includes(l)).length;
    info.textContent = `${batchLinks.length} links — ${remaining} remaining.`;
  } catch (e) {
    batchLinks = [];
    info.textContent = `Invalid file: ${e.message}`;
  }
});

document.getElementById("batchStart").addEventListener("click", async () => {
  if (!batchLinks.length) {
    document.getElementById("linksInfo").textContent = "Load a links JSON first.";
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const maxPages = parseInt(document.getElementById("maxReviewPages").value, 10) || 20;
  chrome.runtime.sendMessage(
    { type: "REVIEWRUN_START", links: batchLinks, tabId: tab.id, maxPages },
    (res) => {
      if (res && !res.ok) document.getElementById("linksInfo").textContent = `Not started: ${res.error}`;
    }
  );
});

document.getElementById("batchStop").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "REVIEWRUN_STOP" });
});

document.getElementById("batchReset").addEventListener("click", async () => {
  await chrome.storage.local.set({ reviewDone: [], reviewFailed: [], reviewsTotal: 0 });
  document.getElementById("linksInfo").textContent =
    `${batchLinks.length} links — ${batchLinks.length} remaining.`;
});

refresh();
setInterval(refresh, 1000);
