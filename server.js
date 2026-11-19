const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// =========================================================================
// PRE-CONFIGURED CREDENTIALS (Direct Ready - No Env Setup Required)
// =========================================================================
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://vpqhayqkovxerxertwuv.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZwcWhheXFrb3Z4ZXJ4ZXJ0d3V2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUwNzI1MzYsImV4cCI6MjExMDY0ODUzNn0.3vAnKw1pzzVMt4MWmKIh82Qgghkf_6rL9EtDD0W-ZOc';
const BOT_TOKEN = process.env.BOT_TOKEN || '9242430164:AAEAAIcATBMTKDgTevoef5TekjniPP-7dSI';
const CHAT_ID = process.env.CHAT_ID || '-1004305890096';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Mamun991@';
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

let sessionCookies = '';
let lastCookieFetch = 0;

async function refreshCookies() {
  const now = Date.now();
  if (sessionCookies && now - lastCookieFetch < 15 * 60 * 1000) return sessionCookies;
  try {
    const res = await axios.get('https://www.flipkart.com/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-IN,en-GB;q=0.9,en;q=0.8'
      },
      timeout: 12000
    });
    const setCookies = res.headers['set-cookie'];
    if (Array.isArray(setCookies)) {
      sessionCookies = setCookies.map(c => c.split(';')[0]).join('; ');
      lastCookieFetch = now;
    }
  } catch (e) {}
  return sessionCookies;
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
    return { clean, pid };
  } catch {
    return null;
  }
}

async function sendTelegram(product, info, heading) {
  const title = (info.title || product.name || 'Flipkart Product').replace(/[*_`\[\]()]/g, '');
  const mrpPart = info.mrp && info.price && info.mrp > info.price
    ? ` (MRP: ~₹${Number(info.mrp).toLocaleString('en-IN')}~)`
    : '';
  const discPart = info.discount > 0 ? `🏷️ *Live Discount:* ${info.discount}% OFF\n` : '';
  const priceText = info.price ? `₹${Number(info.price).toLocaleString('en-IN')}` : 'Check Link';

  const text =
    `🚨 *${heading}* 🚨\n\n` +
    `📦 *Product:* ${title}\n` +
    `📍 *Pin Code:* \`${product.pincode}\` (Available ✅)\n` +
    `💰 *Live Price:* ${priceText}${mrpPart}\n` +
    discPart +
    `\n👉 [YAHAN CLICK KAREIN AUR TURANT BUY KAREIN](${product.url})`;

  try {
    const r = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: false
    }, { timeout: 10000 });
    return { ok: Boolean(r.data?.ok) };
  } catch (err) {
    console.error('❌ Telegram Error:', err.response?.data?.description || err.message);
    return { ok: false, error: err.response?.data?.description || err.message };
  }
}

// =========================================================================
// FLIPKART 3-LAYER UNIVERSAL EXTRACTOR
// =========================================================================
function parseFlipkartResponse(data, targetPid) {
  let inStock = false;
  let oosExplicit = false;
  let foundSignal = false;
  let title = null;
  let price = null;
  let mrp = null;
  let discount = 0;

  // Layer 1: Primary pageContext & trackingDataV2
  const pageCtx = data?.RESPONSE?.pageData?.pageContext;
  if (pageCtx) {
    if (pageCtx.titles?.title) title = pageCtx.titles.title;
    if (pageCtx.pricing) {
      const p = pageCtx.pricing;
      if (!price) price = Number(p.finalPrice?.value || p.specialPrice?.value || p.price?.value || 0) || null;
      if (!mrp && p.mrp?.value) mrp = Number(p.mrp.value);
      if (!discount && (p.totalDiscount || p.discount)) discount = Number(p.totalDiscount || p.discount);
      if (Array.isArray(p.prices)) {
        for (const pr of p.prices) {
          if ((pr.priceType === 'FSP' || pr.priceType === 'SPECIAL_PRICE') && pr.value && !price) price = Number(pr.value);
          if (pr.priceType === 'MRP' && pr.value && !mrp) mrp = Number(pr.value);
          if (pr.discount && !discount) discount = Number(pr.discount);
        }
      }
    }
    const td = pageCtx.trackingDataV2;
    if (td) {
      if (!price && td.sellingPrice) price = Number(td.sellingPrice);
      if (!mrp && td.mrp) mrp = Number(td.mrp);
      if (!discount && td.discount) discount = Number(td.discount);
      if (td.productStatus) {
        const st = String(td.productStatus).toUpperCase();
        if (st.includes('OUT_OF_STOCK') || st.includes('SOLD_OUT') || st.includes('NOT_AVAILABLE')) {
          oosExplicit = true;
          foundSignal = true;
        } else if (st.includes('IN_STOCK') || st.includes('AVAILABLE')) {
          inStock = true;
          foundSignal = true;
        }
      }
    }
  }

  // Layer 2: Main Product Slots Scanner (Ignores Ads & Similar Items)
  const slots = data?.RESPONSE?.slots;
  if (Array.isArray(slots)) {
    for (const slot of slots) {
      const w = slot?.widget;
      if (!w || !w.data) continue;
      const wType = String(w.type || '').toUpperCase();
      if (
        wType.includes('AD') ||
        wType.includes('SIMILAR') ||
        wType.includes('RECOMMEND') ||
        wType.includes('CROSS_SELL') ||
        wType.includes('BANNER') ||
        wType.includes('RECENTLY')
      ) continue;

      function scan(node, depth = 0) {
        if (!node || typeof node !== 'object' || depth > 22) return;
        if (targetPid && node.productId && node.productId !== targetPid) return;

        if (!title && node.titles && typeof node.titles.title === 'string') {
          title = node.titles.title;
        }

        if (node.pricing && typeof node.pricing === 'object') {
          const p = node.pricing;
          if (!price) price = Number(p.finalPrice?.value || p.specialPrice?.value || p.price?.value || 0) || null;
          if (!mrp && p.mrp?.value) mrp = Number(p.mrp.value);
          if (!discount && (p.totalDiscount || p.discount)) discount = Number(p.totalDiscount || p.discount);
          if (Array.isArray(p.prices)) {
            for (const pr of p.prices) {
              if ((pr.priceType === 'FSP' || pr.priceType === 'SPECIAL_PRICE') && pr.value && !price) price = Number(pr.value);
              if (pr.priceType === 'MRP' && pr.value && !mrp) mrp = Number(pr.value);
              if (pr.discount && !discount) discount = Number(pr.discount);
            }
          }
        }
        if (node.priceType === 'FSP' && node.value && !price) price = Number(node.value);
        if (node.priceType === 'MRP' && node.value && !mrp) mrp = Number(node.value);

        if (node.action?.type === 'BUY_NOW' || node.action?.type === 'ADD_TO_CART') {
          inStock = true;
          foundSignal = true;
        } else if (node.action?.type === 'NOTIFY_ME') {
          oosExplicit = true;
          foundSignal = true;
        }
        if (node.availabilityStatus === 'IN_STOCK') {
          inStock = true;
          foundSignal = true;
        } else if (node.availabilityStatus === 'OUT_OF_STOCK' || node.availabilityStatus === 'COMING_SOON') {
          oosExplicit = true;
          foundSignal = true;
        }

        if (Array.isArray(node)) node.forEach(x => scan(x, depth + 1));
        else Object.keys(node).forEach(k => scan(node[k], depth + 1));
      }
      scan(w);
    }
  }

  // Exact discount calculation from MRP & Selling Price
  if (mrp && price && mrp > price) {
    const calc = Math.round(((mrp - price) / mrp) * 100);
    if (calc > 0) discount = calc;
  }

  return {
    inStock: inStock && !oosExplicit,
    foundSignal: foundSignal || oosExplicit || price !== null,
    title,
    price,
    mrp,
    discount
  };
}

async function fetchProductLive(product) {
  const cookies = await refreshCookies();
  const u = new URL(product.url);
  const pid = u.searchParams.get('pid');
  const pageUri = u.pathname + u.search;

  const endpoints = [
    {
      url: 'https://2.rome.api.flipkart.com/api/4/page/fetch',
      ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
      xua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 FKUA/msite/0.0.3/msite/Mobile'
    },
    {
      url: 'https://1.rome.api.flipkart.com/api/4/page/fetch',
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      xua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 FKUA/website/42/website/Desktop'
    }
  ];

  for (const ep of endpoints) {
    try {
      const res = await axios.post(
        ep.url,
        { pageUri, locationContext: { pincode: String(product.pincode) }, isReloadRequest: true },
        {
          headers: {
            'User-Agent': ep.ua,
            'X-User-Agent': ep.xua,
            'Content-Type': 'application/json',
            'Origin': 'https://www.flipkart.com',
            'Referer': 'https://www.flipkart.com/',
            ...(cookies ? { Cookie: cookies } : {})
          },
          timeout: 15000
        }
      );

      const parsed = parseFlipkartResponse(res.data, pid);

      // Layer 3: Raw action signal fallback
      if (!parsed.foundSignal) {
        const raw = JSON.stringify(res.data);
        const buy = raw.includes('"type":"BUY_NOW"') || raw.includes('"type":"ADD_TO_CART"');
        const notify = raw.includes('"type":"NOTIFY_ME"');
        if (buy || notify) {
          parsed.inStock = buy && !notify;
          parsed.foundSignal = true;
        }
      }

      if (parsed.foundSignal) {
        return { ok: true, ...parsed };
      }
    } catch (err) {
      sessionCookies = '';
    }
  }

  return { ok: false, error: 'Retrying in next cycle' };
}

// Safe Supabase Update (Never fails even if optional columns are missing)
async function safeUpdateProduct(id, updates) {
  const { error } = await supabase.from('tracked_products').update(updates).eq('id', id);
  if (error) {
    const minimalUpdates = {
      status: updates.status,
      last_price: updates.last_price,
      last_discount: updates.last_discount,
      alert_sent: updates.alert_sent,
      last_checked_at: updates.last_checked_at
    };
    if (updates.name) minimalUpdates.name = updates.name;
    await supabase.from('tracked_products').update(minimalUpdates).eq('id', id);
  }
}

// =========================================================================
// 24x7 BACKGROUND CHECKER LOOP
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
      const res = await fetchProductLive(p);
      const nowIso = new Date().toISOString();

      if (!res.ok) {
        await safeUpdateProduct(p.id, {
          last_checked_at: nowIso,
          error_message: res.error
        });
        continue;
      }

      const updates = {
        last_checked_at: nowIso,
        error_message: null,
        last_price: res.price || p.last_price,
        last_mrp: res.mrp || p.last_mrp,
        last_discount: res.discount || 0
      };

      if (res.title && (!p.name || p.name === 'Flipkart Product')) {
        updates.name = res.title;
      }

      if (!res.inStock) {
        updates.status = 'OUT_OF_STOCK';
        updates.alert_sent = false; // Rearm trigger for when stock comes back
      } else {
        if (p.mode === 'PRICE') {
          const targetP = Number(p.target_price) || 0;
          if (res.price && res.price <= targetP) {
            updates.status = 'PRICE_HIT';
            if (!p.alert_sent) {
              updates.alert_sent = true;
              await sendTelegram(
                { ...p, ...updates },
                res,
                `PRICE DROP ALERT (₹${res.price.toLocaleString('en-IN')} ≤ ₹${targetP.toLocaleString('en-IN')})!`
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
          // STOCK MODE: Instant alert whenever item is detected IN_STOCK (and alert_sent is false)
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
      console.log(`🔍 [${p.pincode}] ${updates.name || p.name} | Status: ${updates.status} | Price: ₹${updates.last_price || '-'} | Disc: ${updates.last_discount}%`);
      await new Promise(r => setTimeout(r, 4000));
    }
  } catch (e) {
    console.error('Loop error:', e.message);
  } finally {
    isRunning = false;
  }
}

setInterval(checkAllProducts, CHECK_INTERVAL_SEC * 1000);

// =========================================================================
// COMPLETE DASHBOARD UI
// =========================================================================
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Flipkart 24×7 Stock, Price & Discount Tracker</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen p-4 md:p-8">
  <div class="max-w-4xl mx-auto">
    <div class="flex flex-wrap items-center justify-between gap-4 mb-6 border-b border-slate-800 pb-4">
      <div>
        <div class="flex items-center gap-2">
          <span class="h-3 w-3 rounded-full bg-emerald-500 animate-pulse"></span>
          <h1 class="text-2xl font-bold text-blue-400">Flipkart 24×7 Stock, Price & Discount Tracker</h1>
        </div>
        <p class="text-xs text-slate-400 mt-1">Har 35 second mein live check • Stock, Price Drop & Discount % par instant Telegram Alert</p>
      </div>
      <div class="flex gap-2">
        <button onclick="testTg()" class="bg-emerald-600 hover:bg-emerald-500 px-4 py-2 rounded-lg text-sm font-medium cursor-pointer">Test Telegram</button>
        <button onclick="logout()" class="bg-slate-800 hover:bg-slate-700 px-3 py-2 rounded-lg text-sm cursor-pointer">Logout</button>
      </div>
    </div>

    <!-- Login Box -->
    <div id="loginBox" class="max-w-sm mx-auto bg-slate-900 border border-slate-800 rounded-xl p-6 mt-12 hidden">
      <h2 class="text-lg font-semibold mb-1">Admin Login</h2>
      <p class="text-xs text-slate-400 mb-3">Password: <code class="text-blue-400">admin123</code></p>
      <input type="password" id="pwd" placeholder="Enter Dashboard Password" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-sm mb-3" />
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
            <label class="text-xs text-emerald-400">Target Max Amount (₹) *</label>
            <input type="number" id="targetPrice" min="1" placeholder="e.g. 400 (₹400 ya niche aane par)" class="w-full bg-slate-950 border border-emerald-500/50 rounded-lg px-3 py-2 text-sm mt-1" />
          </div>
          <div id="discDiv" class="md:col-span-4 hidden">
            <label class="text-xs text-amber-400">Target Discount % *</label>
            <input type="number" id="targetDiscount" min="1" max="99" placeholder="e.g. 50 (50% ya zyada OFF par)" class="w-full bg-slate-950 border border-amber-500/50 rounded-lg px-3 py-2 text-sm mt-1" />
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
        <h2 class="text-base font-semibold text-slate-200">Active Tracking List (Live Data)</h2>
        <button onclick="loadList()" class="text-xs bg-slate-800 hover:bg-slate-700 px-3 py-1 rounded cursor-pointer">Refresh Now</button>
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

        return \`
          <div class="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col md:flex-row justify-between gap-3">
            <div class="space-y-1.5">
              <div class="flex items-center gap-2 flex-wrap">
                <a href="\${p.url}" target="_blank" class="font-semibold text-slate-100 hover:text-blue-400">\${p.name}</a>
                \${statusBadge}
                \${targetTag}
              </div>
              <div class="text-xs text-slate-400 flex flex-wrap gap-4">
                <span>📍 PIN: <b class="text-slate-200">\${p.pincode}</b></span>
                <span>💰 Live Price: <b class="text-slate-200">\${p.last_price ? '₹' + Number(p.last_price).toLocaleString('en-IN') : '-'}</b></span>
                <span>🏷️ MRP: <b class="text-slate-400">\${p.last_mrp ? '₹' + Number(p.last_mrp).toLocaleString('en-IN') : '-'}</b></span>
                <span>🔥 Live Discount: <b class="text-emerald-400">\${p.last_discount || 0}% OFF</b></span>
                <span>🕒 Checked: \${p.last_checked_at ? new Date(p.last_checked_at).toLocaleTimeString('en-IN') : 'Checking...'}</span>
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
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
      alert(res.ok ? '✅ Telegram Test Alert Sent!' : '❌ Failed - Check Bot Admin permissions');
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
app.get('/ping', (req, res) => res.send('OK - 24x7 Active'));

app.get('/api/products', checkAuth, async (req, res) => {
  const { data, error } = await supabase.from('tracked_products').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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
    { title: 'Render + Supabase 24x7 Tracker Active!', price: 82900, mrp: 89900, discount: 8 },
    'TEST ALERT SUCCESSFUL!'
  );
  res.status(r.ok ? 200 : 500).json(r);
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  checkAllProducts();
});