# Career Ops: Private Render Deployment Guide

Step-by-step production deployment manual for hosting Career Ops as a private, authenticated, persistent web application on Render.

---

## 1. Architecture Overview

Career Ops on Render is deployed as a **Native Node.js Web Service** backed by a **Persistent Disk**.

```
Render External HTTPS (career-ops.onrender.com)
                     │
                     ▼
┌───────────────────────────────────────────────┐
│  Auth & Security Gateway (deploy/gateway.mjs) │
│  - Port $PORT (0.0.0.0)                       │
│  - Enforces login, sessions & rate limits     │
│  - Applies CSP & security headers             │
│  - Healthcheck at /healthz                    │
└──────────────────────┬────────────────────────┘
                       │ Loopback HTTP (127.0.0.1:INTERNAL_PORT)
                       ▼
┌───────────────────────────────────────────────┐
│     Next.js Production App (web/)             │
│     - App Router, Dashboard, APIs             │
│     - Data Root: /var/data/career-ops         │
└──────────────────────┬────────────────────────┘
                       │
                       ▼
┌───────────────────────────────────────────────┐
│      Render Persistent Disk (10 GB)           │
│      Mounted at /var/data/career-ops          │
│      - data/ (applications, pipeline)         │
│      - config/ (profile.yml, portals.yml)     │
│      - reports/, output/, .sessions/          │
└───────────────────────────────────────────────┘
```

- **Zero Exposure Without Auth:** Next.js binds exclusively to `127.0.0.1`. All incoming traffic is filtered by the Gateway.
- **Persistent Data:** Personal records (applications, CVs, evaluation reports, sessions) reside exclusively on the persistent disk mounted at `/var/data/career-ops` and survive redeployments.
- **No Docker Required:** Runs natively on Render's Node runtime.

---

## 2. Prerequisites

1. **Render Account:** A paid plan (Starter tier or higher) is required because Render persistent disks are only available on paid instances.
2. **GitHub Fork:** Your own repository fork under `https://github.com/Zagorden23/career-ops`.
3. **Local Node.js (v22+):** To generate your secure password hash prior to deployment.

---

## 3. Step-by-Step Deployment Instructions

### Step 1: Push Branch to Your GitHub Fork

Ensure your local branch is pushed to your personal fork (`Zagorden23/career-ops`):

```bash
# Add your fork as a remote if not already added:
git remote add fork https://github.com/Zagorden23/career-ops.git

# Push the deployment branch:
git push fork feature/render-private-deployment
```

### Step 2: Generate Your Owner Password Hash

Run the built-in password hashing utility locally. Do not put plaintext passwords into Render environment variables.

```bash
node deploy/hash-password.mjs "YourSuperStrongPassword123!#"
```

Output:
```bash
CAREER_OPS_AUTH_PASSWORD_HASH="scrypt:3a7f5383...:6a7d6922..."
```
Copy the full string (including `scrypt:`).

---

### Step 3: Create Web Service on Render

1. Log into your [Render Dashboard](https://dashboard.render.com).
2. Click **New +** and select **Web Service**.
3. Connect your repository: `Zagorden23/career-ops`.
4. Configure service settings:
   - **Name:** `career-ops` (or your preferred name)
   - **Region:** `Oregon` (or closest region)
   - **Branch:** `feature/render-private-deployment`
   - **Runtime:** `Node`
   - **Plan:** `Starter` (or Standard 2GB if you plan to enable PDF rendering)
   - **Build Command:**
     ```bash
     PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-audit --no-fund && npm --prefix web ci --include=dev && npm --prefix web run build
     ```
   - **Start Command:**
     ```bash
     node deploy/render-start.mjs
     ```

---

### Step 4: Attach Persistent Disk

1. In your Web Service settings, scroll down to the **Disks** section (or click the **Disks** tab).
2. Click **Add Disk**.
3. Configure the disk:
   - **Name:** `career-ops-data`
   - **Mount Path:** `/var/data/career-ops`
   - **Size:** `10 GB` (minimum 1 GB, 10 GB recommended for PDF and report history)
4. Save the disk configuration.

> [!IMPORTANT]
> The mount path must be exactly `/var/data/career-ops`. The supervisor validates that this storage exists and is writable before booting Next.js.

---

### Step 5: Configure Environment Variables

Under the **Environment** tab of your Render service, add the following variables:

| Variable | Recommended Value | Notes |
|---|---|---|
| `NODE_VERSION` | `22.13.0` | Pin supported Node.js runtime |
| `NODE_ENV` | `production` | Production mode |
| `NEXT_TELEMETRY_DISABLED` | `1` | Disable telemetry |
| `CAREER_OPS_ROOT` | `/var/data/career-ops` | Points data layer to persistent disk |
| `CAREER_OPS_CLOUD` | `1` | Enables cloud guards |
| `CAREER_OPS_AUTH_USER` | `admin` (or your username) | The owner login username |
| `CAREER_OPS_AUTH_PASSWORD_HASH` | `scrypt:...` | The scrypt hash from Step 2 |
| `CAREER_OPS_SESSION_SECRET` | *(Click "Generate")* | 32+ character random secret |
| `CAREER_OPS_WEB_ALLOWED_HOSTS` | `career-ops.onrender.com` | Your assigned Render domain |

#### Optional AI & Feature Variables

| Variable | Description |
|---|---|
| `GEMINI_API_KEY` | Google Gemini API key (for API evaluation scripts) |
| `OPENAI_API_KEY` | OpenAI API key |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `CAREER_OPS_ENABLE_PDF` | `0` (default). Set to `1` only on Standard 2GB+ plans |

---

### Step 6: Configure Health Check

1. Under the **Health Check** section of your Web Service settings:
   - **Health Check Path:** `/healthz`
2. Save changes. Render will ping this path to verify service readiness.

---

### Step 7: Deploy and Verify

1. Trigger a manual deploy (or push a commit to your branch).
2. Monitor the **Deploy Logs**:
   ```
   [storage] Verified persistent storage at /var/data/career-ops
   [supervisor] Next.js internal port: 3001
   [supervisor] Spawning Next.js on 127.0.0.1:3001...
   [gateway] Production Auth & Security Gateway listening on 0.0.0.0:10000
   [gateway] Healthcheck available at http://0.0.0.0:10000/healthz
   ```
3. Open `https://your-service.onrender.com` in your browser:
   - Unauthenticated visitors are immediately redirected to `/login`.
   - Test an invalid password: confirmed error alert and rate-limiting delay.
   - Enter your owner username and password: confirmed redirect to `/` with full access to Career Ops.
   - Click **Logout**: verified session termination and redirect back to `/login`.

---

## 4. Blueprints (Optional render.yaml Deployment)

A `render.yaml` file is included in the repository root. You can deploy using Render Blueprints:
1. Go to **Blueprints** in the Render Dashboard.
2. Select your repository `Zagorden23/career-ops`.
3. Review the resources (Web service + 10 GB Disk).
4. Supply your secret values (`CAREER_OPS_AUTH_USER`, `CAREER_OPS_AUTH_PASSWORD_HASH`) in the dashboard prompt.
5. Deploy.

---

## 5. Cloud Feature Feasibility Matrix

| Feature | Supported in Cloud | Notes |
|---|---|---|
| **Dashboard & Pipeline View** | ✅ Yes | Reads/writes persistently to `/var/data/career-ops`. |
| **Applications Tracker** | ✅ Yes | Full status transitions, notes, and updates persist. |
| **Portal Scanners** | ✅ Yes | Greenhouse, Ashby, Lever REST APIs run with zero LLM cost. |
| **Analytics & Funnel Stats** | ✅ Yes | Fully functional across all data. |
| **CV Studio & Tailoring View** | ✅ Yes | Reads CV drafts and templates from persistent storage. |
| **Single-Owner Auth & Sessions** | ✅ Yes | Gateway enforces scrypt auth and durable sessions. |
| **Local Coding CLIs (Hermes, Claude Code)** | ⚠️ Requires Setup | Local desktop CLIs are not pre-installed in the cloud container. API providers or local sync can be used. |
| **Apply Assistant (Browser Auto-Fill)** | ❌ Desktop Only | Requires a local headed Chrome window and human handoff. Intercepted safely with HTTP 501 in cloud mode. |
| **Scheduled Scans (Cron)** | ⚠️ Separate Worker | In-process crons do not run when the container scales or reboots; use a Render Cron Job if automated scans are needed. |

---

## 6. Maintenance & Backups

### Disk Snapshots
Render automatically supports manual and scheduled snapshots of Persistent Disks.
- Go to your Web Service -> **Disks** -> **career-ops-data**.
- Click **Create Snapshot** before major updates.

### Password Rotation
To rotate your password:
1. Generate a new hash: `node deploy/hash-password.mjs "NewPasswordHere"`
2. Update `CAREER_OPS_AUTH_PASSWORD_HASH` in the Render Environment Variables tab.
3. Render will redeploy with the new credential.
