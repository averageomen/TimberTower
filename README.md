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

## 2. Configure GitHub & Publish the Downloadable `.exe`

1. On your GitHub repository, open **Settings → Secrets and variables → Actions → Variables** tab.
2. Add two **Repository Variables**:
   - `VITE_SUPABASE_URL` = `https://xxxxxxxxxxxx.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = your Supabase `anon public` key
3. Push your code and trigger the release:
   ```powershell
   git add .
   git commit -m "Switch multiplayer backend to Supabase"
   git push origin main
   ```
   Then either:
   - **In GitHub UI:** Open **Actions → Build & Release Windows EXE → Run workflow** (set `release_tag` e.g. `v1.0.2`) and click **Run workflow**, **OR**
   - **Via Git:**
     ```powershell
     git tag v1.0.2
     git push origin v1.0.2
     ```
4. Share your GitHub **Releases** page with your friends! They download **`TimberStack-Jenga-Portable.exe`**, double-click it, and play immediately with zero port forwarding or VPNs required.

---

## 3. Local Development / Local `.exe` Build

1. Copy [`client/.env.example`](client/.env.example) to `client/.env` and fill in your `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
2. Install dependencies and run locally:
   ```powershell
   npm --prefix client install
   npm --prefix client run dev
   ```
3. Or build the Windows `.exe` locally into `client/release/`:
   ```powershell
   npm run build:exe
   ```
