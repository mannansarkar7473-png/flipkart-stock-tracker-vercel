const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// =========================================================================
// PRE-CONFIGURED CREDENTIALS
// =========================================================================
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://vpqhayqkovxerxertwuv.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZwcWhheXFrb3Z4ZXJ4ZXJ0d3V2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUwNzI1MzYsImV4cCI6MjExMDY0ODUzNn0.3vAnKw1pzzVMt4MWmKIh82Qgghkf_6rL9EtDD0W-ZOc';
const BOT_TOKEN = process.env.BOT_TOKEN || '9242430164:AAE9YigL7yAWhKKX_EUZlQBiCWx0NSgUCpE';
const CHAT_ID = process.env.CHAT_ID || '-1004305890096';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const CHECK_INTERVAL_SEC = 35;
// =========================================================================

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
app.use(express.json());

function checkAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'Galat Password!' });
  }
  next();
}

const USER_AGENTS = [
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
];

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function cleanFlipkartUrl(rawUrl) {
  try {
    const u = new URL(rawUrl.trim());
    const pid = u.searchParams.get('pid');
    const lid = u.searchParams.get('lid');
    let clean = `${u.origin}${u.pathname}`;
    const q = [];
    if (pid) q.push(`pid=${pid}`);
    if (lid) q.push(`lid=${lid}`);
    if (q.length) clean += `?${q.join('&')}`;
    return { clean, pid, lid };
  } catch {
    return null;
  }
}

function parsePriceNumber(str) {
  if (!str) return null;
  const cleaned = String(str).replace(/[^0-9.]/g, '');
  const num = parseFloat(cleaned);
  return !isNaN(num) && num > 0 ? Math.round(num) : null;
}

// =========================================================================
// RICH TELEGRAM ALERT (PRODUCT PHOTO + INLINE BUY BUTTON)
// =========================================================================
async function sendTelegram(product, info, heading) {
  const title = (info.title || product.name || 'Flipkart Product').replace(/[*_`\[\]()]/g, '');
  const price = Number(info.price) || 0;
  const mrp = Number(info.mrp) || 0;
  const savings = mrp > price && price > 0 ? mrp - price : 0;

  const mrpPart = mrp > price && price > 0 ? ` (MRP: ~₹${mrp.toLocaleString('en-IN')}~)` : '';
  const discPart = info.discount > 0
    ? `🏷️ *Discount:* ${info.discount}% OFF${savings > 0 ? ` (Save ₹${savings.toLocaleString('en-IN')})` : ''}\n`
    : '';
  const priceText = price > 0 ? `₹${price.toLocaleString('en-IN')}` : 'Check Link';

  const caption =
    `🚨 *${heading}* 🚨\n\n` +
    `📦 *Product:* ${title}\n` +
    `📍 *Pin Code:* \`${product.pincode}\` (Deliverable ✅)\n` +
    `💰 *Live Price:* ${priceText}${mrpPart}\n` +
    discPart +
    `\n⚡ _Jaldi order karein, stock/offer kabhi bhi khatam ho sakta hai!_`;

  const replyMarkup = {
    inline_keyboard: [[{ text: '🛒 BUY NOW ON FLIPKART', url: product.url }]]
  };

  try {
    if (info.image && info.image.startsWith('http')) {
      const r = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
        chat_id: CHAT_ID,
        photo: info.image,
        caption,
        parse_mode: 'Markdown',
        reply_markup: replyMarkup
      }, { timeout: 12000 });
      if (r.data?.ok) return { ok: true };
    }
  } catch (e) {}

  try {
    const r = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text: caption,
      parse_mode: 'Markdown',
      disable_web_page_preview: false,
      reply_markup: replyMarkup
    }, { timeout: 10000 });
    return { ok: Boolean(r.data?.ok) };
  } catch (err) {
    console.error('❌ Telegram Error:', err.response?.data?.description || err.message);
    return { ok: false, error: err.response?.data?.description || err.message };
  }
}

// =========================================================================
// ENGINE 1: CHEERIO DOM + LD+JSON + INITIAL_STATE PARSER (GitHub Scraper Flow)
// =========================================================================
function extractFromHtml(html, targetPid) {
  const $ = cheerio.load(html);
  let title = null;
  let price = null;
  let mrp = null;
  let discount = 0;
  let image = null;
  let inStock = null;

  // 1A. Schema.org application/ld+json (Exact Main Product, Zero Ads)
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).html();
      if (!raw) return;
      const parsed = JSON.parse(raw.trim());
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item['@type'] === 'Product') {
          if (item.name && !title) title = item.name.trim();
          if (item.image && !image) {
            image = Array.isArray(item.image) ? item.image[0] : item.image;
          }
          const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
          if (offers) {
            if (offers.price && !price) price = parsePriceNumber(offers.price);
            if (offers.availability) {
              const av = String(offers.availability);
              if (av.includes('InStock')) inStock = true;
              else if (av.includes('OutOfStock')) inStock = false;
            }
          }
        }
      }
    } catch (e) {}
  });

  // 1B. Flipkart HTML DOM Selectors (Both Modern & Classic Classes)
  const titleSelectors = ['span.VU-ZEz', 'span.B_NuCI', 'h1._6EBuvT span', 'h1'];
  for (const sel of titleSelectors) {
    const t = $(sel).first().text().trim();
    if (t && t.length > 3 && !title) {
      title = t.replace(/\s+/g, ' ');
      break;
    }
  }

  const priceSelectors = ['div.Nx9bqj.CxhGGd', 'div.Nx9bqj', 'div._30jeq3._16Jk6d', 'div._30jeq3'];
  for (const sel of priceSelectors) {
    const p = parsePriceNumber($(sel).first().text());
    if (p && !price) {
      price = p;
      break;
    }
  }

  const mrpSelectors = ['div.yRaY8j.A6\\+E6v', 'div.yRaY8j', 'div._3I9_wc._2p6lqe', 'div._3I9_wc'];
  for (const sel of mrpSelectors) {
    const m = parsePriceNumber($(sel).first().text());
    if (m && (!price || m >= price) && !mrp) {
      mrp = m;
      break;
    }
  }

  const discSelectors = ['div.UkUFwK.WW8yVX span', 'div.UkUFwK span', 'div._3Ay6Sb._31Dcoz span', 'div._3Ay6Sb span'];
  for (const sel of discSelectors) {
    const dText = $(sel).first().text();
    const match = dText.match(/(\d+)\s*%/);
    if (match && !discount) {
      discount = Number(match[1]);
      break;
    }
  }

  if (!image) {
    const imgSrc = $('img.DByuf4.IZexXJ').attr('src') || $('img._396cs4._2amPTt._3qGmMb').attr('src') || $('meta[property="og:image"]').attr('content');
    if (imgSrc && imgSrc.startsWith('http')) image = imgSrc;
  }

  // 1C. Stock Detection from Main Action Buttons & Status Text
  const bodyText = $('body').text();
  const hasBuyBtn =
    $('button:contains("Buy Now")').length > 0 ||
    $('button:contains("BUY NOW")').length > 0 ||
    $('button:contains("Add to cart")').length > 0 ||
    $('button:contains("ADD TO CART")').length > 0 ||
    $('button:contains("Go to cart")').length > 0;

  const hasOosText =
    bodyText.includes('Currently out of stock') ||
    bodyText.includes('Sold Out') ||
    $('button:contains("Notify Me")').length > 0 ||
    $('button:contains("NOTIFY ME")').length > 0;

  if (hasOosText) inStock = false;
  else if (hasBuyBtn) inStock = true;

  // 1D. Embedded window.__INITIAL_STATE__ JSON Extraction (PID Locked)
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
  if (stateMatch && stateMatch[1]) {
    try {
      const state = JSON.parse(stateMatch[1]);
      const pageCtx = state?.pageDataV4?.page?.pageData?.pageContext;
      if (pageCtx) {
        if (!title && pageCtx.titles?.title) title = pageCtx.titles.title;
        const td = pageCtx.trackingDataV2;
        if (td && (!targetPid || !td.productId || td.productId === targetPid)) {
          if (!price && td.sellingPrice) price = Number(td.sellingPrice);
          if (!mrp && td.mrp) mrp = Number(td.mrp);
          if (!discount && td.discount) discount = Number(td.discount);
          if (inStock === null && td.productStatus) {
            const st = String(td.productStatus).toUpperCase();
            if (st.includes('OUT_OF_STOCK') || st.includes('SOLD_OUT')) inStock = false;
            else if (st.includes('IN_STOCK')) inStock = true;
          }
        }
      }
    } catch (e) {}
  }

  if (mrp && price && mrp > price) {
    discount = Math.round(((mrp - price) / mrp) * 100);
  }

  return { title, price, mrp, discount, image, inStock };
}

// =========================================================================
// ENGINE 2: PINCODE SERVICEABILITY CHECK (1.rome.api / dynamic product)
// =========================================================================
async function checkPincodeAvailability(product, lid) {
  if (!lid) return null;
  try {
    const res = await axios.post(
      'https://1.rome.api.flipkart.com/api/3/page/dynamic/product',
      {
        requestContext: {
          productId: product.pid || undefined,
          listingId: lid
        },
        locationContext: {
          pincode: String(product.pincode)
        }
      },
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'X-User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 FKUA/website/42/website/Desktop',
          'Content-Type': 'application/json',
          'Origin': 'https://www.flipkart.com',
          'Referer': product.url
        },
        timeout: 10000
      }
    );

    const raw = JSON.stringify(res.data || {});
    if (raw.includes('"NOT_SERVICEABLE"') || raw.includes('"OUT_OF_STOCK"') || raw.includes('"Currently out of stock"')) {
      return false;
    }
    if (raw.includes('"BUY_NOW"') || raw.includes('"ADD_TO_CART"') || raw.includes('"IN_STOCK"')) {
      return true;
    }
  } catch (e) {}
  return null;
}

// =========================================================================
// MASTER HYBRID FETCHER (Desktop HTML -> Mobile dl.flipkart -> Pincode Check)
// =========================================================================
async function fetchProductHybrid(product) {
  const u = new URL(product.url);
  const pid = product.pid || u.searchParams.get('pid');
  const lid = product.lid || u.searchParams.get('lid');

  const urlsToTry = [
    { url: product.url, label: 'Desktop DOM' },
    { url: product.url.replace('www.flipkart.com', 'dl.flipkart.com/dl'), label: 'Mobile Lite DOM' }
  ];

  let bestData = null;

  for (const target of urlsToTry) {
    try {
      const res = await axios.get(target.url, {
        headers: {
          'User-Agent': getRandomUA(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-IN,en-GB;q=0.9,en;q=0.8',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Upgrade-Insecure-Requests': '1'
        },
        maxRedirects: 5,
        timeout: 15000
      });

      const html = String(res.data || '');
      if (html.includes('captcha') || html.includes('Are you a human')) {
        continue;
      }

      const extracted = extractFromHtml(html, pid);
      if (extracted.price || extracted.title || extracted.inStock !== null) {
        bestData = { ...extracted, source: target.label };
        break;
      }
    } catch (err) {
      // Try next URL in fallback chain
    }
  }

  // Verify Pincode delivery availability if lid is available
  const pinStock = await checkPincodeAvailability({ ...product, pid }, lid);
  if (pinStock !== null) {
    if (!bestData) bestData = { title: null, price: null, mrp: null, discount: 0, image: null, source: 'Pincode API' };
    bestData.inStock = pinStock;
  }

  if (!bestData || (bestData.inStock === null && !bestData.price)) {
    return { ok: false, error: 'Flipkart temporary block / retrying in 35s' };
  }

  return {
    ok: true,
    inStock: bestData.inStock === null ? true : bestData.inStock,
    title: bestData.title,
    price: bestData.price,
    mrp: bestData.mrp,
    discount: bestData.discount || 0,
    image: bestData.image,
    source: bestData.source
  };
}

// Safe Supabase Update
async function safeUpdateProduct(id, updates) {
  const { error } = await supabase.from('tracked_products').update(updates).eq('id', id);
  if (error) {
    const fallback = {
      status: updates.status,
      last_price: updates.last_price,
      last_discount: updates.last_discount,
      alert_sent: updates.alert_sent,
      last_checked_at: updates.last_checked_at
    };
    if (updates.name) fallback.name = updates.name;
    await supabase.from('tracked_products').update(fallback).eq('id', id);
  }
}

// =========================================================================
// 24x7 MULTI-PRODUCT QUEUE WORKER
// =========================================================================
let isRunning = false;
async function checkAllProducts() {
  if (isRunning) return;
  isRunning = true;

  try {
    const { data: products, error } = await supabase
      .from('tracked_products')
      .select('*')
      .eq('active', true);

    if (error || !products || products.length === 0) return;

    for (const p of products) {
      const res = await fetchProductHybrid(p);
      const nowIso = new Date().toISOString();

      if (!res.ok) {
        await safeUpdateProduct(p.id, {
          last_checked_at: nowIso,
          error_message: res.error
        });
        console.log(`⚠️ [${p.pincode}] ${p.name}: ${res.error}`);
        continue;
      }

      const livePrice = res.price || p.last_price || null;
      const prevLowest = Number(p.lowest_price) || 0;
      const newLowest = livePrice && (!prevLowest || livePrice < prevLowest) ? livePrice : prevLowest || livePrice;

      const updates = {
        last_checked_at: nowIso,
        error_message: null,
        last_price: livePrice,
        last_mrp: res.mrp || p.last_mrp,
        lowest_price: newLowest,
        last_discount: res.discount || 0
      };

      if (res.image && !p.image_url) updates.image_url = res.image;
      if (res.title && (!p.name || p.name === 'Flipkart Product')) {
        updates.name = res.title;
      }

      if (!res.inStock) {
        updates.status = 'OUT_OF_STOCK';
        updates.alert_sent = false;
      } else {
        if (p.mode === 'PRICE') {
          const targetP = Number(p.target_price) || 0;
          if (livePrice && livePrice <= targetP) {
            updates.status = 'PRICE_HIT';
            if (!p.alert_sent) {
              updates.alert_sent = true;
              await sendTelegram(
                { ...p, ...updates },
                res,
                `PRICE DROP ALERT (₹${livePrice.toLocaleString('en-IN')} ≤ ₹${targetP.toLocaleString('en-IN')})!`
              );
            }
          } else {
            updates.status = 'WAITING_PRICE';
            updates.alert_sent = false;
          }
        } else if (p.mode === 'DISCOUNT') {
          const targetD = Number(p.target_discount) || 0;
          if (res.discount >= targetD) {
            updates.status = 'DEAL_HIT';
            if (!p.alert_sent) {
              updates.alert_sent = true;
              await sendTelegram(
                { ...p, ...updates },
                res,
                `DISCOUNT ALERT (${res.discount}% OFF ≥ ${targetD}% Target)!`
              );
            }
          } else {
            updates.status = 'WAITING_DISCOUNT';
            updates.alert_sent = false;
          }
        } else {
          updates.status = 'IN_STOCK';
          if (!p.alert_sent) {
            updates.alert_sent = true;
            await sendTelegram(
              { ...p, ...updates },
              res,
              'STOCK AA GAYA HAI! JALDI ORDER KAREIN!'
            );
          }
        }
      }

      await safeUpdateProduct(p.id, updates);
      console.log(`✅ [${res.source}] [${p.pincode}] ${updates.name || p.name} | ${updates.status} | ₹${updates.last_price || '-'} | ${updates.last_discount}% OFF`);
      await new Promise(r => setTimeout(r, 3500));
    }
  } catch (e) {
    console.error('Loop error:', e.message);
  } finally {
    isRunning = false;
  }
}

setInterval(checkAllProducts, CHECK_INTERVAL_SEC * 1000);

// =========================================================================
// DASHBOARD UI (WITH DIAGNOSTIC STATUS & INSTANT CHECK BUTTON)
// =========================================================================
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Flipkart Hybrid Sniper 24×7</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen p-4 md:p-8">
  <div class="max-w-5xl mx-auto">
    <div class="flex flex-wrap items-center justify-between gap-4 mb-6 border-b border-slate-800 pb-4">
      <div>
        <div class="flex items-center gap-2.5">
          <span class="h-3 w-3 rounded-full bg-emerald-500 animate-pulse"></span>
          <h1 class="text-2xl font-bold text-blue-400">Flipkart Hybrid Sniper 24×7</h1>
          <span class="text-xs px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">Cheerio DOM + Mobile + Schema</span>
        </div>
        <p class="text-xs text-slate-400 mt-1">Har 35s mein live check • Exact Price, MRP, Discount % & Stock Arrival par Telegram Deal Card</p>
      </div>
      <div class="flex gap-2">
        <button onclick="forceCheck()" class="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded-lg text-sm font-medium cursor-pointer">Scan Now</button>
        <button onclick="testTg()" class="bg-emerald-600 hover:bg-emerald-500 px-4 py-2 rounded-lg text-sm font-medium cursor-pointer">Test Telegram</button>
        <button onclick="logout()" class="bg-slate-800 hover:bg-slate-700 px-3 py-2 rounded-lg text-sm cursor-pointer">Logout</button>
      </div>
    </div>

    <!-- Login Box -->
    <div id="loginBox" class="max-w-sm mx-auto bg-slate-900 border border-slate-800 rounded-xl p-6 mt-12 hidden">
      <h2 class="text-lg font-semibold mb-1">Admin Login</h2>
      <p class="text-xs text-slate-400 mb-3">Password: <code class="text-blue-400">admin123</code></p>
      <input type="password" id="pwd" placeholder="Enter Password" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-sm mb-3" />
      <button onclick="doLogin()" class="w-full bg-blue-600 hover:bg-blue-500 py-2.5 rounded-lg text-sm font-medium cursor-pointer">Login</button>
      <p id="loginErr" class="text-rose-400 text-xs mt-2"></p>
    </div>

    <!-- Main App -->
    <div id="appBox" class="hidden">
      <div class="bg-slate-900 border border-slate-800 rounded-xl p-5 mb-6 shadow-lg">
        <h2 class="text-base font-semibold mb-4 text-slate-200">+ Naya Product Track Karein</h2>
        <form id="addForm" class="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div class="md:col-span-6">
            <label class="text-xs text-slate-400">Flipkart Product Link *</label>
            <input type="url" id="url" required placeholder="https://www.flipkart.com/..." class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1" />
          </div>
          <div class="md:col-span-2">
            <label class="text-xs text-slate-400">Pin Code *</label>
            <input type="text" id="pincode" required maxlength="6" pattern="[0-9]{6}" value="462023" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1" />
          </div>
          <div class="md:col-span-4">
            <label class="text-xs text-slate-400">Alert Condition *</label>
            <select id="mode" onchange="toggleInputs()" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1">
              <option value="STOCK">1. Stock Alert (Stock Aane Par)</option>
              <option value="PRICE">2. Target Price (₹ Kam Hone Par)</option>
              <option value="DISCOUNT">3. Discount Alert (Target % OFF)</option>
            </select>
          </div>
          <div id="priceDiv" class="md:col-span-4 hidden">
            <label class="text-xs text-emerald-400">Target Max Price (₹) *</label>
            <input type="number" id="targetPrice" min="1" placeholder="e.g. 800 (₹800 ya niche aane par)" class="w-full bg-slate-950 border border-emerald-500/50 rounded-lg px-3 py-2 text-sm mt-1" />
          </div>
          <div id="discDiv" class="md:col-span-4 hidden">
            <label class="text-xs text-amber-400">Target Discount % *</label>
            <input type="number" id="targetDiscount" min="1" max="99" placeholder="e.g. 20 (20% ya zyada OFF par)" class="w-full bg-slate-950 border border-amber-500/50 rounded-lg px-3 py-2 text-sm mt-1" />
          </div>
          <div id="nameDiv" class="md:col-span-12">
            <label class="text-xs text-slate-400">Product Name (Optional - Auto Detect Hoga)</label>
            <input type="text" id="name" placeholder="Auto detect from Flipkart" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1" />
          </div>
          <div class="md:col-span-12 flex justify-end">
            <button type="submit" class="bg-blue-600 hover:bg-blue-500 px-6 py-2.5 rounded-lg text-sm font-medium cursor-pointer">Tracking List Mein Jodein</button>
          </div>
        </form>
      </div>

      <div class="flex items-center justify-between mb-3">
        <h2 class="text-base font-semibold text-slate-200">Active Tracking List (Live Verified Data)</h2>
        <button onclick="loadList()" class="text-xs bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded cursor-pointer">Refresh List</button>
      </div>
      <div id="list" class="space-y-3"></div>
    </div>
  </div>

  <script>
    let token = localStorage.getItem('fk_pass') || '';

    function toggleInputs() {
      const m = document.getElementById('mode').value;
      const pDiv = document.getElementById('priceDiv');
      const dDiv = document.getElementById('discDiv');
      const pIn = document.getElementById('targetPrice');
      const dIn = document.getElementById('targetDiscount');

      pDiv.classList.toggle('hidden', m !== 'PRICE');
      dDiv.classList.toggle('hidden', m !== 'DISCOUNT');
      pIn.required = (m === 'PRICE');
      dIn.required = (m === 'DISCOUNT');
      document.getElementById('nameDiv').className = m === 'STOCK' ? 'md:col-span-12' : 'md:col-span-8';
    }

    async function api(url, opts = {}) {
      opts.headers = { ...(opts.headers || {}), 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
      return fetch(url, opts);
    }

    async function doLogin() {
      token = document.getElementById('pwd').value;
      const res = await api('/api/products');
      if (res.ok) {
        localStorage.setItem('fk_pass', token);
        document.getElementById('loginBox').classList.add('hidden');
        document.getElementById('appBox').classList.remove('hidden');
        loadList();
      } else {
        document.getElementById('loginErr').innerText = 'Wrong Password! (Default: admin123)';
      }
    }

    function logout() {
      localStorage.removeItem('fk_pass');
      location.reload();
    }

    async function forceCheck() {
      await api('/api/scan-now', { method: 'POST' });
      setTimeout(loadList, 2500);
    }

    async function loadList() {
      const res = await api('/api/products');
      if (!res.ok) {
        document.getElementById('loginBox').classList.remove('hidden');
        return;
      }
      document.getElementById('appBox').classList.remove('hidden');
      const items = await res.json();
      const box = document.getElementById('list');
      if (!items.length) {
        box.innerHTML = '<div class="text-center py-8 text-slate-500 text-sm bg-slate-900 border border-slate-800 rounded-xl">Abhi koi product add nahi hai. Upar link aur pincode daal kar add karein.</div>';
        return;
      }
      box.innerHTML = items.map(p => {
        let statusBadge = '<span class="px-2.5 py-0.5 text-xs rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">' + p.status + '</span>';
        if (p.status === 'IN_STOCK' || p.status === 'PRICE_HIT' || p.status === 'DEAL_HIT') {
          statusBadge = '<span class="px-2.5 py-0.5 text-xs rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-semibold">' + p.status + ' ✅</span>';
        } else if (p.status === 'OUT_OF_STOCK') {
          statusBadge = '<span class="px-2.5 py-0.5 text-xs rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/30">OUT OF STOCK</span>';
        } else if (p.status === 'WAITING_PRICE') {
          statusBadge = '<span class="px-2.5 py-0.5 text-xs rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30">In Stock (Waiting ≤ ₹' + p.target_price + ')</span>';
        } else if (p.status === 'WAITING_DISCOUNT') {
          statusBadge = '<span class="px-2.5 py-0.5 text-xs rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30">In Stock (Waiting ≥ ' + p.target_discount + '% OFF)</span>';
        }

        let targetTag = '<span class="px-2 py-0.5 text-xs rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">Mode: Stock Alert</span>';
        if (p.mode === 'PRICE') {
          targetTag = '<span class="px-2 py-0.5 text-xs rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">Target Price: ≤ ₹' + p.target_price + '</span>';
        } else if (p.mode === 'DISCOUNT') {
          targetTag = '<span class="px-2 py-0.5 text-xs rounded bg-amber-500/10 text-amber-300 border border-amber-500/20">Target Discount: ≥ ' + p.target_discount + '% OFF</span>';
        }

        const thumb = p.image_url
          ? '<img src="' + p.image_url + '" class="w-14 h-14 object-contain bg-white rounded-lg p-1 shrink-0" />'
          : '<div class="w-14 h-14 bg-slate-800 rounded-lg flex items-center justify-center text-xs text-slate-500 shrink-0">FK</div>';

        const errLine = p.error_message
          ? '<div class="text-xs text-amber-400 mt-1">⚠️ ' + p.error_message + '</div>'
          : '';

        return \`
          <div class="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div class="flex items-start gap-3.5">
              \${thumb}
              <div class="space-y-1.5">
                <div class="flex items-center gap-2 flex-wrap">
                  <a href="\${p.url}" target="_blank" class="font-semibold text-slate-100 hover:text-blue-400">\${p.name}</a>
                  \${statusBadge}
                  \${targetTag}
                </div>
                <div class="text-xs text-slate-400 flex flex-wrap gap-x-4 gap-y-1">
                  <span>📍 PIN: <b class="text-slate-200">\${p.pincode}</b></span>
                  <span>💰 Live Price: <b class="text-slate-100">\${p.last_price ? '₹' + Number(p.last_price).toLocaleString('en-IN') : '-'}</b></span>
                  <span>🏷️ MRP: <b class="text-slate-400">\${p.last_mrp ? '₹' + Number(p.last_mrp).toLocaleString('en-IN') : '-'}</b></span>
                  <span>🔥 Live Discount: <b class="text-emerald-400">\${p.last_discount || 0}% OFF</b></span>
                  <span>📉 Lowest: <b class="text-blue-300">\${p.lowest_price ? '₹' + Number(p.lowest_price).toLocaleString('en-IN') : '-'}</b></span>
                  <span>🕒 \${p.last_checked_at ? new Date(p.last_checked_at).toLocaleTimeString('en-IN') : 'Checking...'}</span>
                </div>
                \${errLine}
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0 self-end md:self-center">
              <button onclick="toggleItem('\${p.id}', \${!p.active})" class="px-3 py-1.5 text-xs rounded bg-slate-800 hover:bg-slate-700 cursor-pointer">\${p.active ? 'Pause' : 'Resume'}</button>
              <button onclick="delItem('\${p.id}')" class="px-3 py-1.5 text-xs rounded bg-rose-950 text-rose-300 border border-rose-800/40 cursor-pointer">Delete</button>
            </div>
          </div>
        \`;
      }).join('');
    }

    document.getElementById('addForm').addEventListener('submit', async e => {
      e.preventDefault();
      const body = {
        url: document.getElementById('url').value,
        pincode: document.getElementById('pincode').value,
        mode: document.getElementById('mode').value,
        targetPrice: document.getElementById('targetPrice').value,
        targetDiscount: document.getElementById('targetDiscount').value,
        name: document.getElementById('name').value
      };
      const res = await api('/api/products', { method: 'POST', body: JSON.stringify(body) });
      if (res.ok) {
        document.getElementById('url').value = '';
        document.getElementById('name').value = '';
        document.getElementById('targetPrice').value = '';
        document.getElementById('targetDiscount').value = '';
        loadList();
      } else {
        const d = await res.json();
        alert(d.error || 'Error adding product');
      }
    });

    async function toggleItem(id, active) {
      await api('/api/products/' + id, { method: 'PATCH', body: JSON.stringify({ active }) });
      loadList();
    }

    async function delItem(id) {
      await api('/api/products/' + id, { method: 'DELETE' });
      loadList();
    }

    async function testTg() {
      const res = await api('/api/test-telegram', { method: 'POST' });
      alert(res.ok ? '✅ Telegram Deal Card Sent!' : '❌ Failed - Check Bot Admin permissions');
    }

    if (token) loadList();
    else document.getElementById('loginBox').classList.remove('hidden');
    setInterval(() => { if (token) loadList(); }, 8000);
  </script>
</body>
</html>`;

// =========================================================================
// API ROUTES
// =========================================================================
app.get('/', (req, res) => res.type('html').send(HTML));
app.get('/ping', (req, res) => res.send('OK - Hybrid Sniper 24x7 Active'));

app.get('/api/products', checkAuth, async (req, res) => {
  const { data, error } = await supabase.from('tracked_products').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/scan-now', checkAuth, async (req, res) => {
  checkAllProducts();
  res.json({ started: true });
});

app.post('/api/products', checkAuth, async (req, res) => {
  const { url, pincode, mode, targetPrice, targetDiscount, name } = req.body;
  const parsed = cleanFlipkartUrl(url);
  if (!parsed || !parsed.clean.includes('flipkart.com')) {
    return res.status(400).json({ error: 'Sahi Flipkart product link dalein' });
  }
  if (!/^\d{6}$/.test(String(pincode).trim())) {
    return res.status(400).json({ error: 'Sahi 6-digit Pincode dalein' });
  }

  const validMode = mode === 'PRICE' ? 'PRICE' : mode === 'DISCOUNT' ? 'DISCOUNT' : 'STOCK';

  const { error } = await supabase.from('tracked_products').insert([{
    name: name?.trim() || 'Flipkart Product',
    url: parsed.clean,
    pid: parsed.pid || null,
    lid: parsed.lid || null,
    pincode: String(pincode).trim(),
    mode: validMode,
    target_price: validMode === 'PRICE' ? Number(targetPrice) : null,
    target_discount: validMode === 'DISCOUNT' ? Number(targetDiscount) : null,
    status: 'CHECKING',
    alert_sent: false,
    active: true
  }]);

  if (error) return res.status(500).json({ error: error.message });
  checkAllProducts();
  res.json({ success: true });
});

app.patch('/api/products/:id', checkAuth, async (req, res) => {
  await supabase.from('tracked_products').update({
    active: req.body.active,
    alert_sent: false,
    status: req.body.active ? 'CHECKING' : 'PAUSED'
  }).eq('id', req.params.id);
  res.json({ success: true });
});

app.delete('/api/products/:id', checkAuth, async (req, res) => {
  await supabase.from('tracked_products').delete().eq('id', req.params.id);
  res.json({ success: true });
});

app.post('/api/test-telegram', checkAuth, async (req, res) => {
  const r = await sendTelegram(
    { name: 'Test Product', pincode: '462023', url: 'https://www.flipkart.com' },
    {
      title: 'Hybrid Sniper 24x7 Tracker Connected!',
      price: 946,
      mrp: 1099,
      discount: 14
    },
    'HYBRID SNIPER ACTIVE!'
  );
  res.status(r.ok ? 200 : 500).json(r);
});

app.listen(PORT, () => {
  console.log(`🚀 Hybrid Sniper Tracker Live on Port ${PORT}`);
  checkAllProducts();
});
