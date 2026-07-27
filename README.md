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

Output mirrors the Python scripts exactly — one file **per page**, wrapped as
`{ raw, metadata }`. Everything lands under **Downloads/shopee/**.

### 1. Products (store → products + links)
1. Paste one or more **store URLs** (one per line) into the Products box.
2. Set **Max store pages** (default 10) → **Scrape products**.
3. Walks each store's `?page=0,1,2,…` and saves:
   - `shopee/product/{store}/shopee_{store}_page_{N}.json` — `{ raw: item_cards, metadata: {store, platform, url} }`
   - `shopee/links/list_link_product_shopee_{store}.json` — `[urls]` ← feeds step 2

### 2. Reviews (product links → reviews)
1. Paste a **product links** list (e.g. from step 1) into the Reviews box.
2. Set **Max review pages** (default 20) → **Scrape reviews**.
3. Per review page it saves:
   - `shopee/review/{itemid}/shopee_comment_{itemid}_page_{N}.json` —
     `{ raw: get_ratings data, metadata: {product_id, shop_id, platform, url, page} }`

The badge shows progress (`store.page` or product number), then `✓` (done) / `✗`
(blocked). Both batches are **resumable** — completed stores/links are skipped on
the next run. Use **Reset** to clear that progress. Run one batch at a time.

## Notes
- If Shopee shows a `/verify/` page, the review batch stops (a block affects all
  following products). Browse normally a bit, then resume.
- Everything runs in your real session; it only reads responses Shopee already fetched.
