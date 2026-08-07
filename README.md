# 🚗 Multi-Store Vehicle & Hot Wheels Listing Alert (Cloudflare Worker)

An automated Cloudflare Worker that checks **Mattel Creations (Vehicles)** and **JCAR Diecast (Hot Wheels)** every 10 minutes for newly listed products and sends real-time rich alerts to dedicated Discord channels via separate Webhooks.

Because it runs entirely on Cloudflare's Edge network, **it runs 24/7 even when your PC is turned off**.

---

## ✨ Key Features

- 🕒 **10-Minute Automated Cron Check**: Cloudflare scheduled trigger (`*/10 * * * *`) checks both stores around the clock.
- 🚨 **Store-Specific Discord Webhooks**:
  - **Mattel Creations Channel**: Dedicated notifications for Mattel vehicle drops.
  - **JCAR Diecast Channel**: Dedicated notifications for JCAR Hot Wheels drops.
- 💾 **State Storage (Cloudflare KV)**: Remembers previously seen product IDs using Cloudflare KV namespace `LISTING_KV`.
- 🎛️ **Built-In Web GUI Dashboard**: Accessing your worker URL (`https://<worker>.<subdomain>.workers.dev`) displays a web control panel to:
  - View current status and vehicle/item count across both stores.
  - Configure and test individual Discord Webhooks for Mattel and JCAR.
  - Trigger immediate manual checks with **"Run Check Now"**.
  - Inspect execution logs in real-time.

---

## 🚀 Quick Setup & Deployment Guide

### 1. Prerequisites
- Node.js installed on your machine.
- A free [Cloudflare Account](https://dash.cloudflare.com/).
- Discord Webhooks created for Mattel & JCAR channels.

### 2. Local Testing
```bash
# Clone the repository
git clone https://github.com/tufayel03/listing-alert.git
cd listing-alert

# Run locally
npm run dev
```
Open `http://localhost:8787` in your browser to view the GUI dashboard and test manual checks.

---

### 3. Deploy to Cloudflare Workers

#### Step A: Deploy the Worker
Run the deploy command from your terminal:
```bash
npx wrangler deploy
```

#### Step B: Set Your Store Discord Webhook URLs (Secret Variables in Cloudflare GUI)
1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) -> **Workers & Pages**.
2. Click on **`listing-alert`**.
3. Go to **Settings** -> **Variables and Secrets**.
4. Under **Secret Variables**, click **Add**:
   - **`MATTEL_WEBHOOK_URL`**: Your Discord Webhook URL for Mattel Creations.
   - **`JCAR_WEBHOOK_URL`**: Your Discord Webhook URL for JCAR Diecast.
5. Click **Save and Deploy**. *(Note: You can also manage/override webhooks directly from the Worker's Web Dashboard UI).*

---

## 🎯 Verification

1. Open your Cloudflare Worker URL (e.g., `https://listing-alert.<your-subdomain>.workers.dev`).
2. Use **"Test"** under each store section to confirm notifications arrive in the respective Discord channels.
3. Click **"Run Check Now"** to execute an immediate scan.
