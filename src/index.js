/**
 * Multi-Store Listing Alert - Cloudflare Worker
 * 
 * Monitors:
 * 1. Mattel Creations (Vehicles Category) - https://creations.mattel.com/collections/mattel-creations-shop-all
 * 2. JCAR Diecast (Hot Wheels Collection) - https://www.jcardiecast.com/collections/hot-wheels
 * 
 * Optimized Architecture:
 * - Routine 10-Minute Cron: Scans Page 1 & 2 with `sort_by=created-descending` (Ultra-fast <400ms scan).
 * - First Run / Master Sync: Scans all pages to register entire historical catalog.
 * - Timezone: Bangladesh Dhaka Time (Asia/Dhaka).
 * - Alerts: Sent to SEPARATE Discord webhooks for Mattel and JCAR stores.
 */

// Default store webhook URLs
const DEFAULT_JCAR_WEBHOOK_URL = 'https://discord.com/api/webhooks/1460971531348738090/EYQuVVAH4eYpSE5fCTGcWiVbp6Ct9-LcIKRMwUeALmdaww3QWWVDHxRMLCKl_2jsrdVH';
const DEFAULT_MATTEL_WEBHOOK_URL = 'https://discord.com/api/webhooks/1535216741594959952/XGdwH4rRfxUC2bLAoilNMHzcu9y1Bae5Ssva894acnZgbaxNTrETnoE03R2sdJ13h8Na';

// In-memory fallbacks if KV is not yet bound
let fallbackMattelIds = new Set();
let fallbackJcarIds = new Set();
let fallbackLastCheck = null;
let fallbackMattelWebhookUrl = '';
let fallbackJcarWebhookUrl = '';

export default {
  /**
   * Cron Trigger Handler (Runs every 10 minutes)
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAllStores(env, false));
  },

  /**
   * HTTP Request Handler (GUI Dashboard & API Endpoints)
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // API Routes
    if (url.pathname === '/api/check' && request.method === 'POST') {
      const result = await checkAllStores(env, true);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/api/save-webhook' && request.method === 'POST') {
      try {
        const body = await request.json();
        const store = body.store === 'jcar' ? 'jcar' : 'mattel';
        const webhookUrl = body.webhookUrl ? body.webhookUrl.trim() : '';

        if (!webhookUrl || !webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
          return new Response(JSON.stringify({ 
            success: false, 
            error: 'Invalid Discord Webhook URL format. Must start with https://discord.com/api/webhooks/' 
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        await saveWebhookUrl(env, store, webhookUrl);
        const testResult = await sendTestDiscordAlert(env, store);

        return new Response(JSON.stringify({
          success: true,
          store,
          message: `${store === 'mattel' ? 'Mattel Creations' : 'JCAR Diecast'} webhook saved permanently and verified successfully!`,
          testResult
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (url.pathname === '/api/clear-webhook' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const store = body.store === 'jcar' ? 'jcar' : 'mattel';
      await saveWebhookUrl(env, store, '');
      return new Response(JSON.stringify({ success: true, message: `${store === 'mattel' ? 'Mattel' : 'JCAR'} webhook reset to default.` }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/api/test-discord' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const store = body.store;
      let result;
      if (store) {
        result = await sendTestDiscordAlert(env, store);
      } else {
        const mattelRes = await sendTestDiscordAlert(env, 'mattel');
        const jcarRes = await sendTestDiscordAlert(env, 'jcar');
        result = {
          success: mattelRes.success && jcarRes.success,
          mattel: mattelRes,
          jcar: jcarRes,
          message: `Mattel Test: ${mattelRes.message || mattelRes.error} | JCAR Test: ${jcarRes.message || jcarRes.error}`
        };
      }
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/api/status') {
      const metrics = await getStatusMetrics(env);
      const mattelWebhook = await getActiveWebhookUrl(env, 'mattel');
      const jcarWebhook = await getActiveWebhookUrl(env, 'jcar');
      return new Response(JSON.stringify({
        ...metrics,
        mattelWebhook: {
          hasWebhook: Boolean(mattelWebhook),
          maskedWebhook: maskWebhook(mattelWebhook)
        },
        jcarWebhook: {
          hasWebhook: Boolean(jcarWebhook),
          maskedWebhook: maskWebhook(jcarWebhook)
        }
      }, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Serve HTML Dashboard for all browser requests
    const mattelWebhook = await getActiveWebhookUrl(env, 'mattel');
    const jcarWebhook = await getActiveWebhookUrl(env, 'jcar');
    const html = renderDashboard(await getStatusMetrics(env), env, mattelWebhook, jcarWebhook);
    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
};

/**
 * Get active Discord Webhook URL for specific store ('mattel' or 'jcar').
 */
async function getActiveWebhookUrl(env, store = 'mattel') {
  const isMattel = store === 'mattel';
  const kvKey = isMattel ? 'SAVED_MATTEL_WEBHOOK_URL' : 'SAVED_JCAR_WEBHOOK_URL';
  const envVar = isMattel ? env.MATTEL_WEBHOOK_URL : env.JCAR_WEBHOOK_URL;
  const defaultUrl = isMattel ? DEFAULT_MATTEL_WEBHOOK_URL : DEFAULT_JCAR_WEBHOOK_URL;
  const fallbackUrl = isMattel ? fallbackMattelWebhookUrl : fallbackJcarWebhookUrl;

  if (env.LISTING_KV) {
    try {
      const kvWebhook = await env.LISTING_KV.get(kvKey);
      if (kvWebhook && kvWebhook.trim()) return kvWebhook.trim();
    } catch (e) {}
  }
  if (envVar && envVar.trim()) {
    return envVar.trim();
  }
  // Check legacy generic webhook configuration if store specific is missing
  if (env.LISTING_KV) {
    try {
      const genericKv = await env.LISTING_KV.get('SAVED_WEBHOOK_URL');
      if (genericKv && genericKv.trim()) return genericKv.trim();
    } catch (e) {}
  }
  if (env.DISCORD_WEBHOOK_URL && env.DISCORD_WEBHOOK_URL.trim()) {
    return env.DISCORD_WEBHOOK_URL.trim();
  }
  if (fallbackUrl && fallbackUrl.trim()) {
    return fallbackUrl.trim();
  }
  return defaultUrl;
}

/**
 * Save Discord Webhook URL for specific store ('mattel' or 'jcar').
 */
async function saveWebhookUrl(env, store, url) {
  const isMattel = store === 'mattel';
  const kvKey = isMattel ? 'SAVED_MATTEL_WEBHOOK_URL' : 'SAVED_JCAR_WEBHOOK_URL';
  if (env.LISTING_KV) {
    try {
      if (url) {
        await env.LISTING_KV.put(kvKey, url);
      } else {
        await env.LISTING_KV.delete(kvKey);
      }
    } catch (e) {
      console.error(`Failed to save ${store} webhook to KV:`, e);
    }
  }
  if (isMattel) {
    fallbackMattelWebhookUrl = url;
  } else {
    fallbackJcarWebhookUrl = url;
  }
}

/**
 * Mask webhook URL.
 */
function maskWebhook(url) {
  if (!url || url.length < 30) return 'Configured';
  return url.substring(0, 33) + '...' + url.substring(url.length - 6);
}

/**
 * Format timestamp into Bangladesh Dhaka Timezone (Asia/Dhaka).
 */
function formatDhakaTime(dateStr) {
  const date = dateStr ? new Date(dateStr) : new Date();
  return date.toLocaleString('en-US', {
    timeZone: 'Asia/Dhaka',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }) + ' (Dhaka Time)';
}

/**
 * Optimized Shopify Catalog Fetcher:
 * - Routine checks: Scans Page 1 & 2 sorted by `created-descending` (Top 500 newest items).
 * - Full checks / First run: Scans up to 15 pages to fetch full catalog.
 */
async function fetchShopifyCollection(baseUrl, refererUrl, isFullScan = false) {
  const allProducts = [];
  const maxPages = isFullScan ? 15 : 2; // Routine check only needs top 2 pages (500 items sorted by newest)

  for (let page = 1; page <= maxPages; page++) {
    const url = `${baseUrl}?limit=250&page=${page}&sort_by=created-descending`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': refererUrl || baseUrl,
        'Cache-Control': 'no-cache'
      }
    });

    if (!response.ok) {
      break;
    }

    const data = await response.json();
    const products = data.products || [];
    
    if (products.length === 0) break;

    allProducts.push(...products);

    if (products.length < 250) break;

    await new Promise(r => setTimeout(r, 100));
  }

  return allProducts;
}

/**
 * Read master set of seen IDs from KV array.
 */
async function getSeenIdSet(env, key, fallbackSet) {
  const seenSet = new Set(fallbackSet);

  if (env.LISTING_KV) {
    try {
      const data = await env.LISTING_KV.get(key, { type: 'json' });
      if (Array.isArray(data)) {
        for (const id of data) seenSet.add(String(id));
      }
    } catch (e) {}
  }
  return seenSet;
}

/**
 * Save master ID set to KV array in a single efficient call.
 */
async function saveSeenIdSet(env, key, idsArray) {
  if (env.LISTING_KV) {
    try {
      await env.LISTING_KV.put(key, JSON.stringify(idsArray));
    } catch (e) {
      console.error(`Failed to save ${key} to KV:`, e);
    }
  }
}

/**
 * Check single product key in KV.
 */
async function isSingleKeySeen(env, storePrefix, prodId) {
  if (!env.LISTING_KV) return false;
  try {
    const res = await env.LISTING_KV.get(`${storePrefix}_ITEM_${prodId}`);
    return res === '1';
  } catch (e) {
    return false;
  }
}

/**
 * Mark single product key in KV.
 */
async function markSingleKeySeen(env, storePrefix, prodId) {
  if (!env.LISTING_KV) return;
  try {
    await env.LISTING_KV.put(`${storePrefix}_ITEM_${prodId}`, '1');
  } catch (e) {}
}

/**
 * Main function to check BOTH Mattel Creations & JCAR Diecast.
 */
async function checkAllStores(env, isManual = false) {
  const timestamp = new Date().toISOString();
  let logMessages = [];
  logMessages.push(`[${timestamp}] Starting multi-store scan... (Mode: ${isManual ? 'Full Scan' : 'Fast Routine Check'})`);

  const mattelWebhookUrl = await getActiveWebhookUrl(env, 'mattel');
  const jcarWebhookUrl = await getActiveWebhookUrl(env, 'jcar');

  let mattelResult = { total: 0, vehicles: 0, newCount: 0 };
  let jcarResult = { total: 0, hotwheels: 0, newCount: 0 };

  // -------------------------------------------------------------
  // 1. SCAN MATTEL CREATIONS (Vehicles Category)
  // -------------------------------------------------------------
  try {
    logMessages.push('Fetching Mattel Creations catalog...');
    const seenMattelIds = await getSeenIdSet(env, 'SEEN_MATTEL_IDS', fallbackMattelIds);
    const isFirstRun = seenMattelIds.size === 0;

    // Run full scan on first run or manual check, otherwise run fast Page 1 & 2 scan
    const mattelProducts = await fetchShopifyCollection(
      'https://creations.mattel.com/collections/mattel-creations-shop-all/products.json',
      'https://creations.mattel.com/collections/mattel-creations-shop-all',
      isFirstRun || isManual
    );
    const mattelVehicles = mattelProducts.filter(isVehicleProduct);

    mattelResult.total = mattelProducts.length;
    mattelResult.vehicles = mattelVehicles.length;

    const currentMattelIds = [];
    const newMattel = [];

    for (const prod of mattelVehicles) {
      const idStr = String(prod.id);
      currentMattelIds.push(idStr);

      const alreadySeen = seenMattelIds.has(idStr) || await isSingleKeySeen(env, 'MATTEL', idStr);

      if (!isFirstRun && !alreadySeen) {
        newMattel.push(prod);
      }
    }

    mattelResult.newCount = newMattel.length;

    if (isFirstRun) {
      logMessages.push(`Mattel First Run: Registered master database of ${mattelVehicles.length} vehicles.`);
      for (const idStr of currentMattelIds) {
        seenMattelIds.add(idStr);
      }
      await saveSeenIdSet(env, 'SEEN_MATTEL_IDS', Array.from(seenMattelIds));
      fallbackMattelIds = seenMattelIds;
    } else if (newMattel.length > 0) {
      logMessages.push(`Found ${newMattel.length} NEW Mattel vehicle listings!`);
      for (const item of newMattel) {
        const idStr = String(item.id);
        
        // Mark as seen immediately BEFORE sending alert
        seenMattelIds.add(idStr);
        await markSingleKeySeen(env, 'MATTEL', idStr);

        await sendDiscordAlert(mattelWebhookUrl, item, 'Mattel Creations', 'https://creations.mattel.com', 0xFF0044);
        logMessages.push(`Mattel Alert sent: ${item.title}`);
      }
      await saveSeenIdSet(env, 'SEEN_MATTEL_IDS', Array.from(seenMattelIds));
      fallbackMattelIds = seenMattelIds;
    }

  } catch (err) {
    logMessages.push(`Mattel Scan Error: ${err.message}`);
  }

  // -------------------------------------------------------------
  // 2. SCAN JCAR DIECAST (Hot Wheels Collection)
  // -------------------------------------------------------------
  try {
    logMessages.push('Fetching JCAR Diecast Hot Wheels catalog...');
    const seenJcarIds = await getSeenIdSet(env, 'SEEN_JCAR_IDS', fallbackJcarIds);
    const isFirstRun = seenJcarIds.size === 0;

    // Run full scan on first run or manual check, otherwise run fast Page 1 & 2 scan
    const jcarProducts = await fetchShopifyCollection(
      'https://www.jcardiecast.com/collections/hot-wheels/products.json',
      'https://www.jcardiecast.com/collections/hot-wheels',
      isFirstRun || isManual
    );

    jcarResult.total = jcarProducts.length;
    jcarResult.hotwheels = jcarProducts.length;

    const currentJcarIds = [];
    const newJcar = [];

    for (const prod of jcarProducts) {
      const idStr = String(prod.id);
      currentJcarIds.push(idStr);

      const alreadySeen = seenJcarIds.has(idStr) || await isSingleKeySeen(env, 'JCAR', idStr);

      if (!isFirstRun && !alreadySeen) {
        newJcar.push(prod);
      }
    }

    jcarResult.newCount = newJcar.length;

    if (isFirstRun) {
      logMessages.push(`JCAR First Run: Registered master database of ${jcarProducts.length} Hot Wheels.`);
      for (const idStr of currentJcarIds) {
        seenJcarIds.add(idStr);
      }
      await saveSeenIdSet(env, 'SEEN_JCAR_IDS', Array.from(seenJcarIds));
      fallbackJcarIds = seenJcarIds;
    } else if (newJcar.length > 0) {
      logMessages.push(`Found ${newJcar.length} NEW JCAR Hot Wheels listings!`);
      for (const item of newJcar) {
        const idStr = String(item.id);

        // Mark as seen immediately BEFORE sending alert
        seenJcarIds.add(idStr);
        await markSingleKeySeen(env, 'JCAR', idStr);

        await sendDiscordAlert(jcarWebhookUrl, item, 'JCAR Diecast', 'https://www.jcardiecast.com', 0xFF9900);
        logMessages.push(`JCAR Alert sent: ${item.title}`);
      }
      await saveSeenIdSet(env, 'SEEN_JCAR_IDS', Array.from(seenJcarIds));
      fallbackJcarIds = seenJcarIds;
    }

  } catch (err) {
    logMessages.push(`JCAR Scan Error: ${err.message}`);
  }

  const metrics = {
    timestamp,
    status: 'success',
    mattel: mattelResult,
    jcar: jcarResult,
    totalTracked: mattelResult.vehicles + jcarResult.hotwheels,
    totalNewFound: mattelResult.newCount + jcarResult.newCount,
    isManual,
    logs: logMessages
  };

  await saveMetrics(env, metrics);
  return metrics;
}

/**
 * Filter for Mattel vehicle category.
 */
function isVehicleProduct(product) {
  const tags = (product.tags || []).map(t => String(t).toLowerCase());
  const type = String(product.product_type || '').toLowerCase();

  const hasVehicleTag = tags.some(t => 
    t === 'category: vehicles' || 
    t.includes('vehicles') || 
    t === 'category: vehicle' ||
    t === 'vehicle'
  );

  if (hasVehicleTag) return true;
  if (type.includes('vehicle') || type.includes('diecast')) return true;

  return false;
}

/**
 * Save check metrics to KV.
 */
async function saveMetrics(env, metrics) {
  if (env.LISTING_KV) {
    try {
      await env.LISTING_KV.put('LAST_CHECK_METRICS', JSON.stringify(metrics));
    } catch (e) {}
  }
  fallbackLastCheck = metrics;
}

/**
 * Get status metrics.
 */
async function getStatusMetrics(env) {
  let metrics = null;
  if (env.LISTING_KV) {
    try {
      metrics = await env.LISTING_KV.get('LAST_CHECK_METRICS', { type: 'json' });
    } catch (e) {}
  }
  if (!metrics) {
    metrics = fallbackLastCheck || {
      status: 'idle',
      timestamp: 'Never checked yet',
      totalTracked: 0,
      totalNewFound: 0,
      mattel: { vehicles: 0 },
      jcar: { hotwheels: 0 }
    };
  }
  return metrics;
}

/**
 * Send Discord Rich Embed for new product alert.
 */
async function sendDiscordAlert(webhookUrl, product, storeName, baseUrl, embedColor) {
  if (!webhookUrl) return;

  const productUrl = `${baseUrl}/products/${product.handle}`;
  const firstImage = product.images && product.images.length > 0 ? product.images[0].src : null;
  const firstVariant = product.variants && product.variants.length > 0 ? product.variants[0] : null;

  const priceStr = firstVariant ? `$${parseFloat(firstVariant.price).toFixed(2)}` : 'N/A';
  const dhakaTimeStr = formatDhakaTime(product.published_at || product.created_at);

  const embed = {
    title: product.title,
    url: productUrl,
    color: embedColor || 0xFF0044,
    fields: [
      { name: '💰 Price', value: priceStr, inline: true },
      { name: '🕒 Listed', value: dhakaTimeStr, inline: true }
    ],
    footer: {
      text: `${storeName} Alert`
    }
  };

  if (firstImage) {
    embed.thumbnail = { url: firstImage };
  }

  const payload = {
    username: storeName,
    embeds: [embed]
  };

  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

/**
 * Send test embed for specific store ('mattel' or 'jcar').
 */
async function sendTestDiscordAlert(env, store = 'mattel') {
  const webhookUrl = await getActiveWebhookUrl(env, store);
  const isMattel = store === 'mattel';
  const storeName = isMattel ? 'Mattel Creations' : 'JCAR Diecast';
  const embedColor = isMattel ? 0xFF0044 : 0xFF9900;

  if (!webhookUrl) {
    return { success: false, error: `${storeName} Discord Webhook URL is not configured.` };
  }

  const embed = {
    title: `🔔 Test Alert - ${storeName}`,
    description: `Discord Webhook test successful for **${storeName}**! Alerts arrive in Bangladesh Dhaka Time.`,
    color: embedColor,
    fields: [
      { name: 'Store Target', value: storeName, inline: true },
      { name: 'Timezone', value: 'Asia/Dhaka (Bangladesh Time)', inline: true },
      { name: 'Schedule', value: 'Every 10 Minutes', inline: true }
    ],
    footer: { text: `${storeName} Notification Test` },
    timestamp: new Date().toISOString()
  };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `${storeName} Monitor`, embeds: [embed] })
    });

    if (!res.ok) {
      throw new Error(`Discord API returned status ${res.status}`);
    }

    return { success: true, message: `Test message sent to ${storeName} Discord webhook successfully!` };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Render HTML Dashboard.
 */
function renderDashboard(metrics, env, mattelWebhook, jcarWebhook) {
  const hasKV = Boolean(env.LISTING_KV);

  const mattelVehicles = metrics.mattel ? metrics.mattel.vehicles : (metrics.totalVehicles || 0);
  const jcarHotwheels = metrics.jcar ? metrics.jcar.hotwheels : 0;
  const totalTracked = metrics.totalTracked || (mattelVehicles + jcarHotwheels);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Multi-Store Listing Alert Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: rgba(18, 26, 44, 0.75);
      --card-border: rgba(255, 255, 255, 0.08);
      --primary: #ff0044;
      --primary-glow: rgba(255, 0, 68, 0.35);
      --jcar-color: #ff9900;
      --jcar-glow: rgba(255, 153, 0, 0.35);
      --accent: #00d2ff;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Inter', sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      background-image: 
        radial-gradient(circle at 15% 15%, rgba(255, 0, 68, 0.12) 0%, transparent 40%),
        radial-gradient(circle at 85% 85%, rgba(0, 210, 255, 0.08) 0%, transparent 40%);
    }

    header {
      padding: 2rem 1.5rem 1rem;
      max-width: 1100px;
      margin: 0 auto;
      width: 100%;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-bottom: 0.5rem;
    }

    .brand-logo {
      background: linear-gradient(135deg, #ff0044, #ff9900);
      color: white;
      font-family: 'Outfit', sans-serif;
      font-weight: 800;
      font-size: 1.25rem;
      padding: 0.5rem 0.85rem;
      border-radius: 10px;
      box-shadow: 0 0 20px var(--primary-glow);
    }

    h1 {
      font-family: 'Outfit', sans-serif;
      font-size: 2rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }

    .subtitle {
      color: var(--text-muted);
      font-size: 0.95rem;
    }

    main {
      max-width: 1100px;
      margin: 1.5rem auto 3rem;
      padding: 0 1.5rem;
      width: 100%;
      flex: 1;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 1.25rem;
      margin-bottom: 2rem;
    }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 1.5rem;
      backdrop-filter: blur(12px);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
      transition: transform 0.2s ease, border-color 0.2s ease;
    }

    .card-title {
      font-size: 0.85rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 0.75rem;
    }

    .card-value {
      font-family: 'Outfit', sans-serif;
      font-size: 2.25rem;
      font-weight: 700;
      color: var(--text);
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.35rem 0.75rem;
      border-radius: 999px;
      font-size: 0.85rem;
      font-weight: 600;
    }

    .badge-success { background: rgba(16, 185, 129, 0.15); color: var(--success); border: 1px solid rgba(16, 185, 129, 0.3); }
    .badge-warning { background: rgba(245, 158, 11, 0.15); color: var(--warning); border: 1px solid rgba(245, 158, 11, 0.3); }
    .badge-danger { background: rgba(239, 68, 68, 0.15); color: var(--danger); border: 1px solid rgba(239, 68, 68, 0.3); }

    .webhooks-container {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
      gap: 1.5rem;
      margin-bottom: 2rem;
    }

    .webhook-box {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 1.5rem;
      backdrop-filter: blur(12px);
    }

    .webhook-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 0.5rem;
    }

    .store-tag {
      font-family: 'Outfit', sans-serif;
      font-weight: 700;
      font-size: 0.75rem;
      padding: 0.2rem 0.6rem;
      border-radius: 6px;
      text-transform: uppercase;
    }

    .tag-mattel { background: rgba(255, 0, 68, 0.2); color: #ff3366; border: 1px solid rgba(255, 0, 68, 0.4); }
    .tag-jcar { background: rgba(255, 153, 0, 0.2); color: #ffaa22; border: 1px solid rgba(255, 153, 0, 0.4); }

    .input-group {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      margin-top: 1rem;
    }

    .input-field {
      width: 100%;
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 0.85rem 1rem;
      color: #fff;
      font-family: 'Inter', sans-serif;
      font-size: 0.88rem;
      outline: none;
    }

    .button-row {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }

    .actions {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
      margin-bottom: 2rem;
    }

    .btn {
      font-family: 'Outfit', sans-serif;
      font-weight: 600;
      font-size: 0.92rem;
      padding: 0.75rem 1.25rem;
      border-radius: 12px;
      border: none;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      transition: all 0.2s ease;
      text-decoration: none;
    }

    .btn-primary {
      background: linear-gradient(135deg, var(--primary), #d90036);
      color: white;
      box-shadow: 0 4px 20px var(--primary-glow);
    }

    .btn-jcar {
      background: linear-gradient(135deg, var(--jcar-color), #d97700);
      color: white;
      box-shadow: 0 4px 20px var(--jcar-glow);
    }

    .btn-accent {
      background: linear-gradient(135deg, #00d2ff, #0088ff);
      color: white;
    }

    .btn-secondary {
      background: rgba(255, 255, 255, 0.08);
      color: var(--text);
      border: 1px solid var(--card-border);
    }

    .console {
      background: #060911;
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 1.25rem;
      font-family: 'Courier New', monospace;
      font-size: 0.88rem;
      color: #38bdf8;
      max-height: 250px;
      overflow-y: auto;
      line-height: 1.6;
    }

    #output-toast {
      display: none;
      padding: 1rem 1.25rem;
      border-radius: 12px;
      margin-bottom: 1.5rem;
      font-weight: 500;
    }

    footer {
      text-align: center;
      padding: 2rem;
      color: var(--text-muted);
      font-size: 0.85rem;
      border-top: 1px solid var(--card-border);
    }
  </style>
</head>
<body>

  <header>
    <div class="brand">
      <div class="brand-logo">MC + JCAR</div>
      <div>
        <h1>Multi-Store Listing Alert</h1>
        <p class="subtitle">Bangladesh Dhaka Time (Asia/Dhaka) • Separate Store Webhooks</p>
      </div>
    </div>
  </header>

  <main>
    <div id="output-toast"></div>

    <div class="grid">
      <div class="card">
        <div class="card-title">Schedule Status</div>
        <div style="margin-top: 0.5rem;">
          <span class="badge badge-success">● 10 Min Cron Active</span>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Mattel Vehicles</div>
        <div class="card-value">${mattelVehicles}</div>
        <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem;">Mattel Creations Store</div>
      </div>

      <div class="card">
        <div class="card-title">JCAR Hot Wheels</div>
        <div class="card-value">${jcarHotwheels}</div>
        <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem;">JCAR Diecast Store</div>
      </div>

      <div class="card">
        <div class="card-title">KV Storage State</div>
        <div style="margin-top: 0.5rem;">
          ${hasKV 
            ? '<span class="badge badge-success">✓ LISTING_KV Bound</span>' 
            : '<span class="badge badge-warning">⚠ In-Memory Fallback</span>'}
        </div>
      </div>
    </div>

    <!-- Webhook GUI Input Boxes -->
    <div class="webhooks-container">
      <!-- Mattel Creations Webhook -->
      <div class="webhook-box">
        <div class="webhook-header">
          <span class="store-tag tag-mattel">Mattel Creations</span>
          <h3 style="font-size: 1.1rem;">Discord Webhook</h3>
        </div>
        <p style="color: var(--text-muted); font-size: 0.85rem;">
          Alerts for new Mattel vehicle listings go here.
        </p>
        <div class="input-group">
          <input 
            type="url" 
            id="mattel-webhook-input" 
            class="input-field" 
            placeholder="https://discord.com/api/webhooks/..."
            value="${mattelWebhook || ''}"
          />
          <div class="button-row">
            <button class="btn btn-primary" onclick="saveWebhook('mattel')">
              💾 Save
            </button>
            <button class="btn btn-secondary" onclick="sendTestDiscord('mattel')">
              🔔 Test
            </button>
            <button class="btn btn-secondary" onclick="clearWebhook('mattel')">
              🗑️ Reset
            </button>
          </div>
        </div>
      </div>

      <!-- JCAR Diecast Webhook -->
      <div class="webhook-box">
        <div class="webhook-header">
          <span class="store-tag tag-jcar">JCAR Diecast</span>
          <h3 style="font-size: 1.1rem;">Discord Webhook</h3>
        </div>
        <p style="color: var(--text-muted); font-size: 0.85rem;">
          Alerts for new JCAR Hot Wheels listings go here.
        </p>
        <div class="input-group">
          <input 
            type="url" 
            id="jcar-webhook-input" 
            class="input-field" 
            placeholder="https://discord.com/api/webhooks/..."
            value="${jcarWebhook || ''}"
          />
          <div class="button-row">
            <button class="btn btn-jcar" onclick="saveWebhook('jcar')">
              💾 Save
            </button>
            <button class="btn btn-secondary" onclick="sendTestDiscord('jcar')">
              🔔 Test
            </button>
            <button class="btn btn-secondary" onclick="clearWebhook('jcar')">
              🗑️ Reset
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="actions">
      <button class="btn btn-accent" onclick="runManualCheck()">
        ⚡ Run Check Now (Both Stores)
      </button>
      <button class="btn btn-secondary" onclick="sendTestDiscord()">
        🔔 Test Both Webhooks
      </button>
      <a href="https://creations.mattel.com/collections/mattel-creations-shop-all?#filter.tags_category=Vehicles" target="_blank" rel="noopener" class="btn btn-secondary">
        🔗 Mattel Store
      </a>
      <a href="https://www.jcardiecast.com/collections/hot-wheels" target="_blank" rel="noopener" class="btn btn-secondary">
        🔗 JCAR Hot Wheels Store
      </a>
    </div>

    <div class="section-title">📊 Last Check Logs & Metrics</div>
    <div class="console" id="log-console">
[Timestamp] ${metrics.timestamp || 'No check executed yet'}
Status: ${metrics.status || 'Idle'}
Total Items Scanned Across Stores: ${totalTracked}
Mattel Vehicles: ${mattelVehicles} | JCAR Hot Wheels: ${jcarHotwheels}

Logs:
${(metrics.logs || ['Waiting for first run...']).join('\n')}
    </div>
  </main>

  <footer>
    Multi-Store Listing Monitor • Bangladesh Dhaka Timezone (Asia/Dhaka)
  </footer>

  <script>
    async function saveWebhook(store) {
      const inputId = store === 'jcar' ? 'jcar-webhook-input' : 'mattel-webhook-input';
      const input = document.getElementById(inputId);
      const toast = document.getElementById('output-toast');
      const url = input.value.trim();
      const storeLabel = store === 'jcar' ? 'JCAR' : 'Mattel';

      if (!url) {
        toast.style.display = 'block';
        toast.className = 'badge-danger';
        toast.innerText = 'Please paste a valid Discord Webhook URL for ' + storeLabel + '!';
        return;
      }

      toast.style.display = 'block';
      toast.className = 'badge-warning';
      toast.innerText = '⏳ Saving ' + storeLabel + ' Webhook and sending test alert...';

      try {
        const res = await fetch('/api/save-webhook', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ store, webhookUrl: url })
        });
        const data = await res.json();

        if (data.success) {
          toast.className = 'badge-success';
          toast.innerText = '✅ ' + storeLabel + ' webhook saved successfully! Test notification sent to Discord.';
          setTimeout(() => location.reload(), 2000);
        } else {
          toast.className = 'badge-danger';
          toast.innerText = '❌ Failed: ' + data.error;
        }
      } catch (err) {
        toast.className = 'badge-danger';
        toast.innerText = 'Error saving webhook: ' + err.message;
      }
    }

    async function clearWebhook(store) {
      const storeLabel = store === 'jcar' ? 'JCAR' : 'Mattel';
      if (!confirm('Are you sure you want to reset the ' + storeLabel + ' Webhook URL?')) return;
      const toast = document.getElementById('output-toast');
      toast.style.display = 'block';
      toast.className = 'badge-warning';
      toast.innerText = '⏳ Resetting ' + storeLabel + ' Webhook...';

      try {
        await fetch('/api/clear-webhook', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ store })
        });
        toast.className = 'badge-success';
        toast.innerText = storeLabel + ' Webhook reset to default!';
        setTimeout(() => location.reload(), 1500);
      } catch (err) {
        toast.className = 'badge-danger';
        toast.innerText = 'Error clearing webhook: ' + err.message;
      }
    }

    async function runManualCheck() {
      const toast = document.getElementById('output-toast');
      const consoleEl = document.getElementById('log-console');
      toast.style.display = 'block';
      toast.className = 'badge-warning';
      toast.innerText = '⏳ Scanning both Mattel Creations and JCAR Diecast... Please wait...';

      try {
        const res = await fetch('/api/check', { method: 'POST' });
        const data = await res.json();
        
        toast.className = data.status === 'success' ? 'badge-success' : 'badge-danger';
        toast.innerText = 'Scan completed! Mattel: ' + (data.mattel ? data.mattel.vehicles : 0) + ' items | JCAR: ' + (data.jcar ? data.jcar.hotwheels : 0) + ' items';

        consoleEl.innerText = JSON.stringify(data, null, 2);
        setTimeout(() => location.reload(), 3000);
      } catch (err) {
        toast.className = 'badge-danger';
        toast.innerText = 'Failed to execute check: ' + err.message;
      }
    }

    async function sendTestDiscord(store) {
      const toast = document.getElementById('output-toast');
      toast.style.display = 'block';
      toast.className = 'badge-warning';
      toast.innerText = '⏳ Sending test notification to Discord...';

      try {
        const res = await fetch('/api/test-discord', { 
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(store ? { store } : {})
        });
        const data = await res.json();

        if (data.success) {
          toast.className = 'badge-success';
          toast.innerText = '✅ ' + (data.message || 'Test message sent successfully!');
        } else {
          toast.className = 'badge-danger';
          toast.innerText = '❌ Error: ' + (data.error || data.message || 'Failed to send test alert');
        }
      } catch (err) {
        toast.className = 'badge-danger';
        toast.innerText = 'Failed to send test alert: ' + err.message;
      }
    }
  </script>
</body>
</html>`;
}
