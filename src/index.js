/**
 * Mattel Creations Vehicle Listing Alert - Cloudflare Worker
 * 
 * Automatically checks Mattel Creations every 10 minutes for newly listed vehicles.
 * Sends Discord notifications via Webhook and persists state in Cloudflare KV.
 */

// In-memory fallback if KV is not yet bound in development
let fallbackSeenIds = new Set();
let fallbackLastCheck = null;

export default {
  /**
   * Cron Trigger Handler (Runs every 10 minutes)
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkNewVehicles(env));
  },

  /**
   * HTTP Request Handler (GUI Dashboard & API Endpoints)
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // API Routes
    if (url.pathname === '/api/check' && request.method === 'POST') {
      const result = await checkNewVehicles(env, true);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/api/test-discord' && request.method === 'POST') {
      const result = await sendTestDiscordAlert(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/api/status') {
      const metrics = await getStatusMetrics(env);
      return new Response(JSON.stringify(metrics, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Serve HTML Dashboard for all browser requests
    const html = renderDashboard(await getStatusMetrics(env), env);
    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
};

/**
 * Main function to fetch products, filter vehicles, compare with stored state, and send alerts.
 */
async function checkNewVehicles(env, isManual = false) {
  const timestamp = new Date().toISOString();
  let logMessages = [];
  logMessages.push(`[${timestamp}] Starting Mattel Creations vehicle check...`);

  try {
    const shopifyUrl = 'https://creations.mattel.com/collections/mattel-creations-shop-all/products.json?limit=250&sort_by=created-descending';
    
    const response = await fetch(shopifyUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Shopify API returned status ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const products = data.products || [];
    logMessages.push(`Fetched ${products.length} products from Mattel Creations.`);

    // Filter products matching Vehicle category or tag
    const vehicleProducts = products.filter(isVehicleProduct);
    logMessages.push(`Found ${vehicleProducts.length} vehicle items.`);

    // Retrieve previously seen IDs
    const seenIds = await getSeenProductIds(env);
    const isFirstRun = seenIds.size === 0;

    const newVehicles = [];
    const currentVehicleIds = [];

    for (const prod of vehicleProducts) {
      const idStr = String(prod.id);
      currentVehicleIds.push(idStr);

      if (!isFirstRun && !seenIds.has(idStr)) {
        newVehicles.push(prod);
      }
    }

    logMessages.push(`New vehicle listings detected: ${newVehicles.length}`);

    // If first run, initialize KV with current IDs and send welcome webhook if configured
    if (isFirstRun) {
      logMessages.push('First run initialized. Saved current vehicle list to state.');
      if (env.DISCORD_WEBHOOK_URL) {
        await sendFirstRunWebhook(env, vehicleProducts.length);
      }
    } else if (newVehicles.length > 0) {
      // Dispatch Discord alerts for each new vehicle found
      for (const vehicle of newVehicles) {
        await sendDiscordAlert(env, vehicle);
      }
    }

    // Save updated product IDs and metrics to state
    await saveSeenProductIds(env, currentVehicleIds);

    const metrics = {
      timestamp,
      status: 'success',
      totalProducts: products.length,
      totalVehicles: vehicleProducts.length,
      newVehiclesFound: newVehicles.length,
      isFirstRun,
      isManual,
      newVehiclesList: newVehicles.map(v => ({ id: v.id, title: v.title, handle: v.handle })),
      logs: logMessages
    };

    await saveMetrics(env, metrics);
    return metrics;

  } catch (err) {
    const errorMetrics = {
      timestamp,
      status: 'error',
      error: err.message,
      logs: logMessages
    };
    logMessages.push(`ERROR: ${err.message}`);
    await saveMetrics(env, errorMetrics);
    return errorMetrics;
  }
}

/**
 * Determine if a Shopify product belongs to the Vehicles category.
 */
function isVehicleProduct(product) {
  const tags = (product.tags || []).map(t => String(t).toLowerCase());
  const type = String(product.product_type || '').toLowerCase();
  const title = String(product.title || '').toLowerCase();

  // Check tags for category: vehicles
  const hasVehicleTag = tags.some(t => 
    t === 'category: vehicles' || 
    t.includes('vehicles') || 
    t === 'category: vehicle' ||
    t === 'vehicle'
  );

  if (hasVehicleTag) return true;

  // Fallback checks
  if (type.includes('vehicle') || type.includes('diecast')) return true;

  return false;
}

/**
 * Get seen product IDs from Cloudflare KV or fallback.
 */
async function getSeenProductIds(env) {
  if (env.LISTING_KV) {
    try {
      const data = await env.LISTING_KV.get('SEEN_VEHICLES_IDS', { type: 'json' });
      if (Array.isArray(data)) {
        return new Set(data.map(String));
      }
    } catch (e) {
      console.error('Failed to read from KV:', e);
    }
  }
  return fallbackSeenIds;
}

/**
 * Save seen product IDs to Cloudflare KV or fallback.
 */
async function saveSeenProductIds(env, idsArray) {
  if (env.LISTING_KV) {
    try {
      await env.LISTING_KV.put('SEEN_VEHICLES_IDS', JSON.stringify(idsArray));
    } catch (e) {
      console.error('Failed to write to KV:', e);
    }
  }
  fallbackSeenIds = new Set(idsArray.map(String));
}

/**
 * Save last check execution metrics to KV.
 */
async function saveMetrics(env, metrics) {
  if (env.LISTING_KV) {
    try {
      await env.LISTING_KV.put('LAST_CHECK_METRICS', JSON.stringify(metrics));
    } catch (e) {
      console.error('Failed to save metrics to KV:', e);
    }
  }
  fallbackLastCheck = metrics;
}

/**
 * Get status metrics for GUI.
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
      totalVehicles: 0,
      newVehiclesFound: 0
    };
  }
  return metrics;
}

/**
 * Send Discord Rich Embed for new product alert.
 */
async function sendDiscordAlert(env, product) {
  if (!env.DISCORD_WEBHOOK_URL) {
    console.warn('DISCORD_WEBHOOK_URL is not configured!');
    return;
  }

  const productUrl = `https://creations.mattel.com/products/${product.handle}`;
  const firstImage = product.images && product.images.length > 0 ? product.images[0].src : null;
  const firstVariant = product.variants && product.variants.length > 0 ? product.variants[0] : null;

  const priceStr = firstVariant ? `$${parseFloat(firstVariant.price).toFixed(2)}` : 'N/A';
  const availabilityStr = firstVariant && firstVariant.available ? '🟢 In Stock' : '🔴 Sold Out / Pre-Order';

  const embed = {
    title: `🚨 NEW VEHICLE LISTED: ${product.title}`,
    url: productUrl,
    color: 0xFF0044, // Hot Wheels Red
    description: `A new vehicle has just been listed on Mattel Creations!`,
    fields: [
      { name: '💰 Price', value: priceStr, inline: true },
      { name: '📦 Availability', value: availabilityStr, inline: true },
      { name: '🏷️ Category', value: 'Vehicles', inline: true },
      { name: '🕒 Published', value: product.published_at ? new Date(product.published_at).toLocaleString() : 'Just now', inline: false }
    ],
    footer: {
      text: 'Mattel Creations Vehicle Monitor • Every 10 min check'
    },
    timestamp: new Date().toISOString()
  };

  if (firstImage) {
    embed.thumbnail = { url: firstImage };
  }

  const payload = {
    username: 'Mattel Vehicle Alert',
    avatar_url: 'https://cdn.shopify.com/s/files/1/0568/1132/3565/files/mc_logo.png',
    embeds: [embed]
  };

  await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

/**
 * Send initialization notification to Discord when monitor starts up for the first time.
 */
async function sendFirstRunWebhook(env, vehicleCount) {
  if (!env.DISCORD_WEBHOOK_URL) return;

  const embed = {
    title: '✅ Mattel Vehicle Alert Initialized',
    description: `Monitor successfully deployed and active! Tracking **${vehicleCount}** current vehicle listings on Mattel Creations. Checks execute automatically every 10 minutes.`,
    color: 0x00D2FF,
    footer: { text: 'Mattel Creations Vehicle Monitor' },
    timestamp: new Date().toISOString()
  };

  await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] })
  });
}

/**
 * Send test embed to Discord.
 */
async function sendTestDiscordAlert(env) {
  if (!env.DISCORD_WEBHOOK_URL) {
    return { success: false, error: 'DISCORD_WEBHOOK_URL secret is not set in Cloudflare Worker environment variables.' };
  }

  const embed = {
    title: '🔔 Test Alert - Mattel Vehicle Monitor',
    description: 'This is a test notification from your Cloudflare Worker vehicle monitor. Discord webhook is working perfectly!',
    color: 0x00FF88,
    fields: [
      { name: 'Status', value: 'Active', inline: true },
      { name: 'Schedule', value: 'Every 10 Minutes', inline: true }
    ],
    footer: { text: 'Mattel Vehicle Alert Setup Test' },
    timestamp: new Date().toISOString()
  };

  try {
    const res = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] })
    });

    if (!res.ok) {
      throw new Error(`Discord API status ${res.status}`);
    }

    return { success: true, message: 'Test message sent to Discord successfully!' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Render Modern HTML Dashboard GUI for Cloudflare Worker URL
 */
function renderDashboard(metrics, env) {
  const hasWebhook = Boolean(env.DISCORD_WEBHOOK_URL);
  const hasKV = Boolean(env.LISTING_KV);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mattel Creations - Vehicle Alert Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: rgba(18, 26, 44, 0.75);
      --card-border: rgba(255, 255, 255, 0.08);
      --primary: #ff0044;
      --primary-glow: rgba(255, 0, 68, 0.35);
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
      background: linear-gradient(135deg, #ff0044, #ff5500);
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
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
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

    .card:hover {
      border-color: rgba(255, 255, 255, 0.18);
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

    .actions {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
      margin-bottom: 2rem;
    }

    .btn {
      font-family: 'Outfit', sans-serif;
      font-weight: 600;
      font-size: 1rem;
      padding: 0.85rem 1.6rem;
      border-radius: 12px;
      border: none;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 0.6rem;
      transition: all 0.2s ease;
      text-decoration: none;
    }

    .btn-primary {
      background: linear-gradient(135deg, var(--primary), #d90036);
      color: white;
      box-shadow: 0 4px 20px var(--primary-glow);
    }

    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 24px var(--primary-glow);
    }

    .btn-secondary {
      background: rgba(255, 255, 255, 0.08);
      color: var(--text);
      border: 1px solid var(--card-border);
    }

    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.14);
      transform: translateY(-2px);
    }

    .section-title {
      font-family: 'Outfit', sans-serif;
      font-size: 1.25rem;
      font-weight: 600;
      margin-bottom: 1rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
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

    .instructions {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 1.5rem;
      margin-top: 2rem;
    }

    .instructions h3 {
      font-family: 'Outfit', sans-serif;
      font-size: 1.1rem;
      margin-bottom: 0.75rem;
      color: var(--accent);
    }

    .instructions ol {
      margin-left: 1.25rem;
      line-height: 1.7;
      color: var(--text-muted);
    }

    .instructions code {
      background: rgba(255, 255, 255, 0.1);
      padding: 0.2rem 0.4rem;
      border-radius: 4px;
      color: #fff;
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
      <div class="brand-logo">MC</div>
      <div>
        <h1>Mattel Vehicle Listing Alert</h1>
        <p class="subtitle">Cloudflare Worker • Automatic 10-Minute Cron Checks</p>
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
        <div class="card-title">Tracked Vehicles</div>
        <div class="card-value">${metrics.totalVehicles || 0}</div>
      </div>

      <div class="card">
        <div class="card-title">Discord Webhook</div>
        <div style="margin-top: 0.5rem;">
          ${hasWebhook 
            ? '<span class="badge badge-success">✓ Configured</span>' 
            : '<span class="badge badge-warning">⚠ Not Set (Set in Worker Vars)</span>'}
        </div>
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

    <div class="actions">
      <button class="btn btn-primary" onclick="runManualCheck()">
        ⚡ Run Check Now
      </button>
      <button class="btn btn-secondary" onclick="sendTestDiscord()">
        🔔 Test Discord Webhook
      </button>
      <a href="https://creations.mattel.com/collections/mattel-creations-shop-all?#filter.tags_category=Vehicles" target="_blank" rel="noopener" class="btn btn-secondary">
        🔗 View Mattel Vehicles Store
      </a>
    </div>

    <div class="section-title">📊 Last Check Logs & Metrics</div>
    <div class="console" id="log-console">
[Timestamp] ${metrics.timestamp || 'No check executed yet'}
Status: ${metrics.status || 'Idle'}
Total Products Scanned: ${metrics.totalProducts || 0}
Total Vehicles Found: ${metrics.totalVehicles || 0}
New Vehicles Found: ${metrics.newVehiclesFound || 0}

Logs:
${(metrics.logs || ['Waiting for first run...']).join('\n')}
    </div>

    <div class="instructions">
      <h3>⚙️ Cloudflare Worker Deployment Setup Checklist</h3>
      <ol>
        <li>In Cloudflare Dashboard, go to your Worker <strong>Settings -> Variables</strong>.</li>
        <li>Add a secret named <code>DISCORD_WEBHOOK_URL</code> with your Discord Webhook URL.</li>
        <li>Go to <strong>KV Namespaces</strong>, create a namespace named <code>LISTING_KV</code>, and bind it to your Worker in settings with variable name <code>LISTING_KV</code>.</li>
        <li>Cron Trigger is set to <code>*/10 * * * *</code> (every 10 minutes). When your PC is off, Cloudflare will check automatically in the cloud and send Discord alerts instantly!</li>
      </ol>
    </div>
  </main>

  <footer>
    Mattel Creations Vehicle Monitor • Powered by Cloudflare Workers
  </footer>

  <script>
    async function runManualCheck() {
      const toast = document.getElementById('output-toast');
      const consoleEl = document.getElementById('log-console');
      toast.style.display = 'block';
      toast.className = 'badge-warning';
      toast.innerText = '⏳ Executing vehicle check... Please wait...';

      try {
        const res = await fetch('/api/check', { method: 'POST' });
        const data = await res.json();
        
        toast.className = data.status === 'success' ? 'badge-success' : 'badge-danger';
        toast.innerText = 'Check completed! New vehicles found: ' + (data.newVehiclesFound || 0);

        consoleEl.innerText = JSON.stringify(data, null, 2);
        setTimeout(() => location.reload(), 3000);
      } catch (err) {
        toast.className = 'badge-danger';
        toast.innerText = 'Failed to execute check: ' + err.message;
      }
    }

    async function sendTestDiscord() {
      const toast = document.getElementById('output-toast');
      toast.style.display = 'block';
      toast.className = 'badge-warning';
      toast.innerText = '⏳ Sending test notification to Discord...';

      try {
        const res = await fetch('/api/test-discord', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
          toast.className = 'badge-success';
          toast.innerText = '✅ ' + data.message;
        } else {
          toast.className = 'badge-danger';
          toast.innerText = '❌ Error: ' + data.error;
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
