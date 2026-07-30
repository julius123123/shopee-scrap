# Shopee Scraper (Ekstensi Chrome)

Melakukan scraping **produk toko** dan **ulasan produk** Shopee langsung dari
Chrome. Setiap halaman disimpan sebagai file JSON dan bisa dikirim ke API secara otomatis saat scraping.



## Cara Kerja
Shopee memuat data dari API internal (`api/v4/shop/rcmd_items` untuk produk,
`api/v2/item/get_ratings` untuk ulasan). Ekstensi ini merekam respons API tersebut . Ada empat bagian yang saling mengoper data:

```
interceptor.js ─▶ content.js ─▶ background.js ─▶ popup
   (menangkap)    (meneruskan,   (menyimpan,          (tombol,
                   scroll,         menjalankan batch,   hitungan,
                   klik)           simpan + kirim API)  konfigurasi API)
```

- **interceptor.js** berjalan di dalam halaman Shopee (MAIN world) dan membaca salinan
  setiap respons `rcmd_items` / `get_ratings`.
- **content.js** meneruskan hasil tangkapan ke background, serta melakukan scroll / klik
  tombol halaman ulasan saat diperintah.
- **background.js**: menavigasi tab melewati halaman toko / URL produk,
  mengumpulkan tangkapan, lalu menyimpan tiap halaman ke disk (dan opsional ke API).
- **popup**: panel kontrol 

Semuanya digerakkan oleh event page-load dan disimpan di `chrome.storage`, sehingga sebuah
run bisa dilanjutkan (resumable) dan tetap aman meski Chrome menghentikan background worker.

---

## Instalasi

1. Buka `chrome://extensions`
2. Aktifkan **Developer mode** (pojok kanan atas)
3. **Load unpacked** → pilih folder `chrome_extension` ini
4. Pin ekstensinya. Butuh **Chrome 111+** 
5. Di pengaturan download Chrome, **matikan** opsi "Tanyakan tempat menyimpan setiap file
   sebelum mengunduh" agar batch bisa menyimpan tanpa gangguan.


## Fitur

- **Scraping produk** — menelusuri `?page=0,1,2,…` sebuah toko, satu file per halaman.
- **Scraping ulasan** — menelusuri daftar URL produk, membuka tiap halaman ulasan produk,
  satu file per halaman ulasan.
- **Resumable** — toko/link yang sudah selesai akan dilewati saat run ulang (Reset untuk menghapus).
- **Auto-stop** — toko berhenti saat sebuah halaman tidak mengembalikan produk; produk
  berhenti di halaman ulasan terakhir.

## Cara Pakai

Pastikan sudah login ke shopee.co.id dan biarkan satu tab Shopee aktif.

### 1. Produk (toko --> produk + link)
1. Tempel satu atau beberapa **URL toko** (satu per baris) di kotak Products.
2. Atur **Max store pages** (default 10) → **Scrape products**.
3. Tab akan menelusuri tiap halaman toko; badge menampilkan `toko.halaman`, lalu `✓`.

### 2. Ulasan (link produk --> ulasan)
1. Tempel **link produk** di kotak Reviews, bisa berupa array JSON *atau* satu URL perbaris (`…-i.{shopid}.{itemid}`). Dapat menggunakan hasil scrape Produk.
2. Atur **Max review pages** (default 20) → **Scrape reviews**.
3. Ekstensi membuka tiap produk, menelusuri halaman ulasan, dan menyimpan per halaman.


### 3. Kirim ke API (opsional)
1. Isi **API endpoint** 
2. **Test connection** mengirim ping `{type:"test"}`.
3. Centang **Send each page to API**. File tetap disimpan lokal *dan* tiap halaman
   di-POST. Baris status menampilkan `API: on — sent N, failed N`.

## Cara Hasil Disimpan

### File lokal (selalu) — di dalam `Downloads/shopee/`

Satu file **per halaman**, dibungkus `{ raw, metadata }` (sama persis dengan script Python):

```
shopee/product/{toko}/shopee_{toko}_page_{N}.json
   { "raw": [ …item_cards… ],
     "metadata": { "store", "platform", "url" } }

shopee/links/list_link_product_shopee_{toko}.json
   [ "https://shopee.co.id/…-i.{shopid}.{itemid}", … ]

shopee/review/{toko|shopid}/{itemid}/shopee_comment_{itemid}_page_{N}.json
   { "raw": { …data get_ratings: ratings + summary + has_more… },
     "metadata": { "product_id", "shop_id", "platform", "url", "page" } }
```

File ulasan tersusun di bawah **nama toko** jika produk toko tersebut sudah di-scrape
lebih dulu (run mengingat `shopid → toko`); jika tidak, tersusun di bawah **shopid**
(angka).

### Payload API (jika diaktifkan)

Satu `POST {endpoint}` **per halaman**, `Content-Type: application/json`, tanpa auth:

```jsonc
{ "type": "product" | "review",   // jenis halaman, untuk routing
  "raw":  { … },                   // sama dengan "raw" file lokal
  "metadata": { … } }              // sama dengan "metadata" file lokal
```

Untuk uji coba lokal, jalankan
```
python test_api_server.py            # mendengarkan di 127.0.0.1:8000/ingest
```
Receiver ini menyusun ulang struktur yang sama di bawah `api_received/`