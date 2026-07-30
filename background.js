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

// ───────────────────────── helpers ─────────────────────────
async function dl(filename, obj) {
  const dataUrl = "data:application/json;charset=utf-8," + encodeURIComponent(JSON.stringify(obj, null, 2));
  await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
}

// POST one page ({type, raw, metadata}) to the configured API, if enabled.
async function postToApi(type, payload) {
  const { apiEnabled = false, apiUrl = "" } = await chrome.storage.local.get(["apiEnabled", "apiUrl"]);
  if (!apiEnabled || !apiUrl) return;
  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, ...payload }),
    });
    const c = await chrome.storage.local.get(["apiSent", "apiFailed"]);
    if (res.ok) {
      await chrome.storage.local.set({ apiSent: (c.apiSent || 0) + 1 });
    } else {
      await chrome.storage.local.set({ apiFailed: (c.apiFailed || 0) + 1 });
      LOG("API responded", res.status, type);
    }
  } catch (e) {
    const c = await chrome.storage.local.get(["apiFailed"]);
    await chrome.storage.local.set({ apiFailed: (c.apiFailed || 0) + 1 });
    LOG("API error:", String(e));
  }
}

// Save a page locally AND (if enabled) POST it to the API.
async function saveAndSend(type, filename, payload) {
  await dl(filename, payload);
  await postToApi(type, payload);
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
function safeName(s) {
  return (s || "store").replace(/[^a-zA-Z0-9_.-]/g, "_");
}
function pageUrl(storeName, page) {
  return `https://shopee.co.id/${storeName}?page=${page}&sortBy=pop&tab=0`;
}

// get_ratings URL carries itemid/shopid/offset/limit
function idsFromRatingsUrl(url) {
  try {
    const q = new URL(url, "https://shopee.co.id").searchParams;
    return {
      itemid: q.get("itemid"),
      shopid: q.get("shopid"),
      offset: parseInt(q.get("offset") || "0", 10),
      limit: parseInt(q.get("limit") || "6", 10),
    };
  } catch {
    return { itemid: null, shopid: null, offset: 0, limit: 6 };
  }
}

// ───────────────────────── capture ─────────────────────────
// Products → accumulate the current page's item_cards + store-wide links.
// Reviews  → keep each review page's FULL get_ratings data, keyed by page.
async function addCapture(kind, data, url) {
  if (kind === "products") {
    const items = (((data || {}).data || {}).centralize_item_card || {}).item_cards || [];
    if (!items.length) return;
    const cur = await chrome.storage.local.get(["pageItems", "storeLinks"]);
    const pageMap = new Map((cur.pageItems || []).map((i) => [i.itemid, i]));
    for (const it of items) if (it && it.itemid != null) pageMap.set(it.itemid, it);
    const linkSet = new Set(cur.storeLinks || []);
    for (const it of items) if (it && it.itemid != null) linkSet.add(productUrl(it));
    await chrome.storage.local.set({
      pageItems: [...pageMap.values()],
      storeLinks: [...linkSet],
      lastProdCapture: Date.now(),
    });
    LOG("captured", items.length, "products (page buffer", pageMap.size + ")");
  } else if (kind === "reviews") {
    const full = ((data || {}).data) || {};
    await chrome.storage.local.set({ lastReviewCapture: Date.now() });
    const ratings = full.ratings || [];
    if (!ratings.length) return;

    // Save + POST THIS review page immediately (per-page), during a review run.
    const rr = await getRState();
    if (!rr.active) return;
    const productUrlNow = rr.links[rr.index];
    const pm = /-i\.(\d+)\.(\d+)/.exec(productUrlNow || "");
    const pShop = pm ? pm[1] : "x";
    const pItem = pm ? pm[2] : "x";

    // Ignore ratings from a different item (e.g. "similar products" widgets).
    const u = idsFromRatingsUrl(url);
    if (u.itemid && pItem !== "x" && String(u.itemid) !== pItem) return;

    const page = Math.floor(u.offset / (u.limit || 6)) + 1;

    // Dedup: a page can fire more than once (offset=0 on load, re-renders…).
    const savedKey = `${pItem}_${page}`;
    const saved = (await chrome.storage.local.get(["reviewSaved"])).reviewSaved || {};
    if (saved[savedKey]) return;
    saved[savedKey] = true;

    const storeByShop = (await chrome.storage.local.get(["storeByShop"])).storeByShop || {};
    const storeFolder = safeName(storeByShop[pShop] || pShop);
    await saveAndSend("review", `shopee/review/${storeFolder}/${pItem}/shopee_comment_${pItem}_page_${page}.json`, {
      raw: full,
      metadata: { product_id: pItem, shop_id: pShop, platform: "shopee", url: productUrlNow, page },
    });

    const c = await chrome.storage.local.get(["reviewsTotal"]);
    await chrome.storage.local.set({
      reviewSaved: saved,
      reviewsTotal: (c.reviewsTotal || 0) + ratings.length,
    });
    LOG("saved review page", page, "(", ratings.length, "ratings) ->", storeFolder + "/" + pItem);
  }
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
    active: true, tabId, stores: todo, storeIndex: 0, page: 0,
    maxPages: maxPages || 10, lastHandled: "", pageStartTs: 0,
  });
  await chrome.storage.local.set({ pageItems: [], storeLinks: [], productsTotal: 0 });
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
    chrome.tabs.sendMessage(s.tabId, { type: "AUTOSCROLL", rounds: 5 }, () => void chrome.runtime.lastError);
    captured = await waitForProdCapture(s.pageStartTs, 9000);
  }
  await afterStorePage();
}

async function afterStorePage() {
  const s = await getPState();
  if (!s.active) return;

  const storeName = storeNameFromUrl(s.stores[s.storeIndex]) || "store";
  const base = safeName(storeName);
  const { pageItems = [] } = await chrome.storage.local.get(["pageItems"]);
  const hadProducts = pageItems.length > 0;

  // Save THIS page's fils
  if (hadProducts) {
    await saveAndSend("product", `shopee/product/${base}/shopee_${base}_page_${s.page}.json`, {
      raw: pageItems,
      metadata: {
        store: storeName,
        platform: "shopee",
        url: pageUrl(storeName, s.page),
      },
    });
    const { productsTotal = 0 } = await chrome.storage.local.get(["productsTotal"]);
    await chrome.storage.local.set({ productsTotal: productsTotal + pageItems.length });
    LOG("saved product page", s.page, "(", pageItems.length, "items)");
  }

  const nextPage = s.page + 1;
  const storeFinished = !hadProducts || nextPage >= s.maxPages;

  if (!storeFinished) {
    s.page = nextPage;
    await setPState(s);
    await sleep(2500 + Math.random() * 4000); // human-ish gap between pages
    chrome.tabs.update(s.tabId, { url: pageUrl(storeName, nextPage) });
    return;
  }

  // Store done → save the links list (parity: list_link_product_shopee_{store}.json).
  const { storeLinks = [] } = await chrome.storage.local.get(["storeLinks"]);
  await dl(`shopee/links/list_link_product_shopee_${base}.json`, storeLinks);
  LOG("store", storeName, "done —", storeLinks.length, "links");

  // Remember shopid → storeName so the review run can nest under the store name.
  const shopMatch = /-i\.(\d+)\.\d+/.exec(storeLinks[0] || "");
  if (shopMatch) {
    const sb = (await chrome.storage.local.get(["storeByShop"])).storeByShop || {};
    sb[shopMatch[1]] = storeName;
    await chrome.storage.local.set({ storeByShop: sb });
  }

  const st = await chrome.storage.local.get(["storeDone"]);
  const storeDone = st.storeDone || [];
  if (!storeDone.includes(s.stores[s.storeIndex])) storeDone.push(s.stores[s.storeIndex]);
  await chrome.storage.local.set({ storeDone, storeLinks: [] });

  const nextStore = s.storeIndex + 1;
  if (nextStore >= s.stores.length) {
    s.active = false;
    await setPState(s);
    const { productsTotal = 0 } = await chrome.storage.local.get(["productsTotal"]);
    await chrome.storage.local.set({
      productStatus: `Done — ${storeDone.length} stores, ${productsTotal} products.`,
    });
    LOG("PRODUCT RUN FINISH");
    chrome.action.setBadgeText({ text: "✓" });
    return;
  }

  s.storeIndex = nextStore;
  s.page = 0;
  await setPState(s);
  await chrome.storage.local.set({ pageItems: [] });
  await sleep(6000 + Math.random() * 7000); // human-ish gap between stores
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
    active: true, tabId, links: todo, index: 0,
    maxPages: maxPages || 20, lastHandled: -1, pageStartTs: 0,
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
  await sleep(2500 + Math.random() * 3000); // let the SPA settle (human-ish)
  chrome.tabs.sendMessage(s.tabId, { type: "SCRAPE_REVIEWS", maxPages: s.maxPages }, () => void chrome.runtime.lastError);
  const res = await waitReviewDone(s.pageStartTs, 240000);
  await afterProduct(s.links[s.index], res);
}

async function afterProduct(url, res) {
  const s = await getRState();
  if (!s.active) return;

  const store = await chrome.storage.local.get(["reviewDone", "reviewFailed", "reviewsTotal"]);
  const done = store.reviewDone || [];
  const failed = store.reviewFailed || [];
  const total = store.reviewsTotal || 0;

  // Files were already saved per-page in addCapture — here we just record status.
  if (res && res.ok) {
    if (!done.includes(url)) done.push(url);
    LOG("product", s.index + 1, "done —", url);
  } else if (!failed.includes(url)) {
    failed.push(url);
    LOG("product", s.index + 1, "FAILED", res && res.error);
  }
  await chrome.storage.local.set({ reviewDone: done, reviewFailed: failed });

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
      reviewStatus: `Done — ${done.length} saved, ${failed.length} failed, ${total} reviews.`,
    });
    LOG("REVIEW RUN FINISH");
    chrome.action.setBadgeText({ text: "✓" });
    return;
  }

  s.index = next;
  s.lastHandled = -1;
  await setRState(s);
  await sleep(6000 + Math.random() * 9000); // human-ish gap between products (6–15s)
  chrome.tabs.update(s.tabId, { url: s.links[next] });
}

// ─────────── navigation router: one 'complete' → whichever run is active ───────────
chrome.tabs.onUpdated.addListener(async (id, info) => {
  if (info.status !== "complete") return;

  // Product store run.
  const p = await getPState();
  if (p.active && id === p.tabId) {
    const key = `${p.storeIndex}:${p.page}`;
    if (p.lastHandled === key) return;
    p.lastHandled = key;
    p.pageStartTs = Date.now();
    await setPState(p);
    await chrome.storage.local.set({ pageItems: [] }); // fresh buffer per page
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
    await chrome.storage.local.set({ reviewSaved: {} }); // fresh dedup per product
    LOG("product", r.index + 1, "/", r.links.length, "loaded");
    await onReviewProductReady();
    return;
  }
});
