# 🚗 Mattel Creations - Vehicle Listing Alert (Cloudflare Worker)

An automated Cloudflare Worker that checks [Mattel Creations Vehicles](https://creations.mattel.com/collections/mattel-creations-shop-all?#filter.tags_category=Vehicles) **every 10 minutes** for newly listed vehicle products and sends real-time rich alerts to a Discord channel via Webhook.

Because it runs entirely on Cloudflare's Edge network, **it runs 24/7 even when your PC is turned off**.

---

## ✨ Key Features

- 🕒 **10-Minute Automated Cron Check**: Cloudflare scheduled trigger (`*/10 * * * *`) checks Mattel Creations around the clock.
- 🚨 **Discord Webhook Alerts**: High-impact rich embeds with product title, store link, thumbnail image, price, stock status, and timestamp.
- 💾 **State Storage (Cloudflare KV)**: Remembers previously seen vehicle IDs using Cloudflare KV namespace `LISTING_KV`.
- 🎛️ **Built-In Web GUI Dashboard**: Accessing your worker URL (`https://<worker>.<subdomain>.workers.dev`) displays a web control panel to:
  - View current status and vehicle count.
  - Trigger an immediate check manually with **"Run Check Now"**.
  - Test your Discord webhook setup with **"Test Discord Webhook"**.
  - Inspect execution logs in real-time.

---

## 🚀 Quick Setup & Deployment Guide

### 1. Prerequisites
- Node.js installed on your machine.
- A free [Cloudflare Account](https://dash.cloudflare.com/).
- A Discord Server with a Webhook URL ([How to create a Discord Webhook](https://support.discord.com/hc/en-us/articles/228383668)).

### 2. Local Testing
```bash
# Clone the repository
git clone https://github.com/tufayel03/listing-alert.git
cd listing-alert

# Install Wrangler CLI locally if needed
npm install

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
*(Wrangler will ask you to log in to Cloudflare in your browser if you haven't already).*

#### Step B: Set Your Discord Webhook URL (Secret)
1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) -> **Workers & Pages**.
2. Click on **`listing-alert`**.
3. Go to **Settings** -> **Variables and Secrets**.
4. Under **Secret Variables**, click **Add**.
   - **Variable Name**: `DISCORD_WEBHOOK_URL`
   - **Value**: Your Discord Webhook URL (e.g., `https://discord.com/api/webhooks/...`)
5. Click **Save and Deploy**.

#### Step C: Create & Bind KV Namespace (For Persisting Seen Vehicles)
1. In Cloudflare Dashboard, go to **Storage & Databases** -> **KV**.
2. Click **Create Namespace**, name it `LISTING_KV`.
3. Go back to **Workers & Pages** -> **`listing-alert`** -> **Settings** -> **Variables and Secrets**.
4. Scroll down to **KV Namespace Bindings** and click **Add binding**.
   - **Variable name**: `LISTING_KV`
   - **KV namespace**: Select `LISTING_KV`.
5. Click **Save and Deploy**.

---

## 🎯 Verification

1. Open your Cloudflare Worker URL (e.g., `https://listing-alert.<your-subdomain>.workers.dev`).
2. Click **"Test Discord Webhook"** to confirm notifications arrive in your Discord channel.
3. Click **"Run Check Now"** to execute an immediate scan.
4. Sit back! The worker will automatically scan Mattel Creations every 10 minutes and alert you whenever a new vehicle drops.

---

## 🛠️ Tech Stack

- **Cloudflare Workers** (Edge Compute)
- **Cloudflare KV** (Key-Value State Persistence)
- **Discord Webhooks API** (Rich Embed Notifications)
- **Shopify Storefront REST API** (Mattel Creations Product Data)
