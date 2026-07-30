// content.js  —  ISOLATED world. Forwards captures to background, and drives
// human-like scrolling / clicking on the page (products + review pagination).
(function () {
  // Relay captured payloads (products or reviews) → background.
  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (!msg || msg.source !== "SHOPEE_SCRAPER") return;
    chrome.runtime.sendMessage({ type: "CAPTURE", kind: msg.kind, data: msg.data, url: msg.url });
  });

  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req.type === "AUTOSCROLL") {
      humanScroll(req.rounds || 8).then(() => sendResponse({ ok: true }));
      return true; // async response
    }
    if (req.type === "SCRAPE_REVIEWS") {
      const finish = async (r) => {
        await chrome.storage.local.set({
          lastReviewDone: { ...r, url: location.href, ts: Date.now() },
        });
        return r;
      };
      scrapeReviews(req.maxPages || 20)
        .then((r) => finish(r).then(() => sendResponse(r)))
        .catch((e) =>
          finish({ ok: false, error: String(e) }).then(() =>
            sendResponse({ ok: false, error: String(e) })
          )
        );
      return true; // async response
    }
  });

  // ───────────────────── human-ish primitives ─────────────────────
  const rand = (min, max) => min + Math.random() * (max - min);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pause = (min, max) => sleep(rand(min, max));
  const status = (t) => chrome.storage.local.set({ reviewStatus: t });

  // Move the "cursor" toward an element in small jittery steps, then hover.
  async function humanMoveTo(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const tx = r.left + r.width * rand(0.3, 0.7);
    const ty = r.top + r.height * rand(0.3, 0.7);
    let x = rand(0, window.innerWidth);
    let y = rand(0, window.innerHeight);
    const steps = Math.floor(rand(5, 9));
    for (let i = 1; i <= steps; i++) {
      x += (tx - x) * (i / steps) + rand(-6, 6);
      y += (ty - y) * (i / steps) + rand(-6, 6);
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true }));
      await sleep(rand(18, 55));
    }
    el.dispatchEvent(new MouseEvent("mouseover", { clientX: tx, clientY: ty, bubbles: true }));
    el.dispatchEvent(new MouseEvent("mousemove", { clientX: tx, clientY: ty, bubbles: true }));
  }

  // Hover, tiny hesitation, full mousedown/up/click.
  async function humanClick(el) {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    await pause(300, 800);
    await humanMoveTo(el);
    await pause(120, 420);
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await sleep(rand(40, 130));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.click();
  }

  // Variable scroll: uneven steps, easing pauses, occasional read-pause & scroll-up.
  async function humanScroll(rounds) {
    for (let i = 0; i < rounds; i++) {
      window.scrollBy({ top: rand(500, 1100), behavior: "smooth" });
      await pause(650, 1500);
      if (Math.random() < 0.18) await pause(1300, 3000);          // "reading"
      if (Math.random() < 0.10) {                                  // glance back up
        window.scrollBy({ top: -rand(150, 380), behavior: "smooth" });
        await pause(500, 1100);
      }
    }
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    await pause(1200, 2200);
  }

  // ───────────────────── review pagination ─────────────────────
  function findPager() {
    return (
      document.querySelector(".shopee-page-controller") ||
      document.querySelector(".product-ratings__page-controller") ||
      null
    );
  }
  function findNextButton() {
    const pager = findPager();
    if (!pager) return null;
    return (
      pager.querySelector("button.shopee-icon-button--right") ||
      pager.querySelector(".shopee-icon-button--right") ||
      null
    );
  }
  function reviewCount() {
    return document.querySelectorAll(".shopee-product-rating").length;
  }

  async function waitReviewCapture(sinceTs, timeoutMs = 9000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { lastReviewCapture = 0 } = await chrome.storage.local.get(["lastReviewCapture"]);
      if (lastReviewCapture >= sinceTs) return true;
      await sleep(400);
    }
    return false;
  }

  // Scroll down gradually until the ratings section renders (fires offset=0).
  async function reachReviews() {
    for (let i = 0; i < 12; i++) {
      if (findPager() || reviewCount() > 0) return true;
      window.scrollBy({ top: rand(700, 1100), behavior: "smooth" });
      await pause(800, 1600);
    }
    return findPager() || reviewCount() > 0;
  }

  // A "reading" delay that scales with how many reviews are on the page.
  async function readPause() {
    const n = reviewCount();
    await pause(1200 + n * 120, 2600 + n * 260);
  }

  async function scrapeReviews(maxPages) {
    if (location.href.includes("/verify/")) {
      await status("Blocked by anti-bot (/verify/).");
      return { ok: false, error: "blocked" };
    }

    await status("Scrolling to reviews…");
    const t0 = Date.now();
    const reached = await reachReviews();
    await waitReviewCapture(t0, 6000);

    if (!reached) {
      await status("No review section on this page.");
      return { ok: false, error: "no reviews" };
    }

    let page = 1;
    for (; page < maxPages; page++) {
      await readPause(); // linger on the current page like a reader

      const next = findNextButton();
      if (!next) break;
      if (next.disabled || next.getAttribute("aria-disabled") === "true") break;

      const ts = Date.now();
      await humanClick(next);
      await status(`Review page ${page + 1}…`);

      const got = await waitReviewCapture(ts);
      if (!got) break;
    }

    return { ok: true, pages: page };
  }
})();
