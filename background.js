const LOG = (...a) => console.log("[ShopeeScraper/bg]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── message router ─────────────────────────
let lock = Promise.resolve();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "CAPTURE") {
    lock = lock.then(() => addCapture(msg.kind, msg.data, msg.url)).catch(console.error);
  } else if (msg.type === "PRODUCTRUN_START") {
    startProductRun(msg).then((r) => sendResponse(r));
    return true;
  } else if (msg.type === "PRODUCTRUN_STOP") {
    stopProductRun().then(() => sendResponse({ ok: true }));
    return true;
  } else if (msg.type === "REVIEWRUN_START") {
    startReviewRun(msg).then((r) => sendResponse(r));
    return true;
  } else if (msg.type === "REVIEWRUN_STOP") {
    stopReviewRun().then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ───────────────────────── capture + dedupe ───────────────────────
function idsFromRatingsUrl(url) {
  try {
    const q = new URL(url, "https://shopee.co.id").searchParams;
    return { itemid: q.get("itemid"), shopid: q.get("shopid") };
  } catch {
    return { itemid: null, shopid: null };
  }
}

async function addCapture(kind, data, url) {
  if (kind === "products") {
    const items = (((data || {}).data || {}).centralize_item_card || {}).item_cards || [];
    if (!items.length) return;
    const store = await chrome.storage.local.get(["products"]);
    const map = new Map((store.products || []).map((i) => [i.itemid, i]));
    for (const it of items) if (it && it.itemid != null) map.set(it.itemid, it);
    await chrome.storage.local.set({ products: [...map.values()], lastProdCapture: Date.now() });
    LOG("captured", items.length, "products (buffer", map.size + ")");
  } else if (kind === "reviews") {
    const ratings = ((data || {}).data || {}).ratings || [];
    await chrome.storage.local.set({ lastReviewCapture: Date.now() });
    if (!ratings.length) return;
    const { itemid, shopid } = idsFromRatingsUrl(url);
    const store = await chrome.storage.local.get(["reviews"]);
    const map = new Map((store.reviews || []).map((r) => [r.cmtid, r]));
    for (const r of ratings) {
      if (r && r.cmtid != null) map.set(r.cmtid, { ...r, _itemid: itemid, _shopid: shopid });
    }
    await chrome.storage.local.set({ reviews: [...map.values()] });
    LOG("captured", ratings.length, "reviews (buffer", map.size + ")");
  }
}

// Save an object as a JSON file in Downloads (service workers have no
// URL.createObjectURL, so use a data: URL).
async function dl(filename, obj) {
  const dataUrl = "data:application/json;charset=utf-8," + encodeURIComponent(JSON.stringify(obj, null, 2));
  await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
}

// Rebuild product URL like the Python scraper: /{clean-name}-i.{shopid}.{itemid}
function productUrl(item) {
  const raw = ((item.item_card_displayed_asset || {}).name) || "";
  const clean = raw.replace(/[^a-zA-Z0-9\s]/g, "").trim().replace(/\s+/g, "-").replace(/-+/g, "-");
  return `https://shopee.co.id/${clean}-i.${item.shopid}.${item.itemid}`;
}

function storeNameFromUrl(u) {
  try {
    const seg = new URL(u).pathname.replace(/^\/+/, "").split("/")[0];
    return seg || null;
  } catch {
    return null;
  }
}
function pageUrl(storeName, page) {
  return `https://shopee.co.id/${storeName}?page=${page}&sortBy=pop&tab=0`;
}

// ═══════════════════════ PRODUCT store run ═══════════════════════
const PSTATE_KEY = "productrun";
async function getPState() {
  return (await chrome.storage.local.get([PSTATE_KEY]))[PSTATE_KEY] || { active: false };
}
async function setPState(s) {
  await chrome.storage.local.set({ [PSTATE_KEY]: s });
}

async function startProductRun({ stores, tabId, maxPages }) {
  if (!Array.isArray(stores) || !stores.length || tabId == null) {
    return { ok: false, error: "no stores" };
  }
  const { storeDone = [] } = await chrome.storage.local.get(["storeDone"]);
  const done = new Set(storeDone);
  const todo = stores.filter((u) => !done.has(u));
  if (!todo.length) {
    await chrome.storage.local.set({ productStatus: "All stores already done." });
    return { ok: false, error: "nothing to do" };
  }

  await setPState({
    active: true,
    tabId,
    stores: todo,
    storeIndex: 0,
    page: 0,
    maxPages: maxPages || 10,
    lastHandled: "",
    pageStartTs: 0,
  });
  await chrome.storage.local.set({ products: [], productsTotal: 0 });
  LOG("PRODUCT RUN START —", todo.length, "stores");
  chrome.action.setBadgeText({ text: "1.0" });
  chrome.tabs.update(tabId, { url: pageUrl(storeNameFromUrl(todo[0]), 0) });
  return { ok: true, count: todo.length };
}

async function stopProductRun() {
  const s = await getPState();
  s.active = false;
  await setPState(s);
  await chrome.storage.local.set({ productStatus: "Batch stopped." });
  chrome.action.setBadgeText({ text: "" });
}

async function waitForProdCapture(sinceTs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { lastProdCapture = 0 } = await chrome.storage.local.get(["lastProdCapture"]);
    if (lastProdCapture >= sinceTs) return true;
    if (!(await getPState()).active) return false;
    await sleep(500);
  }
  return false;
}

async function onStorePageReady() {
  const s = await getPState();
  if (!s.active) return;
  const storeName = storeNameFromUrl(s.stores[s.storeIndex]);
  chrome.action.setBadgeText({ text: `${s.storeIndex + 1}.${s.page}` });
  await chrome.storage.local.set({
    productStatus: `Store ${s.storeIndex + 1}/${s.stores.length} (${storeName}) — page ${s.page}`,
  });

  let captured = await waitForProdCapture(s.pageStartTs, 9000);
  if (!captured) {
    LOG("store page", s.page, "no capture — nudging scroll");
    chrome.tabs.sendMessage(s.tabId, { type: "AUTOSCROLL", rounds: 5 }, () => {
      void chrome.runtime.lastError;
    });
    captured = await waitForProdCapture(s.pageStartTs, 9000);
  }
  await afterStorePage(captured);
}

async function afterStorePage(pageHadProducts) {
  const s = await getPState();
  if (!s.active) return;

  const nextPage = s.page + 1;
  const storeFinished = !pageHadProducts || nextPage >= s.maxPages;

  if (!storeFinished) {
    s.page = nextPage;
    await setPState(s);
    await sleep(1200 + Math.random() * 1200);
    chrome.tabs.update(s.tabId, { url: pageUrl(storeNameFromUrl(s.stores[s.storeIndex]), nextPage) });
    return;
  }

  // Store done → download its two files from the buffer.
  const storeUrlNow = s.stores[s.storeIndex];
  const storeName = storeNameFromUrl(storeUrlNow) || "store";
  const { products = [] } = await chrome.storage.local.get(["products"]);
  const links = [...new Set(products.map(productUrl))];
  const base = storeName.replace(/[^a-zA-Z0-9_.-]/g, "_");
  await dl(`shopee_products/${base}_products.json`, { store: storeName, count: products.length, products });
  await dl(`shopee_products/${base}_links.json`, links);
  LOG("store", storeName, "saved", products.length, "products,", links.length, "links");

  const store = await chrome.storage.local.get(["storeDone", "productsTotal"]);
  const storeDone = store.storeDone || [];
  if (!storeDone.includes(storeUrlNow)) storeDone.push(storeUrlNow);
  const productsTotal = (store.productsTotal || 0) + products.length;
  await chrome.storage.local.set({ storeDone, productsTotal });

  const nextStore = s.storeIndex + 1;
  if (nextStore >= s.stores.length) {
    s.active = false;
    await setPState(s);
    await chrome.storage.local.set({
      productStatus: `Done — ${storeDone.length} stores, ${productsTotal} products total.`,
    });
    LOG("PRODUCT RUN FINISH");
    chrome.action.setBadgeText({ text: "✓" });
    return;
  }

  s.storeIndex = nextStore;
  s.page = 0;
  await setPState(s);
  await chrome.storage.local.set({ products: [] }); // fresh buffer for next store
  await sleep(2500 + Math.random() * 2000);
  LOG("→ next store", nextStore + 1, "/", s.stores.length);
  chrome.tabs.update(s.tabId, { url: pageUrl(storeNameFromUrl(s.stores[nextStore]), 0) });
}

// ═══════════════════════ REVIEW product run ══════════════════════
const RSTATE_KEY = "reviewrun";
async function getRState() {
  return (await chrome.storage.local.get([RSTATE_KEY]))[RSTATE_KEY] || { active: false };
}
async function setRState(s) {
  await chrome.storage.local.set({ [RSTATE_KEY]: s });
}

async function startReviewRun({ links, tabId, maxPages }) {
  if (!Array.isArray(links) || !links.length || tabId == null) {
    return { ok: false, error: "no links" };
  }
  const { reviewDone = [] } = await chrome.storage.local.get(["reviewDone"]);
  const done = new Set(reviewDone);
  const todo = links.filter((l) => !done.has(l));
  if (!todo.length) {
    await chrome.storage.local.set({ reviewStatus: "All links already done." });
    return { ok: false, error: "nothing to do" };
  }

  await setRState({
    active: true,
    tabId,
    links: todo,
    index: 0,
    maxPages: maxPages || 20,
    lastHandled: -1,
    pageStartTs: 0,
  });
  await chrome.storage.local.set({ reviewsTotal: 0 });
  LOG("REVIEW RUN START —", todo.length, "products");
  chrome.action.setBadgeText({ text: "1" });
  chrome.tabs.update(tabId, { url: todo[0] });
  return { ok: true, count: todo.length };
}

async function stopReviewRun() {
  const s = await getRState();
  s.active = false;
  await setRState(s);
  await chrome.storage.local.set({ reviewStatus: "Batch stopped." });
  chrome.action.setBadgeText({ text: "" });
}

async function waitReviewDone(sinceTs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { lastReviewDone = null } = await chrome.storage.local.get(["lastReviewDone"]);
    if (lastReviewDone && lastReviewDone.ts >= sinceTs) return lastReviewDone;
    if (!(await getRState()).active) return null;
    await sleep(700);
  }
  return null;
}

async function onReviewProductReady() {
  const s = await getRState();
  if (!s.active) return;

  chrome.action.setBadgeText({ text: String(s.index + 1) });
  await chrome.storage.local.set({
    reviewStatus: `Product ${s.index + 1}/${s.links.length} — scraping…`,
  });

  await sleep(1500 + Math.random() * 1000);
  chrome.tabs.sendMessage(s.tabId, { type: "SCRAPE_REVIEWS", maxPages: s.maxPages }, () => {
    void chrome.runtime.lastError;
  });

  const res = await waitReviewDone(s.pageStartTs, 240000);
  await afterProduct(s.links[s.index], res);
}

async function downloadProductReviews(url) {
  const { reviews = [] } = await chrome.storage.local.get(["reviews"]);
  const m = /-i\.(\d+)\.(\d+)/.exec(url);
  const shopid = m ? m[1] : "x";
  const itemid = m ? m[2] : "x";
  await dl(`shopee_reviews/shopee_reviews_${shopid}_${itemid}.json`, {
    product_url: url,
    shopid,
    itemid,
    count: reviews.length,
    reviews,
  });
  return reviews.length;
}

async function afterProduct(url, res) {
  const s = await getRState();
  if (!s.active) return;

  const store = await chrome.storage.local.get(["reviewDone", "reviewFailed", "reviewsTotal"]);
  const done = store.reviewDone || [];
  const failed = store.reviewFailed || [];
  let total = store.reviewsTotal || 0;

  if (res && res.ok) {
    const n = await downloadProductReviews(url);
    total += n;
    if (!done.includes(url)) done.push(url);
    LOG("product", s.index + 1, "saved", n, "reviews");
  } else if (!failed.includes(url)) {
    failed.push(url);
    LOG("product", s.index + 1, "FAILED", res && res.error);
  }
  await chrome.storage.local.set({ reviewDone: done, reviewFailed: failed, reviewsTotal: total });

  if (res && res.error === "blocked") {
    s.active = false;
    await setRState(s);
    await chrome.storage.local.set({
      reviewStatus: `Blocked at product ${s.index + 1}. Stopped — resume later.`,
    });
    chrome.action.setBadgeText({ text: "✗" });
    return;
  }

  const next = s.index + 1;
  if (next >= s.links.length) {
    s.active = false;
    await setRState(s);
    await chrome.storage.local.set({
      reviewStatus: `Done — ${done.length} saved, ${failed.length} failed, ${total} reviews total.`,
    });
    LOG("REVIEW RUN FINISH");
    chrome.action.setBadgeText({ text: "✓" });
    return;
  }

  s.index = next;
  s.lastHandled = -1;
  await setRState(s);
  await sleep(4000 + Math.random() * 4000);
  chrome.tabs.update(s.tabId, { url: s.links[next] });
}

// ─────────── navigation router: one 'complete' → whichever run is active ───────────
chrome.tabs.onUpdated.addListener(async (id, info) => {
  if (info.status !== "complete") return;

  // Product store run takes priority.
  const p = await getPState();
  if (p.active && id === p.tabId) {
    const key = `${p.storeIndex}:${p.page}`;
    if (p.lastHandled === key) return; // 'complete' can fire twice per load
    p.lastHandled = key;
    p.pageStartTs = Date.now();
    await setPState(p);
    LOG("store", p.storeIndex + 1, "page", p.page, "loaded");
    await onStorePageReady();
    return;
  }

  // Review product run.
  const r = await getRState();
  if (r.active && id === r.tabId) {
    if (r.index === r.lastHandled) return;
    r.lastHandled = r.index;
    r.pageStartTs = Date.now();
    await setRState(r);
    await chrome.storage.local.set({ reviews: [] }); // fresh buffer per product
    LOG("product", r.index + 1, "/", r.links.length, "loaded");
    await onReviewProductReady();
    return;
  }
});
