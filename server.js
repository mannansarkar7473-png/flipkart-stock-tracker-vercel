const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// =========================================================================
// PRE-CONFIGURED CREDENTIALS (Supabase + Telegram + ScraperAPI + EarnKaro)
// =========================================================================
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://vpqhayqkovxerxertwuv.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZwcWhheXFrb3Z4ZXJ4ZXJ0d3V2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUwNzI1MzYsImV4cCI6MjExMDY0ODUzNn0.3vAnKw1pzzVMt4MWmKIh82Qgghkf_6rL9EtDD0W-ZOc';
const BOT_TOKEN = process.env.BOT_TOKEN || '9242430164:AAEAAIcATBMTKDgTevoef5TekjniPP-7dSI';
const CHAT_ID = process.env.CHAT_ID || '-1004305890096';
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || 'd8c5f8bb94d6c8e304c5ecf9d55bb57f';
const EARNKARO_TOKEN = process.env.EARNKARO_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfaWQiOiI2NmQ5ZGUzZmY4YjQ0MTg3OTVkN2JiYzYiLCJlYXJua2FybyI6IjM3NDQzNTgiLCJpYXQiOjE3OTUxMjA0MTF9.Ck58ZbaopkF5nTtiEnMoGh9yuGfulKkORJR-rZlRmAw';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const CHECK_INTERVAL_SEC = 180;
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
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
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
// EARNKARO AFFILIATE LINK CONVERTER
// =========================================================================
async function convertToEarnKaro(originalUrl) {
  if (!EARNKARO_TOKEN) return originalUrl;
  try {
    const res = await axios.post(
      'https://ekaro-api.affiliaters.in/api/converter/public',
      {
        deal: originalUrl,
        convert_option: 'convert_only'
      },
      {
        headers: {
          'Authorization': `Bearer ${EARNKARO_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    const data = res.data;
    if (typeof data?.data === 'string' && data.data.startsWith('http')) {
      return data.data.trim();
    }
    const rawStr = JSON.stringify(data || {});
    const urlMatch = rawStr.match(/https?:\/\/[^\s"\\]+/);
    if (urlMatch && urlMatch[0] && !urlMatch[0].includes('flipkart.com')) {
      return urlMatch[0];
    }
  } catch (err) {
    console.error('⚠️ EarnKaro Convert Fallback:', err.response?.data?.message || err.message);
  }
  return originalUrl;
}

// =========================================================================
// RICH TELEGRAM ALERT (EARNKARO LINK + HIDDEN OFFERS + PHOTO)
// =========================================================================
async function sendTelegram(product, info, heading) {
  const title = (info.title || product.name || 'Flipkart Product').replace(/[*_`\[\]()]/g, '');
  const price = Number(info.price) || 0;
  const mrp = Number(info.mrp) || 0;

  const affiliateUrl = await convertToEarnKaro(product.url);

  const mrpPart = mrp > price && price > 0 ? ` (MRP: ~₹${mrp.toLocaleString('en-IN')}~)` : '';
  const priceText = price > 0 ? `₹${price.toLocaleString('en-IN')}` : 'Check Link';

  const offersBlock = info.offers && info.offers.length > 0
    ? `\n🎁 *Hidden / Special Offers:*\n${info.offers.map(o => `• ${o.replace(/[*_`\[\]()]/g, '')}`).join('\n')}\n`
    : '';

  const caption =
    `🚨 *${heading}* 🚨\n\n` +
    `📦 *Product:* ${title}\n` +
    `📍 *Pin Code:* \`${product.pincode}\` (Available ✅)\n` +
    `💰 *Live Price:* ${priceText}${mrpPart}\n` +
    offersBlock +
    `\n👉 *Order Link:* ${affiliateUrl}`;

  const replyMarkup = {
    inline_keyboard: [[{ text: '🛒 BUY NOW ON FLIPKART', url: affiliateUrl }]]
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
      if (r.data?.ok) return { ok: true, affiliateUrl };
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
    return { ok: Boolean(r.data?.ok), affiliateUrl };
  } catch (err) {
    console.error('❌ Telegram Error:', err.response?.data?.description || err.message);
    return { ok: false, error: err.response?.data?.description || err.message };
  }
}

// =========================================================================
// HTML DOM + HIDDEN OFFERS & COUPONS + LD+JSON EXTRACTOR
// =========================================================================
function extractFromHtml(html, targetPid) {
  const $ = cheerio.load(html);
  let title = null;
  let price = null;
  let mrp = null;
  let image = null;
  let inStock = null;
  const offersList = [];

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

  if (!image) {
    const imgSrc =
      $('img.DByuf4.IZexXJ').attr('src') ||
      $('img._396cs4._2amPTt._3qGmMb').attr('src') ||
      $('meta[property="og:image"]').attr('content');
    if (imgSrc && imgSrc.startsWith('http')) image = imgSrc;
  }

  const offerSelectors = ['li.kF1m4z', 'li._16eBzU', 'div.cPHDOP span', 'div._3TT44I', 'span.ynXjOy'];
  for (const sel of offerSelectors) {
    $(sel).each((_, el) => {
      let txt = $(el).text().replace(/\s+/g, ' ').trim();
      txt = txt.replace(/T&C$/i, '').replace(/View Plans$/i, '').trim();
      if (
        txt.length > 10 &&
        txt.length < 160 &&
        (txt.toLowerCase().includes('off') ||
          txt.toLowerCase().includes('coupon') ||
          txt.toLowerCase().includes('cashback') ||
          txt.toLowerCase().includes('special price') ||
          txt.toLowerCase().includes('bank'))
      ) {
        if (!offersList.includes(txt) && offersList.length < 4) {
          offersList.push(txt);
        }
      }
    });
  }

  const couponMatch = $('body').text().match(/(₹\s*\d+\s*off\s*(?:applied|with coupon|extra)[^.\n]{0,45})/i);
  if (couponMatch && couponMatch[1]) {
    const cText = couponMatch[1].replace(/\s+/g, ' ').trim();
    if (!offersList.some(o => o.includes(cText))) {
      offersList.unshift(`🎟️ Coupon: ${cText}`);
    }
  }

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
          if (inStock === null && td.productStatus) {
            const st = String(td.productStatus).toUpperCase();
            if (st.includes('OUT_OF_STOCK') || st.includes('SOLD_OUT')) inStock = false;
            else if (st.includes('IN_STOCK')) inStock = true;
          }
        }
      }
    } catch (e) {}
  }

  return { title, price, mrp, image, inStock, offers: offersList.slice(0, 4) };
}

// =========================================================================
// MASTER FETCHER (Direct Try -> ScraperAPI India Residential IP)
// =========================================================================
async function fetchProductHybrid(product) {
  const u = new URL(product.url);
  const pid = product.pid || u.searchParams.get('pid');

  try {
    const directRes = await axios.get(product.url, {
      headers: {
        'User-Agent': getRandomUA(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-IN,en-GB;q=0.9,en;q=0.8'
      },
      timeout: 8000
    });
    const html = String(directRes.data || '');
    if (!html.includes('captcha') && !html.includes('Are you a human')) {
      const extracted = extractFromHtml(html, pid);
      if (extracted.price || extracted.title) {
        return {
          ok: true,
          inStock: extracted.inStock === null ? true : extracted.inStock,
          title: extracted.title,
          price: extracted.price,
          mrp: extracted.mrp,
          image: extracted.image,
          offers: extracted.offers,
          source: 'Direct'
        };
      }
    }
  } catch (e) {}

  if (SCRAPER_API_KEY) {
    try {
      const proxyUrl = `https://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&country_code=in&url=${encodeURIComponent(product.url)}`;
      const proxyRes = await axios.get(proxyUrl, { timeout: 35000 });
      const html = String(proxyRes.data || '');
      const extracted = extractFromHtml(html, pid);

      if (extracted.price || extracted.title || extracted.inStock !== null) {
        return {
          ok: true,
          inStock: extracted.inStock === null ? true : extracted.inStock,
          title: extracted.title,
          price: extracted.price,
          mrp: extracted.mrp,
          image: extracted.image,
          offers: extracted.offers,
          source: 'ScraperAPI India IP'
        };
      }
    } catch (err) {
      const msg = err.response?.data || err.message;
      return { ok: false, error: `Proxy error: ${String(msg).slice(0, 60)}` };
    }
  }

  return { ok: false, error: 'Retrying in next cycle' };
}

async function safeUpdateProduct(id, updates) {
  const { error } = await supabase.from('tracked_products').update(updates).eq('id', id);
  if (error) {
    const fallback = {
      status: updates.status,
      last_price: updates.last_price,
      alert_sent: updates.alert_sent,
      last_checked_at: updates.last_checked_at
    };
    if (updates.name) fallback.name = updates.name;
    await supabase.from('tracked_products').update(fallback).eq('id', id);
  }
}

// =========================================================================
// CONTINUOUS 24x7 REFRESH & AUTO RE-ARM WORKER
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
      const offersJoined = res.offers && res.offers.length > 0 ? res.offers.join(' | ') : null;

      const updates = {
        last_checked_at: nowIso,
        error_message: null,
        last_price: livePrice,
        last_mrp: res.mrp || p.last_mrp,
        lowest_price: newLowest,
        offers_text: offersJoined
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
      console.log(`✅ [${res.source}] [${p.pincode}] ${updates.name || p.name} | ${updates.status} | ₹${updates.last_price || '-'}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (e) {
    console.error('Loop error:', e.message);
  } finally {
    isRunning = false;
  }
}

setInterval(checkAllProducts, CHECK_INTERVAL_SEC * 1000);

// =========================================================================
// CLEAN BUG-FREE DASHBOARD HTML (NO NESTED TEMPLATE LITERALS)
// =========================================================================
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Flipkart Sniper + EarnKaro Auto-Poster</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen p-4 md:p-8">
  <div class="max-w-5xl mx-auto">
    <div class="flex flex-wrap items-center justify-between gap-4 mb-6 border-b border-slate-800 pb-4">
      <div>
        <div class="flex items-center gap-2.5 flex-wrap">
          <span class="h-3 w-3 rounded-full bg-emerald-500 animate-pulse"></span>
          <h1 class="text-xl md:text-2xl font-bold text-blue-400">Flipkart Sniper 24×7</h1>
          <span class="text-xs px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">EarnKaro Auto-Link Active</span>
        </div>
        <p class="text-xs text-slate-400 mt-1">Continuous Stock & Target Price Monitoring • Hidden Coupons • Auto EarnKaro Telegram Post</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button type="button" onclick="forceCheck()" id="scanBtn" class="bg-blue-600 hover:bg-blue-500 px-3 py-2 rounded-lg text-xs md:text-sm font-medium cursor-pointer">Scan Now</button>
        <button type="button" onclick="testTg()" id="testBtn" class="bg-emerald-600 hover:bg-emerald-500 px-3 py-2 rounded-lg text-xs md:text-sm font-medium cursor-pointer">Test Telegram + EarnKaro</button>
        <button type="button" onclick="logout()" class="bg-slate-800 hover:bg-slate-700 px-3 py-2 rounded-lg text-xs md:text-sm cursor-pointer">Logout</button>
      </div>
    </div>

    <!-- Login Box -->
    <div id="loginBox" class="max-w-sm mx-auto bg-slate-900 border border-slate-800 rounded-xl p-6 mt-10">
      <h2 class="text-lg font-semibold mb-1">Admin Login</h2>
      <p class="text-xs text-slate-400 mb-3">Default Password: <code class="text-blue-400">admin123</code></p>
      <input type="password" id="pwd" placeholder="Enter Password" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-sm mb-3 text-white" />
      <button type="button" onclick="doLogin()" class="w-full bg-blue-600 hover:bg-blue-500 py-2.5 rounded-lg text-sm font-medium cursor-pointer">Login</button>
      <p id="loginErr" class="text-rose-400 text-xs mt-2"></p>
    </div>

    <!-- Main App -->
    <div id="appBox" class="hidden">
      <div class="bg-slate-900 border border-slate-800 rounded-xl p-5 mb-6 shadow-lg">
        <h2 class="text-base font-semibold mb-4 text-slate-200">+ Naya Product Track Karein</h2>
        <form id="addForm" class="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div class="md:col-span-6">
            <label class="text-xs text-slate-400">Flipkart Product Link *</label>
            <input type="url" id="url" required plac
