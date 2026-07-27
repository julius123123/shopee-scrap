# Shopee Scraper (Chrome Extension)

Scrapes Shopee **store products** and **product reviews** from *your own logged-in
Chrome* — reads Shopee's own API responses (`rcmd_items`, `get_ratings`) inside a
browser Shopee already trusts, so no captcha. Auto-downloads one file per unit.

## Install (load unpacked)

1. `chrome://extensions` → **Developer mode** ON → **Load unpacked** → this folder
2. Pin the extension. Requires Chrome 111+ (`world: "MAIN"` content scripts).
3. In Chrome download settings, turn **off** "Ask where to save each file" so the
   batch can save unattended.

## Use — two batches

Be **logged into shopee.co.id**, keep a Shopee tab active.

### 1. Products (store → products + links)
1. Paste one or more **store URLs** (one per line) into the Products box.
2. Set **Max store pages** (default 10) → **Scrape products**.
3. It walks each store's `?page=0,1,2,…`, and per store saves to
   **Downloads/shopee_products/**:
   - `{store}_products.json` — raw products
   - `{store}_links.json` — product URLs (`…-i.{shopid}.{itemid}`) ← feeds step 2

### 2. Reviews (product links → reviews)
1. Load a **product links JSON** (e.g. a `{store}_links.json` from step 1).
2. Set **Max review pages** (default 20) → **Scrape reviews**.
3. Per product it pages through reviews and saves to
   **Downloads/shopee_reviews/**: `shopee_reviews_{shopid}_{itemid}.json`.

The badge shows progress (`store.page` or product number), then `✓` (done) / `✗`
(blocked). Both batches are **resumable** — completed stores/links are skipped on
the next run. Use **Reset** to clear that progress. Run one batch at a time.

## Notes
- If Shopee shows a `/verify/` page, the review batch stops (a block affects all
  following products). Browse normally a bit, then resume.
- Everything runs in your real session; it only reads responses Shopee already fetched.
