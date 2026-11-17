const { app, BrowserWindow, ipcMain, net, shell } = require('electron');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const GITHUB_RELEASE_API =
  'https://api.github.com/repos/averageomen/TimberTower/releases/latest';

let mainWindow = null;

function compareSemver(a, b) {
  const cleanA = String(a).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const cleanB = String(b).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(cleanA.length, cleanB.length, 3);
  for (let i = 0; i < len; i++) {
    const partA = cleanA[i] ?? 0;
    const partB = cleanB[i] ?? 0;
    if (partA > partB) return 1;
    if (partA < partB) return -1;
  }
  return 0;
}

function selectAssetForCurrentMode(assets) {
  if (!Array.isArray(assets)) return null;

  if (process.platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const archRegex = new RegExp(`(mac|darwin|osx).*${arch}|${arch}.*(mac|darwin|osx)`, 'i');

    // Prefer .zip for seamless in-place .app bundle self-update on macOS
    const archZip = assets.find(
      (a) => /\.zip$/i.test(a.name || '') && archRegex.test(a.name || '')
    );
    if (archZip) return archZip;

    const universalZip = assets.find(
      (a) => /\.zip$/i.test(a.name || '') && /(universal|mac|darwin|osx)/i.test(a.name || '')
    );
    if (universalZip) return universalZip;

    const anyZip = assets.find((a) => /\.zip$/i.test(a.name || ''));
    if (anyZip) return anyZip;

    // Fallback to .dmg installer
    const archDmg = assets.find(
      (a) => /\.dmg$/i.test(a.name || '') && archRegex.test(a.name || '')
    );
    if (archDmg) return archDmg;

    return assets.find((a) => /\.dmg$/i.test(a.name || '')) ?? null;
  }

  const isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);

  if (isPortable) {
    const portableAsset = assets.find((asset) =>
      /portable.*\.exe$/i.test(asset.name || '')
    );
    if (portableAsset) return portableAsset;
  } else {
    const setupAsset = assets.find((asset) =>
      /setup.*\.exe$/i.test(asset.name || '')
    );
    if (setupAsset) return setupAsset;
  }

  return (
    assets.find((asset) => /\.exe$/i.test(asset.name || '')) ?? null
  );
}

function findAppBundleInDir(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.endsWith('.app')) {
      return path.join(dirPath, entry.name);
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const nested = findAppBundleInDir(path.join(dirPath, entry.name));
      if (nested) return nested;
    }
  }
  return null;
}

function resolveCurrentMacAppBundlePath() {
  // process.execPath on macOS is `<AppName>.app/Contents/MacOS/<Executable>`
  const marker = '.app/Contents/MacOS/';
  const idx = process.execPath.indexOf(marker);
  if (idx !== -1) {
    return process.execPath.slice(0, idx + 4);
  }
  return null;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'Timber Stack — 3D Multiplayer Jenga',
    autoHideMenuBar: process.platform !== 'darwin',
    backgroundColor: '#16110d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.handle('updater:get-version', () => app.getVersion());

ipcMain.handle('updater:check', async () => {
  const currentVersion = app.getVersion();
  try {
    const response = await net.fetch(GITHUB_RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'TimberStack-Jenga-Updater',
      },
      signal: AbortSignal.timeout(4500),
    });

    if (!response.ok) {
      return {
        updateAvailable: false,
        currentVersion,
        latestVersion: currentVersion,
        downloadUrl: null,
        releaseNotes: '',
        releasePageUrl: 'https://github.com/averageomen/TimberTower/releases',
      };
    }

    const release = await response.json();
    const latestTag = String(release.tag_name || currentVersion);
    const latestVersion = latestTag.replace(/^v/i, '');
    const asset = selectAssetForCurrentMode(release.assets);
    const isNewer = compareSemver(latestVersion, currentVersion) > 0;

    return {
      updateAvailable: Boolean(isNewer && asset?.browser_download_url),
      currentVersion,
      latestVersion,
      downloadUrl: asset?.browser_download_url ?? null,
      releaseNotes: String(release.body || ''),
      releasePageUrl: String(
        release.html_url || 'https://github.com/averageomen/TimberTower/releases'
      ),
    };
  } catch {
    return {
      updateAvailable: false,
      currentVersion,
      latestVersion: currentVersion,
      downloadUrl: null,
      releaseNotes: '',
      releasePageUrl: 'https://github.com/averageomen/TimberTower/releases',
    };
  }
});

ipcMain.handle('updater:start', async (_event, downloadUrl) => {
  if (!downloadUrl || typeof downloadUrl !== 'string') {
    throw new Error('Missing update download URL.');
  }

  const sendProgress = (pct) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:progress', pct);
    }
  };

  try {
    sendProgress(0);
    const response = await net.fetch(downloadUrl, {
      headers: { 'User-Agent': 'TimberStack-Jenga-Updater' },
    });

    if (!response.ok || !response.body) {
      throw new Error(`Failed to download update (HTTP ${response.status}).`);
    }

    const totalBytes = Number(response.headers.get('content-length') || '0');
    const tempDir = app.getPath('temp');
    const isMac = process.platform === 'darwin';
    const isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
    const urlPath = new URL(downloadUrl).pathname.toLowerCase();
    const isZip = urlPath.endsWith('.zip');
    const isDmg = urlPath.endsWith('.dmg');

    const downloadedFileName = isMac
      ? `TimberStack-Jenga-Update-${Date.now()}${isZip ? '.zip' : isDmg ? '.dmg' : '.pkg'}`
      : isPortable
        ? `TimberStack-Jenga-Update-${Date.now()}.exe`
        : `TimberStack-Jenga-Setup-Update-${Date.now()}.exe`;
    const downloadedFilePath = path.join(tempDir, downloadedFileName);

    const fileStream = fs.createWriteStream(downloadedFilePath);
    const reader = response.body.getReader();
    let receivedBytes = 0;
    let lastReportedPct = -1;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        receivedBytes += value.byteLength;
        await new Promise((resolve, reject) => {
          if (!fileStream.write(Buffer.from(value))) {
            fileStream.once('drain', resolve);
            fileStream.once('error', reject);
          } else {
            resolve();
          }
        });
        if (totalBytes > 0) {
          const pct = Math.min(99, Math.floor((receivedBytes / totalBytes) * 100));
          if (pct !== lastReportedPct) {
            lastReportedPct = pct;
            sendProgress(pct);
          }
        }
      }
    }

    await new Promise((resolve, reject) => {
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
      fileStream.end();
    });

    sendProgress(100);

    if (isMac) {
      if (isZip) {
        const extractDir = path.join(tempDir, `jenga-mac-update-${Date.now()}`);
        fs.mkdirSync(extractDir, { recursive: true });
        await execFileAsync('/usr/bin/ditto', ['-x', '-k', downloadedFilePath, extractDir]);

        const extractedAppPath = findAppBundleInDir(extractDir);
        if (!extractedAppPath) {
          throw new Error('Could not find .app bundle inside downloaded macOS update archive.');
        }

        await execFileAsync('/usr/bin/xattr', ['-cr', extractedAppPath]).catch(() => undefined);

        const currentAppPath = resolveCurrentMacAppBundlePath();
        const targetAppPath =
          currentAppPath && !currentAppPath.startsWith('/Volumes/')
            ? currentAppPath
            : path.join('/Applications', path.basename(extractedAppPath));

        const scriptPath = path.join(tempDir, `jenga-self-update-${Date.now()}.sh`);
        const script = [
          '#!/bin/sh',
          'sleep 2',
          `rm -rf "${targetAppPath}"`,
          `mv "${extractedAppPath}" "${targetAppPath}"`,
          `/usr/bin/xattr -cr "${targetAppPath}" 2>/dev/null || true`,
          `open -n "${targetAppPath}"`,
          `rm -rf "${extractDir}" "${downloadedFilePath}" "$0"`,
        ].join('\n');
        fs.writeFileSync(scriptPath, script, { encoding: 'utf8', mode: 0o755 });

        const child = spawn('/bin/sh', [scriptPath], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();

        app.quit();
        return;
      }

      // Fallback for .dmg on macOS: clear quarantine & mount/open the disk image
      await execFileAsync('/usr/bin/xattr', ['-cr', downloadedFilePath]).catch(() => undefined);
      await shell.openPath(downloadedFilePath);
      app.quit();
      return;
    }

    const scriptPath = path.join(tempDir, `jenga-self-update-${Date.now()}.cmd`);
    if (isPortable && process.env.PORTABLE_EXECUTABLE_FILE) {
      const targetExe = process.env.PORTABLE_EXECUTABLE_FILE;
      const script = [
        '@echo off',
        'setlocal',
        'set count=0',
        ':retry',
        'ping 127.0.0.1 -n 2 > nul',
        `move /Y "${downloadedFilePath}" "${targetExe}" > nul 2>&1`,
        'if errorlevel 1 (',
        '  set /a count+=1',
        '  if %count% GEQ 30 exit /b 1',
        '  goto retry',
        ')',
        `start "" "${targetExe}"`,
        'del "%~f0"',
      ].join('\r\n');
      fs.writeFileSync(scriptPath, script, 'utf8');
    } else {
      const installedExe = process.execPath;
      const script = [
        '@echo off',
        'ping 127.0.0.1 -n 3 > nul',
        `start /wait "" "${downloadedFilePath}" /S`,
        `start "" "${installedExe}"`,
        `del "${downloadedFilePath}" > nul 2>&1`,
        'del "%~f0"',
      ].join('\r\n');
      fs.writeFileSync(scriptPath, script, 'utf8');
    }

    const child = spawn('cmd.exe', ['/c', scriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();

    app.quit();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Update download failed.';
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:error', message);
    }
    throw error;
  }
});

app.whenReady().then(() => {
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
