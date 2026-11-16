# Timber Stack — 3D Multiplayer Jenga

Full-stack multiplayer 3D Jenga built with React 19, Three.js (`@react-three/fiber` + `@react-three/rapier`), Socket.IO, and Electron.

---

## 1. Sharing the Downloadable `.exe` with Friends via GitHub

### Automatic Build on GitHub (Recommended)
1. Push this repository to GitHub.
2. **Option A (GitHub Release):** Create and push a version tag:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
   GitHub Actions ([`.github/workflows/release-exe.yml`](.github/workflows/release-exe.yml)) will automatically build and attach two Windows executables to your GitHub **Releases** page:
   - `TimberStack-Jenga-Portable.exe` (single-file portable app — friends just double-click and play)
   - `TimberStack-Jenga-Setup-1.0.0.exe` (standard Windows installer)
3. **Option B (Manual Trigger with Baked-in NAS URL):**
   - Go to **Actions → Build & Release Windows EXE → Run workflow**.
   - Optionally enter your public/Tailscale NAS URL in `default_server_url` (for example `http://100.80.12.34:3001` or `https://jenga.yourdomain.com`) so your friends' `.exe` connects automatically without typing anything.
   - Download the `.exe` from the workflow **Artifacts**.

### Local Windows `.exe` Build
If you have Node.js 20+ installed on Windows:
```powershell
npm run install:all
npm run build:exe
```
Outputs are created inside `client/release/`.

---

## 2. Hosting the Backend on UGREEN NAS (UGOS Pro Docker)

The server runs on port `3001` and exposes `/health` plus Socket.IO WebSockets.

### Option A: Pull Prebuilt Image via GitHub Container Registry (`ghcr.io`)
1. Push to `main` on GitHub so [`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml) publishes `ghcr.io/<your-github-username>/jenga-server:latest` (supports both `amd64` Intel/AMD UGREEN NAS models and `arm64` models).
2. In GitHub **Packages**, ensure `jenga-server` package visibility is **Public** (or log in with a PAT in UGOS).
3. On your UGREEN NAS, open **Docker → Image → Image Repository / Add Image** and pull:
   ```text
   ghcr.io/<your-github-username>/jenga-server:latest
   ```
   *(Or use **Docker → Project → Create**, paste `docker-compose.yml`, comment out `build:`, and uncomment `image: ghcr.io/<your-github-username>/jenga-server:latest`.)*
4. Map container port **`3001`** to host port **`3001`**, set restart policy to **Unless stopped**, and start it.

### Option B: Build Directly on Your UGREEN NAS via Compose
1. Copy the `server/` folder and `docker-compose.yml` to a shared folder on your NAS (for example `/volume1/docker/jenga/`).
2. In **UGOS Pro → Docker → Project → Create**:
   - Choose the `/volume1/docker/jenga` path containing `docker-compose.yml`.
   - Click **Deploy**.
3. Verify it is running by visiting `http://<NAS-LAN-IP>:3001/health` (should return `{"status":"ok","service":"jenga-server",...}`).

---

## 3. Letting Friends Outside Your Home Connect to Your UGREEN NAS

Choose whichever remote-access method you prefer:

1. **Tailscale (Easiest & Safest — no router port forwarding needed):**
   - Run Tailscale on your UGREEN NAS and have friends join your Tailnet (or share the NAS node).
   - Friends enter `http://<NAS-TAILSCALE-IP>:3001` in the app's **Backend Server URL** box and click **Connect**.
2. **Cloudflare Tunnel (HTTPS Domain, no open router ports):**
   - Point a Cloudflare Tunnel hostname (e.g. `https://jenga.yourdomain.com`) to `http://localhost:3001` on the NAS.
   - Friends enter `https://jenga.yourdomain.com` in **Backend Server URL**.
3. **Router Port Forwarding:**
   - Forward external TCP port `3001` on your router to `<NAS-LAN-IP>:3001` (and ensure UGREEN NAS Firewall allows TCP `3001`).
   - Friends enter `http://<YOUR-PUBLIC-IP>:3001` in **Backend Server URL**.

The entered Backend Server URL is saved automatically in the app so friends only have to enter it once.
