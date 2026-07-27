(function () {
  const TARGETS = {
    products: "api/v4/shop/rcmd_items",
    reviews: "api/v2/item/get_ratings",
  };

  function matchKind(url) {
    if (!url) return null;
    for (const [kind, pat] of Object.entries(TARGETS)) {
      if (url.includes(pat)) return kind;
    }
    return null;
  }

  function relay(kind, url, data) {
    window.postMessage({ source: "SHOPEE_SCRAPER", kind, url, data }, "*");
  }

  // ---- hook fetch ----
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    p.then((res) => {
      try {
        const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url);
        const u = url || res.url;
        const kind = matchKind(u);
        if (kind) res.clone().json().then((d) => relay(kind, u, d)).catch(() => {});
      } catch (e) {}
    }).catch(() => {});
    return p;
  };

  // ---- hook XMLHttpRequest ----
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__url = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", function () {
      try {
        const kind = matchKind(this.__url || "");
        if (kind) relay(kind, this.__url, JSON.parse(this.responseText));
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };

  console.log("[ShopeeScraper] interceptor installed");
})();
