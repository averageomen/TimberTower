# Timber Stack — 3D Multiplayer Jenga

Full-stack multiplayer 3D Jenga built with React 19, Three.js (`@react-three/fiber` + `@react-three/rapier`), **Supabase (Postgres + Realtime Broadcast & Presence)**, and Electron.

---

## 1. Supabase Backend Setup (5 Minutes, Free Tier Works)

1. Go to https://supabase.com/dashboard and click **New Project**.
2. Once the project finishes provisioning, open **SQL Editor → New query**.
3. Copy the entire contents of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**.
   - This creates the `public.jenga_rooms` table, enables guest RLS policies (no login required for friends), and enables Supabase Realtime updates.
4. Go to **Project Settings → API** and copy:
   - **Project URL** (`https://xxxxxxxxxxxx.supabase.co`)
   - **anon public** API key

---

## 2. Configure GitHub & Publish the Downloadable Windows `.exe` + macOS `.dmg` / `.zip`

1. On your GitHub repository, open **Settings → Secrets and variables → Actions → Variables** tab.
2. Add two **Repository Variables**:
   - `VITE_SUPABASE_URL` = `https://xxxxxxxxxxxx.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = your Supabase `anon public` key
3. Push your code and trigger the release:
   ```bash
   git add .
   git commit -m "Add macOS build and self-updater support alongside Windows"
   git push origin main
   ```
   Then either:
   - **In GitHub UI:** Open **Actions → Build & Release Windows EXE + macOS App → Run workflow** (set `release_tag` e.g. `v1.0.13`) and click **Run workflow**, **OR**
   - **Via Git:**
     ```bash
     git tag v1.0.13
     git push origin v1.0.13
     ```
4. Share your GitHub **Releases** page with your friends!
   - **Windows:** Download **`TimberStack-Jenga-Portable.exe`** or **`TimberStack-Jenga-Setup-x.y.z.exe`**.
   - **macOS (Apple Silicon M1/M2/M3/M4):** Download **`TimberStack-Jenga-Mac-arm64-x.y.z.dmg`** (or `.zip`).
   - **macOS (Intel):** Download **`TimberStack-Jenga-Mac-x64-x.y.z.dmg`** (or `.zip`).
   - *Note for macOS users (unsigned build):* If macOS Gatekeeper shows an unverified developer prompt on first launch, either **Control-click (Right-click) the app → Open**, or run in Terminal:
     ```bash
     xattr -cr "/Applications/Timber Stack Jenga.app"
     ```

---

## 3. Local Development / Local Desktop Builds (macOS & Windows)

1. Copy `client/.env.example` (or configure in the in-app settings) with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
2. Install dependencies and run locally:
   ```bash
   npm --prefix client install
   npm --prefix client run dev
   ```
3. Build desktop packages locally into `client/release/`:
   - **macOS (`.dmg` + `.zip` for Apple Silicon & Intel):**
     ```bash
     npm run build:mac
     ```
   - **macOS (Apple Silicon `arm64` only):**
     ```bash
     npm run build:mac:arm64
     ```
   - **Windows (`.exe` Portable & Setup):**
     ```bash
     npm run build:exe
     ```
