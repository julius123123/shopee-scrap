(function () {
  // Relay captured payloads (products or reviews) → background.
  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (!msg || msg.source !== "SHOPEE_SCRAPER") return;
    chrome.runtime.sendMessage({ type: "CAPTURE", kind: msg.kind, data: msg.data, url: msg.url });
  });

  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req.type === "AUTOSCROLL") {
      autoScroll(req.rounds || 8).then(() => sendResponse({ ok: true }));
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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const status = (t) => chrome.storage.local.set({ reviewStatus: t });

  // ───────────────────── product-page scroll ─────────────────────
  async function autoScroll(rounds) {
    for (let i = 0; i < rounds; i++) {
      window.scrollBy(0, 1200);
      await sleep(1000 + Math.random() * 700);
    }
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(1500);
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

  async function reachReviews() {
    for (let i = 0; i < 12; i++) {
      if (findPager() || reviewCount() > 0) return true;
      window.scrollBy(0, 1000);
      await sleep(900 + Math.random() * 500);
    }
    return findPager() || reviewCount() > 0;
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
      const next = findNextButton();
      if (!next) break;
      if (next.disabled || next.getAttribute("aria-disabled") === "true") break;

      next.scrollIntoView({ block: "center" });
      await sleep(400);

      const ts = Date.now();
      next.click();
      await status(`Review page ${page + 1}…`);

      const got = await waitReviewCapture(ts);
      if (!got) break;
      await sleep(900 + Math.random() * 1100);
    }

    return { ok: true, pages: page };
  }
})();
