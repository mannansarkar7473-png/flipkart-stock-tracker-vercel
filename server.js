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
// Comma-separated keys supported (e.g. "key1,key2") for automatic rotation
const SCRAPER_API_KEYS = (process.env.SCRAPER_API_KEY || 'd8c5f8bb94d6c8e304c5ecf9d55bb57f')
  .split(',')
  .map(k => k.trim())
  .filter(Boolean);
const EARNKARO_TOKEN = process.env.EARNKARO_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfaWQiOiI2NmQ5ZGUzZmY4YjQ0MTg3OTVkN2JiYzYiLCJlYXJua2FybyI6IjM3NDQzNTgiLCJpYXQiOjE3OTUxMjA0MTF9.Ck58ZbaopkF5nTtiEnMoGh9yuGfulKkORJR-rZlRmAw';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const CHECK_INTERVAL_SEC = 180;
const REQUEST_GAP_MS = 6500; // Strict 6.5s gap between requests so multiple products never collide
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
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1'
];

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function parsePriceNumber(str) {
  if (!str) return null;
  const cleaned = String(str).replace(/[^0-9.]/g, '');
  const num = parseFloat(cleaned);
  return !isNaN(num) && num > 0 ? Math.round(num) : null;
}

// =========================================================================
// MULTI-STORE URL CLEANER (Amazon, Flipkart, Myntra, Nykaa)
// =========================================================================
function detectAndCleanUrl(rawUrl) {
  try {
    const u = new URL(rawUrl.trim());
    const host = u.hostname.toLowerCase();

    if (host.includes('flipkart.com')) {
      const pid = u.searchParams.get('pid');
      const lid = u.searchParams.get('lid');
      let clean = `${u.origin}${u.pathname}`;
      const q = [];
      if (pid) q.push(`pid=${pid}`);
      if (lid) q.push(`lid=${lid}`);
      if (q.length) clean += `?${q.join('&')}`;
      return { store: 'FLIPKART', clean, pid, lid };
    }

    if (host.includes('amazon.in') || host.includes('amazon.com') || host.includes('amzn.')) {
      const asinMatch = u.pathname.match(/\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})/i);
      const asin = asinMatch ? asinMatch[1].toUpperCase() : null;
      const clean = asin && host.includes('amazon.')
        ? `${u.origin}/dp/${asin}`
        : `${u.origin}${u.pathname}`;
      return { store: 'AMAZON', clean, pid: asin, lid: null };
    }

    if (host.includes('myntra.com')) {
      const clean = `${u.origin}${u.pathname}`;
      const idMatch = u.pathname.match(/\/(\d+)\/buy/i);
      return { store: 'MYNTRA', clean, pid: idMatch ? idMatch[1] : null, lid: null };
    }

    if (host.includes('nykaa.com')) {
      const clean = `${u.origin}${u.pathname}`;
      const idMatch = u.pathname.match(/\/p\/(\d+)/i);
      return { store: 'NYKAA', clean, pid: idMatch ? idMatch[1] : null, lid: null };
    }

    return null;
  } catch {
    return null;
  }
}

function getStoreFromUrl(url) {
  const s = String(url || '').toLowerCase();
  if (s.includes('amazon.') || s.includes('amzn.')) return 'AMAZON';
  if (s.includes('myntra.')) return 'MYNTRA';
  if (s.includes('nykaa.')) return 'NYKAA';
  return 'FLIPKART';
}

// =========================================================================
// SILENT AUTO AFFILIATE LINK CONVERTER (ALL 4 STORES VIA EARNKARO)
// =========================================================================
async function convertAffiliateLink(originalUrl) {
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
    if (
      urlMatch &&
      urlMatch[0] &&
      !urlMatch[0].includes('flipkart.com') &&
      !urlMatch[0].includes('amazon.in') &&
      !urlMatch[0].includes('myntra.com') &&
      !urlMatch[0].includes('nykaa.com')
    ) {
      return urlMatch[0];
    }
  } catch (err) {
    console.error('⚠️ Affiliate Link Fallback:', err.response?.data?.message || err.message);
  }
  return originalUrl;
}

// =========================================================================
// TELEGRAM ALERT SENDER
// =========================================================================
async function sendTelegram(product, info, heading) {
  const store = getStoreFromUrl(product.url);
  const title = (info.title || product.name || `${store} Product`).replace(/[*_`\[\]()]/g, '');
  const price = Number(info.price) || 0;
  const mrp = Number(info.mrp) || 0;

  const finalLink = await convertAffiliateLink(product.url);

  const mrpPart = mrp > price && price > 0 ? ` (MRP: ~₹${mrp.toLocaleString('en-IN')}~)` : '';
  const priceText = price > 0 ? `₹${price.toLocaleString('en-IN')}` : 'Check Link';

  const offersBlock = info.offers && info.offers.length > 0
    ? `\n🎁 *Hidden / Special Offers:*\n${info.offers.map(o => `• ${o.replace(/[*_`\[\]()]/g, '')}`).join('\n')}\n`
    : '';

  const caption =
    `🚨 *${heading}* 🚨\n\n` +
    `🏪 *Store:* ${store}\n` +
    `📦 *Product:* ${title}\n` +
    `📍 *Pin Code:* \`${product.pincode}\` (Available ✅)\n` +
    `💰 *Live Price:* ${priceText}${mrpPart}\n` +
    offersBlock +
    `\n👉 *Order Link:* ${finalLink}`;

  const replyMarkup = {
    inline_keyboard: [[{ text: `🛒 BUY NOW ON ${store}`, url: finalLink }]]
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
// STORE-SPECIFIC EXTRACTORS (FLIPKART, AMAZON, MYNTRA, NYKAA)
// =========================================================================
function extractSchemaBase($) {
  let title = null;
  let price = null;
  let mrp = null;
  let image = null;
  let inStock = null;

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
            const imgObj = Array.isArray(item.image) ? item.image[0] : item.image;
            image = typeof imgObj === 'string' ? imgObj : imgObj?.url || null;
          }
          const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
          if (offers) {
            if (offers.price && !price) price = parsePriceNumber(offers.price);
            if (offers.highPrice && !mrp) mrp = parsePriceNumber(offers.highPrice);
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

  if (!image) {
    const ogImg = $('meta[property="og:image"]').attr('content');
    if (ogImg && ogImg.startsWith('http')) image = ogImg;
  }

  return { title, price, mrp, image, inStock };
}

function parseFlipkartHtml(html, targetPid) {
  const $ = cheerio.load(html);
  const base = extractSchemaBase($);
  let { title, price, mrp, image, inStock } = base;
  const offersList = [];

  for (const sel of ['span.VU-ZEz', 'span.B_NuCI', 'h1._6EBuvT span', 'h1']) {
    const t = $(sel).first().text().trim();
    if (t && t.length > 3 && !title) { title = t.replace(/\s+/g, ' '); break; }
  }
  for (const sel of ['div.Nx9bqj.CxhGGd', 'div.Nx9bqj', 'div._30jeq3._16Jk6d', 'div._30jeq3']) {
    const p = parsePriceNumber($(sel).first().text());
    if (p && !price) { price = p; break; }
  }
  for (const sel of ['div.yRaY8j.A6\\+E6v', 'div.yRaY8j', 'div._3I9_wc._2p6lqe', 'div._3I9_wc']) {
    const m = parsePriceNumber($(sel).first().text());
    if (m && (!price || m >= price) && !mrp) { mrp = m; break; }
  }
  if (!image) {
    const imgSrc = $('img.DByuf4.IZexXJ').attr('src') || $('img._396cs4._2amPTt._3qGmMb').attr('src');
    if (imgSrc && imgSrc.startsWith('http')) image = imgSrc;
  }

  for (const sel of ['li.kF1m4z', 'li._16eBzU', 'div.cPHDOP span', 'div._3TT44I', 'span.ynXjOy']) {
    $(sel).each((_, el) => {
      let txt = $(el).text().replace(/\s+/g, ' ').trim().replace(/T&C$/i, '').replace(/View Plans$/i, '').trim();
      if (txt.length > 10 && txt.length < 160 && /(off|coupon|cashback|special price|bank)/i.test(txt)) {
        if (!offersList.includes(txt) && offersList.length < 4) offersList.push(txt);
      }
    });
  }
  const couponMatch = $('body').text().match(/(₹\s*\d+\s*off\s*(?:applied|with coupon|extra)[^.\n]{0,45})/i);
  if (couponMatch && couponMatch[1]) {
    const cText = couponMatch[1].replace(/\s+/g, ' ').trim();
    if (!offersList.some(o => o.includes(cText))) offersList.unshift(`🎟️ Coupon: ${cText}`);
  }

  const bodyText = $('body').text();
  if (bodyText.includes('Currently out of stock') || bodyText.includes('Sold Out') || $('button:contains("Notify Me")').length > 0) {
    inStock = false;
  } else if ($('button:contains("Buy Now")').length > 0 || $('button:contains("Add to cart")').length > 0 || $('button:contains("Go to cart")').length > 0) {
    inStock = true;
  }

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

function parseAmazonHtml(html) {
  const $ = cheerio.load(html);
  const base = extractSchemaBase($);
  let { title, price, mrp, image, inStock } = base;
  const offersList = [];

  const t = $('#productTitle').text().trim();
  if (t) title = t.replace(/\s+/g, ' ');

  const priceSelectors = [
    '.priceToPay .a-price-whole',
    '#corePriceDisplay_desktop_feature_div .a-price-whole',
    '#corePrice_feature_div .a-price-whole',
    '#priceblock_ourprice',
    '#priceblock_dealprice',
    '.a-price .a-offscreen'
  ];
  for (const sel of priceSelectors) {
    const p = parsePriceNumber($(sel).first().text());
    if (p) { price = p; break; }
  }

  const mrpSelectors = [
    '.basisPrice .a-offscreen',
    '#corePriceDisplay_desktop_feature_div .a-text-price .a-offscreen',
    '.a-text-price .a-offscreen'
  ];
  for (const sel of mrpSelectors) {
    const m = parsePriceNumber($(sel).first().text());
    if (m && (!price || m >= price)) { mrp = m; break; }
  }

  const mainImg = $('#landingImage').attr('data-old-hires') || $('#landingImage').attr('src') || $('#imgBlkFront').attr('src');
  if (mainImg && mainImg.startsWith('http')) image = mainImg;

  const couponLabel = $('#couponBadgeRegularVpc, label[id*="couponText"], .promoPriceBlockMessage').first().text().replace(/\s+/g, ' ').trim();
  if (couponLabel && couponLabel.length > 4) {
    offersList.push(`🎟️ Coupon: ${couponLabel.slice(0, 110)}`);
  }
  $('#itembox-InstantBankDiscount .a-truncate-full, .vsx-offers-desktop-lv__item .a-truncate-full').each((_, el) => {
    const txt = $(el).text().replace(/\s+/g, ' ').trim();
    if (txt.length > 10 && txt.length < 150 && !offersList.includes(txt) && offersList.length < 4) {
      offersList.push(txt);
    }
  });

  const availText = $('#availability').text().toLowerCase();
  const hasBuyBtn = $('#add-to-cart-button').length > 0 || $('#buy-now-button').length > 0;
  if (availText.includes('currently unavailable') || availText.includes('out of stock')) {
    inStock = false;
  } else if (availText.includes('in stock') || hasBuyBtn) {
    inStock = true;
  }

  return { title, price, mrp, image, inStock, offers: offersList.slice(0, 4) };
}

function parseMyntraHtml(html) {
  const $ = cheerio.load(html);
  const base = extractSchemaBase($);
  let { title, price, mrp, image, inStock } = base;
  const offersList = [];

  const myxMatch = html.match(/window\.__myx\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
  if (myxMatch && myxMatch[1]) {
    try {
      const myx = JSON.parse(myxMatch[1]);
      const pdp = myx?.pdpData;
      if (pdp) {
        if (pdp.name) title = pdp.name;
        if (pdp.price?.discounted) price = Number(pdp.price.discounted);
        else if (pdp.price?.mrp) price = Number(pdp.price.mrp);
        if (pdp.price?.mrp) mrp = Number(pdp.price.mrp);

        const imgUrl = pdp.media?.albums?.[0]?.images?.[0]?.secureSrc || pdp.media?.albums?.[0]?.images?.[0]?.src;
        if (imgUrl) image = imgUrl.replace('($height)', '720').replace('($width)', '540').replace('($qualityPercentage)', '90');

        if (Array.isArray(pdp.sizes)) {
          inStock = pdp.sizes.some(s => s.available === true);
        }
        if (Array.isArray(pdp.offers)) {
          for (const off of pdp.offers.slice(0, 3)) {
            if (off.title || off.description) offersList.push(`${off.title || ''} ${off.description || ''}`.trim().slice(0, 130));
          }
        }
      }
    } catch (e) {}
  }

  if (!title) {
    const brand = $('.pdp-title').first().text().trim();
    const sub = $('.pdp-name').first().text().trim();
    if (brand || sub) title = `${brand} ${sub}`.trim();
  }
  if (!price) price = parsePriceNumber($('.pdp-price strong').first().text());
  if (!mrp) mrp = parsePriceNumber($('.pdp-mrp s').first().text());

  if (inStock === null) {
    const body = $('body').text();
    if (body.includes('OUT OF STOCK') || body.includes('Sold Out')) inStock = false;
    else if (body.includes('ADD TO BAG')) inStock = true;
  }

  return { title, price, mrp, image, inStock, offers: offersList.slice(0, 4) };
}

function parseNykaaHtml(html) {
  const $ = cheerio.load(html);
  const base = extractSchemaBase($);
  let { title, price, mrp, image, inStock } = base;
  const offersList = [];

  const stateMatch = html.match(/window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
  if (stateMatch && stateMatch[1]) {
    try {
      const st = JSON.parse(stateMatch[1]);
      const prod = st?.productReducer?.product || st?.productPage?.product;
      if (prod) {
        if (prod.name) title = prod.name;
        if (prod.finalPrice) price = Number(prod.finalPrice);
        else if (prod.price) price = Number(prod.price);
        if (prod.mrp) mrp = Number(prod.mrp);
        if (prod.imageUrl) image = prod.imageUrl;
        if (typeof prod.inStock === 'boolean') inStock = prod.inStock;
        if (Array.isArray(prod.offers)) {
          for (const off of prod.offers.slice(0, 3)) {
            const txt = off.title || off.description || off.offerText;
            if (txt) offersList.push(String(txt).trim().slice(0, 130));
          }
        }
      }
    } catch (e) {}
  }

  if (!title) {
    const h1 = $('h1').first().text().trim();
    if (h1) title = h1.replace(/\s+/g, ' ');
  }
  if (inStock === null) {
    const body = $('body').text();
    if (body.includes('Out Of Stock') || body.includes('Sold Out')) inStock = false;
    else if (body.includes('Add to Bag')) inStock = true;
  }

  return { title, price, mrp, image, inStock, offers: offersList.slice(0, 4) };
}

function parseByStore(store, html, pid) {
  if (store === 'AMAZON') return parseAmazonHtml(html);
  if (store === 'MYNTRA') return parseMyntraHtml(html);
  if (store === 'NYKAA') return parseNykaaHtml(html);
  return parseFlipkartHtml(html, pid);
}

// =========================================================================
// GLOBAL SINGLE-THREADED MUTEX + MULTI-KEY ROTATION FETCHER
// (Prevents "multiple users connecting from your IP" even with 50+ products)
// =========================================================================
let proxyMutex = Promise.resolve();
let lastRequestTimestamp = 0;
let keyRotationIndex = 0;

function runInSerialQueue(taskFn) {
  const next = proxyMutex.then(async () => {
    const elapsed = Date.now() - lastRequestTimestamp;
    if (elapsed < REQUEST_GAP_MS) {
      await sleep(REQUEST_GAP_MS - elapsed);
    }
    try {
      return await taskFn();
    } finally {
      lastRequestTimestamp = Date.now();
    }
  });
  proxyMutex = next.catch(() => {});
  return next;
}

async function fetchProductUniversal(product) {
  return runInSerialQueue(async () => {
    const store = getStoreFromUrl(product.url);
    const pid = product.pid || null;

    // 1. Direct Fetch First (Saves proxy concurrency & credits)
    try {
      const directRes = await axios.get(product.url, {
        headers: {
          'User-Agent': getRandomUA(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-IN,en-GB;q=0.9,en;q=0.8',
          'Cache-Control': 'no-cache'
        },
        timeout: 9000
      });
      const html = String(directRes.data || '');
      if (
        !html.includes('captcha') &&
        !html.includes('Are you a human') &&
        !html.includes('Robot Check') &&
        !html.includes('Type the characters you see')
      ) {
        const extracted = parseByStore(store, html, pid);
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

    // 2. ScraperAPI India Residential IP with Automatic Key Rotation & 1 Retry on Shared-IP Limit
    if (SCRAPER_API_KEYS.length > 0) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const apiKey = SCRAPER_API_KEYS[keyRotationIndex % SCRAPER_API_KEYS.length];
        keyRotationIndex++;

        try {
          const proxyUrl = `https://api.scraperapi.com?api_key=${apiKey}&country_code=in&url=${encodeURIComponent(product.url)}`;
          const proxyRes = await axios.get(proxyUrl, { timeout: 35000 });
          const html = String(proxyRes.data || '');

          if (html.includes('multiple users connecting')) {
            await sleep(8000);
            continue;
          }

          const extracted = parseByStore(store, html, pid);
          if (extracted.price || extracted.title || extracted.inStock !== null) {
            return {
              ok: true,
              inStock: extracted.inStock === null ? true : extracted.inStock,
              title: extracted.title,
              price: extracted.price,
              mrp: extracted.mrp,
              image: extracted.image,
              offers: extracted.offers,
              source: 'India IP'
            };
          }
        } catch (err) {
          const rawErr = String(err.response?.data || err.message || '');
          if (rawErr.includes('multiple users connecting') || err.response?.status === 429) {
            await sleep(9000);
            continue;
          }
          return { ok: false, error: `Retrying next cycle (${err.response?.status || 'net'})` };
        }
      }
    }

    return { ok: false, error: 'Queued for next cycle' };
  });
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
// CONTINUOUS 24x7 QUEUE WORKER
// =========================================================================
let isRunning = false;
let scanRequested = false;

async function checkAllProducts() {
  if (isRunning) {
    scanRequested = true;
    return;
  }
  isRunning = true;

  try {
    do {
      scanRequested = false;
      const { data: products, error } = await supabase
        .from('tracked_products')
        .select('*')
        .eq('active', true)
        .order('created_at', { ascending: false });

      if (error || !products || products.length === 0) break;

      for (const p of products) {
        const store = getStoreFromUrl(p.url);
        const res = await fetchProductUniversal(p);
        const nowIso = new Date().toISOString();

        if (!res.ok) {
          await safeUpdateProduct(p.id, {
            last_checked_at: nowIso,
            error_message: res.error
          });
          console.log(`⏳ [${store}] [${p.pincode}] ${p.name}: ${res.error}`);
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
        if (res.title && (!p.name || p.name.endsWith('Product'))) {
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
        console.log(`✅ [${store}] [${p.pincode}] ${updates.name || p.name} | ${updates.status} | ₹${updates.last_price || '-'}`);
      }
    } while (scanRequested);
  } catch (e) {
    console.error('Loop error:', e.message);
  } finally {
    isRunning = false;
  }
}

setInterval(checkAllProducts, CHECK_INTERVAL_SEC * 1000);

// =========================================================================
// ALL-IN-ONE DASHBOARD (AMAZON + FLIPKART + MYNTRA + NYKAA)
// =========================================================================
const HTML = [
  '<!DOCTYPE html>',
  '<html lang="en">',
  '<head>',
  '  <meta charset="UTF-8" />',
  '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
  '  <title>Multi-Store Sniper 24x7</title>',
  '  <script src="https://cdn.tailwindcss.com"></script>',
  '</head>',
  '<body class="bg-slate-950 text-slate-100 min-h-screen p-4 md:p-8">',
  '  <div class="max-w-5xl mx-auto">',
  '    <div class="flex flex-wrap items-center justify-between gap-4 mb-6 border-b border-slate-800 pb-4">',
  '      <div>',
  '        <div class="flex items-center gap-2.5 flex-wrap">',
  '          <span class="h-3 w-3 rounded-full bg-emerald-500 animate-pulse"></span>',
  '          <h1 class="text-xl md:text-2xl font-bold text-blue-400">Multi-Store Sniper 24×7</h1>',
  '        </div>',
  '        <p class="text-xs text-slate-400 mt-1">Amazon • Flipkart • Myntra • Nykaa — Stock & Target Price Monitoring + Auto Telegram Alert</p>',
  '      </div>',
  '      <div class="flex flex-wrap gap-2">',
  '        <button type="button" id="scanBtn" class="bg-blue-600 hover:bg-blue-500 active:scale-95 transition px-3.5 py-2 rounded-lg text-xs md:text-sm font-medium cursor-pointer">Scan Now</button>',
  '        <button type="button" id="testBtn" class="bg-emerald-600 hover:bg-emerald-500 active:scale-95 transition px-3.5 py-2 rounded-lg text-xs md:text-sm font-medium cursor-pointer">Test Telegram</button>',
  '        <button type="button" id="logoutBtn" class="bg-slate-800 hover:bg-slate-700 active:scale-95 transition px-3.5 py-2 rounded-lg text-xs md:text-sm cursor-pointer">Logout</button>',
  '      </div>',
  '    </div>',
  '',
  '    <!-- Login Box -->',
  '    <div id="loginBox" class="max-w-sm mx-auto bg-slate-900 border border-slate-800 rounded-xl p-6 mt-10 hidden">',
  '      <h2 class="text-lg font-semibold mb-1">Admin Login</h2>',
  '      <p class="text-xs text-slate-400 mb-3">Password: <code class="text-blue-400">admin123</code></p>',
  '      <input type="password" id="pwd" placeholder="Enter Password" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-sm mb-3 text-white focus:outline-none focus:border-blue-500" />',
  '      <button type="button" id="loginBtn" class="w-full bg-blue-600 hover:bg-blue-500 active:scale-95 transition py-2.5 rounded-lg text-sm font-medium cursor-pointer">Login</button>',
  '      <p id="loginErr" class="text-rose-400 text-xs mt-2"></p>',
  '    </div>',
  '',
  '    <!-- Main App -->',
  '    <div id="appBox" class="hidden">',
  '      <div class="bg-slate-900 border border-slate-800 rounded-xl p-5 mb-6 shadow-lg">',
  '        <h2 class="text-base font-semibold mb-4 text-slate-200">+ Naya Product Track Karein (Amazon / Flipkart / Myntra / Nykaa)</h2>',
  '        <form id="addForm" class="grid grid-cols-1 md:grid-cols-12 gap-3">',
  '          <div class="md:col-span-6">',
  '            <label class="text-xs text-slate-400">Product Link (Amazon, Flipkart, Myntra, Nykaa) *</label>',
  '            <input type="url" id="url" required placeholder="https://www.amazon.in/... or flipkart / myntra / nykaa" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1 text-white focus:outline-none focus:border-blue-500" />',
  '          </div>',
  '          <div class="md:col-span-2">',
  '            <label class="text-xs text-slate-400">Pin Code *</label>',
  '            <input type="text" id="pincode" required maxlength="6" pattern="[0-9]{6}" value="462023" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1 text-white focus:outline-none focus:border-blue-500" />',
  '          </div>',
  '          <div class="md:col-span-4">',
  '            <label class="text-xs text-slate-400">Alert Condition *</label>',
  '            <select id="mode" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1 text-white focus:outline-none focus:border-blue-500">',
  '              <option value="STOCK">1. Stock Alert (Stock Aane Par)</option>',
  '              <option value="PRICE">2. Target Price (₹ Kam Hone Par)</option>',
  '            </select>',
  '          </div>',
  '          <div id="priceDiv" class="md:col-span-4 hidden">',
  '            <label class="text-xs text-emerald-400">Target Max Price (₹) *</label>',
  '            <input type="number" id="targetPrice" min="1" placeholder="e.g. 800" class="w-full bg-slate-950 border border-emerald-500/50 rounded-lg px-3 py-2 text-sm mt-1 text-white focus:outline-none" />',
  '          </div>',
  '          <div id="nameDiv" class="md:col-span-12">',
  '            <label class="text-xs text-slate-400">Product Name (Optional - Auto Detect Hoga)</label>',
  '            <input type="text" id="name" placeholder="Auto detect from store" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1 text-white focus:outline-none focus:border-blue-500" />',
  '          </div>',
  '          <div class="md:col-span-12 flex justify-end">',
  '            <button type="submit" id="submitBtn" class="bg-blue-600 hover:bg-blue-500 active:scale-95 transition px-6 py-2.5 rounded-lg text-sm font-medium cursor-pointer">Tracking List Mein Jodein</button>',
  '          </div>',
  '        </form>',
  '      </div>',
  '',
  '      <div class="flex items-center justify-between mb-3">',
  '        <h2 class="text-base font-semibold text-slate-200">Active Tracking List (Auto-Refreshing)</h2>',
  '        <button type="button" id="refreshBtn" class="text-xs bg-slate-800 hover:bg-slate-700 active:scale-95 transition px-3 py-1.5 rounded cursor-pointer">Refresh List</button>',
  '      </div>',
  '      <div id="list" class="space-y-3"></div>',
  '    </div>',
  '  </div>',
  '',
  '  <script>',
  '    (function() {',
  '      var token = localStorage.getItem("fk_pass") || "";',
  '',
  '      function byId(id) { return document.getElementById(id); }',
  '',
  '      function showLogin(msg) {',
  '        byId("appBox").classList.add("hidden");',
  '        byId("loginBox").classList.remove("hidden");',
  '        byId("loginErr").textContent = msg || "";',
  '      }',
  '',
  '      function showApp() {',
  '        byId("loginBox").classList.add("hidden");',
  '        byId("appBox").classList.remove("hidden");',
  '      }',
  '',
  '      function api(url, opts) {',
  '        opts = opts || {};',
  '        opts.headers = Object.assign({}, opts.headers || {}, {',
  '          "Authorization": "Bearer " + token,',
  '          "Content-Type": "application/json"',
  '        });',
  '        return fetch(url, opts);',
  '      }',
  '',
  '      function escHtml(s) {',
  '        return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");',
  '      }',
  '',
  '      function getStoreBadge(url) {',
  '        var u = String(url || "").toLowerCase();',
  '        if (u.indexOf("amazon.") !== -1 || u.indexOf("amzn.") !== -1) {',
  '          return "<span class=\\"px-2 py-0.5 text-xs font-semibold rounded bg-amber-500/20 text-amber-300 border border-amber-500/30\\">AMAZON</span>";',
  '        }',
  '        if (u.indexOf("myntra.") !== -1) {',
  '          return "<span class=\\"px-2 py-0.5 text-xs font-semibold rounded bg-pink-500/20 text-pink-300 border border-pink-500/30\\">MYNTRA</span>";',
  '        }',
  '        if (u.indexOf("nykaa.") !== -1) {',
  '          return "<span class=\\"px-2 py-0.5 text-xs font-semibold rounded bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/30\\">NYKAA</span>";',
  '        }',
  '        return "<span class=\\"px-2 py-0.5 text-xs font-semibold rounded bg-blue-500/20 text-blue-300 border border-blue-500/30\\">FLIPKART</span>";',
  '      }',
  '',
  '      function toggleInputs() {',
  '        var m = byId("mode").value;',
  '        var pDiv = byId("priceDiv");',
  '        var pIn = byId("targetPrice");',
  '        if (m === "PRICE") {',
  '          pDiv.classList.remove("hidden");',
  '          pIn.required = true;',
  '          byId("nameDiv").className = "md:col-span-8";',
  '        } else {',
  '          pDiv.classList.add("hidden");',
  '          pIn.required = false;',
  '          byId("nameDiv").className = "md:col-span-12";',
  '        }',
  '      }',
  '',
  '      function doLogin() {',
  '        var val = byId("pwd").value.trim();',
  '        if (!val) { byId("loginErr").textContent = "Password enter karein"; return; }',
  '        token = val;',
  '        byId("loginBtn").textContent = "Logging in...";',
  '        api("/api/products").then(function(res) {',
  '          byId("loginBtn").textContent = "Login";',
  '          if (res.ok) {',
  '            localStorage.setItem("fk_pass", token);',
  '            showApp();',
  '            loadList();',
  '          } else {',
  '            token = "";',
  '            byId("loginErr").textContent = "Wrong Password! (Default: admin123)";',
  '          }',
  '        }).catch(function() {',
  '          byId("loginBtn").textContent = "Login";',
  '          byId("loginErr").textContent = "Network error, dubara try karein";',
  '        });',
  '      }',
  '',
  '      function logout() {',
  '        localStorage.removeItem("fk_pass");',
  '        token = "";',
  '        byId("pwd").value = "";',
  '        showLogin("");',
  '      }',
  '',
  '      function forceCheck() {',
  '        if (!token) { showLogin("Pehle login karein"); return; }',
  '        var btn = byId("scanBtn");',
  '        btn.textContent = "Scanning...";',
  '        api("/api/scan-now", { method: "POST" }).finally(function() {',
  '          setTimeout(function() {',
  '            btn.textContent = "Scan Now";',
  '            loadList();',
  '          }, 5000);',
  '        });',
  '      }',
  '',
  '      function testTg() {',
  '        if (!token) { showLogin("Pehle login karein"); return; }',
  '        var btn = byId("testBtn");',
  '        btn.textContent = "Sending...";',
  '        api("/api/test-telegram", { method: "POST" }).then(function(res) {',
  '          btn.textContent = "Test Telegram";',
  '          alert(res.ok ? "✅ Telegram Alert Sent!" : "❌ Failed - Check Bot Permissions");',
  '        }).catch(function() {',
  '          btn.textContent = "Test Telegram";',
  '          alert("❌ Network Error");',
  '        });',
  '      }',
  '',
  '      function loadList() {',
  '        if (!token) { showLogin(""); return; }',
  '        api("/api/products").then(function(res) {',
  '          if (!res.ok) {',
  '            localStorage.removeItem("fk_pass");',
  '            token = "";',
  '            showLogin("Session expired, dubara login karein");',
  '            return null;',
  '          }',
  '          showApp();',
  '          return res.json();',
  '        }).then(function(items) {',
  '          if (!items) return;',
  '          var box = byId("list");',
  '          if (!items.length) {',
  '            box.innerHTML = "<div class=\\"text-center py-8 text-slate-500 text-sm bg-slate-900 border border-slate-800 rounded-xl\\">Abhi koi product add nahi hai. Upar Amazon, Flipkart, Myntra ya Nykaa ka link daal kar add karein.</div>";',
  '            return;',
  '          }',
  '          var out = "";',
  '          for (var i = 0; i < items.length; i++) {',
  '            var p = items[i];',
  '            var storeBadge = getStoreBadge(p.url);',
  '            var statusBadge = "<span class=\\"px-2.5 py-0.5 text-xs rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30\\">" + escHtml(p.status) + "</span>";',
  '            if (p.status === "IN_STOCK" || p.status === "PRICE_HIT") {',
  '              statusBadge = "<span class=\\"px-2.5 py-0.5 text-xs rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-semibold\\">" + escHtml(p.status) + " ✅</span>";',
  '            } else if (p.status === "OUT_OF_STOCK") {',
  '              statusBadge = "<span class=\\"px-2.5 py-0.5 text-xs rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/30\\">OUT OF STOCK</span>";',
  '            } else if (p.status === "WAITING_PRICE") {',
  '              statusBadge = "<span class=\\"px-2.5 py-0.5 text-xs rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30\\">In Stock (Waiting ≤ ₹" + escHtml(p.target_price) + ")</span>";',
  '            }',
  '',
  '            var targetTag = "<span class=\\"px-2 py-0.5 text-xs rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/20\\">Mode: Stock Alert</span>";',
  '            if (p.mode === "PRICE") {',
  '              targetTag = "<span class=\\"px-2 py-0.5 text-xs rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20\\">Target Price: ≤ ₹" + escHtml(p.target_price) + "</span>";',
  '            }',
  '',
  '            var thumb = p.image_url',
  '              ? "<img src=\\"" + escHtml(p.image_url) + "\\" class=\\"w-14 h-14 object-contain bg-white rounded-lg p-1 shrink-0\\" />"',
  '              : "<div class=\\"w-14 h-14 bg-slate-800 rounded-lg flex items-center justify-center text-xs text-slate-500 shrink-0\\">ITEM</div>";',
  '',
  '            var offersHtml = p.offers_text',
  '              ? "<div class=\\"text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded px-2.5 py-1 mt-1.5\\">🎁 <b>Offers:</b> " + escHtml(p.offers_text) + "</div>"',
  '              : "";',
  '',
  '            var errLine = p.error_message',
  '              ? "<div class=\\"text-xs text-slate-400 mt-1\\">⏳ " + escHtml(p.error_message) + "</div>"',
  '              : "";',
  '',
  '            var priceStr = p.last_price ? "₹" + Number(p.last_price).toLocaleString("en-IN") : "-";',
  '            var mrpStr = p.last_mrp ? "₹" + Number(p.last_mrp).toLocaleString("en-IN") : "-";',
  '            var lowStr = p.lowest_price ? "₹" + Number(p.lowest_price).toLocaleString("en-IN") : "-";',
  '            var timeStr = p.last_checked_at ? new Date(p.last_checked_at).toLocaleTimeString("en-IN") : "Checking...";',
  '',
  '            out += "<div class=\\"bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-4\\">" +',
  '              "<div class=\\"flex items-start gap-3.5\\">" + thumb +',
  '                "<div class=\\"space-y-1.5\\">" +',
  '                  "<div class=\\"flex items-center gap-2 flex-wrap\\">" +',
  '                    storeBadge +',
  '                    "<a href=\\"" + escHtml(p.url) + "\\" target=\\"_blank\\" class=\\"font-semibold text-slate-100 hover:text-blue-400\\">" + escHtml(p.name) + "</a>" +',
  '                    statusBadge + targetTag +',
  '                  "</div>" +',
  '                  "<div class=\\"text-xs text-slate-400 flex flex-wrap gap-x-4 gap-y-1\\">" +',
  '                    "<span>📍 PIN: <b class=\\"text-slate-200\\">" + escHtml(p.pincode) + "</b></span>" +',
  '                    "<span>💰 Live Price: <b class=\\"text-slate-100\\">" + priceStr + "</b></span>" +',
  '                    "<span>🏷️ MRP: <b class=\\"text-slate-400\\">" + mrpStr + "</b></span>" +',
  '                    "<span>📉 Lowest: <b class=\\"text-blue-300\\">" + lowStr + "</b></span>" +',
  '                    "<span>🕒 " + timeStr + "</span>" +',
  '                  "</div>" + offersHtml + errLine +',
  '                "</div>" +',
  '              "</div>" +',
  '              "<div class=\\"flex items-center gap-2 shrink-0 self-end md:self-center\\">" +',
  '                "<button type=\\"button\\" data-action=\\"toggle\\" data-id=\\"" + escHtml(p.id) + "\\" data-active=\\"" + (!p.active) + "\\" class=\\"action-btn px-3 py-1.5 text-xs rounded bg-slate-800 hover:bg-slate-700 cursor-pointer\\">" + (p.active ? "Pause" : "Resume") + "</button>" +',
  '                "<button type=\\"button\\" data-action=\\"delete\\" data-id=\\"" + escHtml(p.id) + "\\" class=\\"action-btn px-3 py-1.5 text-xs rounded bg-rose-950 text-rose-300 border border-rose-800/40 cursor-pointer\\">Delete</button>" +',
  '              "</div>" +',
  '            "</div>";',
  '          }',
  '          box.innerHTML = out;',
  '        }).catch(function() {',
  '          showLogin("Network error, dubara try karein");',
  '        });',
  '      }',
  '',
  '      byId("loginBtn").addEventListener("click", doLogin);',
  '      byId("pwd").addEventListener("keydown", function(e) { if (e.key === "Enter") doLogin(); });',
  '      byId("logoutBtn").addEventListener("click", logout);',
  '      byId("scanBtn").addEventListener("click", forceCheck);',
  '      byId("testBtn").addEventListener("click", testTg);',
  '      byId("refreshBtn").addEventListener("click", loadList);',
  '      byId("mode").addEventListener("change", toggleInputs);',
  '',
  '      byId("list").addEventListener("click", function(e) {',
  '        var btn = e.target.closest(".action-btn");',
  '        if (!btn) return;',
  '        var id = btn.getAttribute("data-id");',
  '        var action = btn.getAttribute("data-action");',
  '        if (action === "toggle") {',
  '          var active = btn.getAttribute("data-active") === "true";',
  '          api("/api/products/" + id, { method: "PATCH", body: JSON.stringify({ active: active }) }).then(loadList);',
  '        } else if (action === "delete") {',
  '          api("/api/products/" + id, { method: "DELETE" }).then(loadList);',
  '        }',
  '      });',
  '',
  '      byId("addForm").addEventListener("submit", function(e) {',
  '        e.preventDefault();',
  '        var sBtn = byId("submitBtn");',
  '        sBtn.textContent = "Adding...";',
  '        var body = {',
  '          url: byId("url").value,',
  '          pincode: byId("pincode").value,',
  '          mode: byId("mode").value,',
  '          targetPrice: byId("targetPrice").value,',
  '          name: byId("name").value',
  '        };',
  '        api("/api/products", { method: "POST", body: JSON.stringify(body) }).then(function(res) {',
  '          sBtn.textContent = "Tracking List Mein Jodein";',
  '          if (res.ok) {',
  '            byId("url").value = "";',
  '            byId("name").value = "";',
  '            byId("targetPrice").value = "";',
  '            loadList();',
  '            setTimeout(loadList, 5500);',
  '          } else {',
  '            res.json().then(function(d) { alert(d.error || "Error adding product"); });',
  '          }',
  '        }).catch(function() {',
  '          sBtn.textContent = "Tracking List Mein Jodein";',
  '          alert("Network error");',
  '        });',
  '      });',
  '',
  '      if (token) { loadList(); } else { showLogin(""); }',
  '      setInterval(function() { if (token) loadList(); }, 8000);',
  '    })();',
  '  </script>',
  '</body>',
  '</html>'
].join('\n');

// =========================================================================
// API ROUTES
// =========================================================================
app.get('/', (req, res) => res.type('html').send(HTML));
app.get('/ping', (req, res) => res.send('OK - Multi-Store Sniper 24x7 Active'));

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
  const { url, pincode, mode, targetPrice, name } = req.body;
  const parsed = detectAndCleanUrl(url);
  if (!parsed) {
    return res.status(400).json({ error: 'Sirf Amazon, Flipkart, Myntra ya Nykaa ka sahi product link dalein' });
  }
  if (!/^\d{6}$/.test(String(pincode).trim())) {
    return res.status(400).json({ error: 'Sahi 6-digit Pincode dalein' });
  }

  const validMode = mode === 'PRICE' ? 'PRICE' : 'STOCK';

  const { error } = await supabase.from('tracked_products').insert([{
    name: name?.trim() || `${parsed.store} Product`,
    url: parsed.clean,
    pid: parsed.pid || null,
    lid: parsed.lid || null,
    pincode: String(pincode).trim(),
    mode: validMode,
    target_price: validMode === 'PRICE' ? Number(targetPrice) : null,
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
    { name: 'Test Product', pincode: '462023', url: 'https://www.flipkart.com/apple-iphone-17-lavender-256-gb/p/itm6eb39da622cdd?pid=MOBHFN6YKGBPYJZD' },
    {
      title: 'Apple iPhone 17 (Lavender, 256 GB)',
      price: 82900,
      mrp: 89900,
      offers: ['🎟️ Coupon: ₹4000 Instant Bank Discount', 'Special Price: Get extra ₹3000 off']
    },
    'MULTI-STORE SNIPER ALERT!'
  );
  res.status(r.ok ? 200 : 500).json(r);
});

app.listen(PORT, () => {
  console.log(`🚀 Multi-Store Sniper Live on Port ${PORT}`);
  checkAllProducts();
});
