export interface AppUpdateInfo {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string;
  downloadUrl: string | null;
  releaseNotes: string;
  releasePageUrl: string;
  canSelfUpdate: boolean;
}

const GITHUB_LATEST_API =
  'https://api.github.com/repos/averageomen/TimberTower/releases/latest';
const GITHUB_RELEASES_PAGE =
  'https://github.com/averageomen/TimberTower/releases';

export const APP_VERSION =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '1.0.11';

function compareSemver(a: string, b: string): number {
  const cleanA = a.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const cleanB = b.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(cleanA.length, cleanB.length, 3);
  for (let i = 0; i < len; i++) {
    const partA = cleanA[i] ?? 0;
    const partB = cleanB[i] ?? 0;
    if (partA > partB) return 1;
    if (partA < partB) return -1;
  }
  return 0;
}

export async function getCurrentAppVersion(): Promise<string> {
  if (typeof window !== 'undefined' && window.jengaUpdater) {
    try {
      return await window.jengaUpdater.getVersion();
    } catch {
      return APP_VERSION;
    }
  }
  return APP_VERSION;
}

export async function checkForAppUpdate(): Promise<AppUpdateInfo> {
  if (typeof window !== 'undefined' && window.jengaUpdater) {
    const info = await window.jengaUpdater.checkForUpdate();
    return {
      ...info,
      canSelfUpdate: true,
    };
  }

  // Fallback check when running in browser / Vite dev mode
  const currentVersion = APP_VERSION;
  try {
    const res = await fetch(GITHUB_LATEST_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(4500),
    });
    if (!res.ok) {
      return {
        updateAvailable: false,
        currentVersion,
        latestVersion: currentVersion,
        downloadUrl: null,
        releaseNotes: '',
        releasePageUrl: GITHUB_RELEASES_PAGE,
        canSelfUpdate: false,
      };
    }

    const release = (await res.json()) as {
      tag_name?: string;
      body?: string;
      html_url?: string;
      assets?: Array<{ name?: string; browser_download_url?: string }>;
    };
    const latestVersion = String(release.tag_name ?? currentVersion).replace(/^v/i, '');
    const isMacBrowser =
      typeof navigator !== 'undefined' &&
      /Mac|iPod|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');

    const asset = isMacBrowser
      ? release.assets?.find((a) => /\.dmg$/i.test(a.name ?? '') && /arm64/i.test(a.name ?? '')) ??
        release.assets?.find((a) => /\.dmg$/i.test(a.name ?? '')) ??
        release.assets?.find((a) => /mac.*\.zip$/i.test(a.name ?? '')) ??
        null
      : release.assets?.find((a) => /portable.*\.exe$/i.test(a.name ?? '')) ??
        release.assets?.find((a) => /\.exe$/i.test(a.name ?? '')) ??
        null;

    return {
      updateAvailable:
        compareSemver(latestVersion, currentVersion) > 0 &&
        Boolean(asset?.browser_download_url),
      currentVersion,
      latestVersion,
      downloadUrl: asset?.browser_download_url ?? null,
      releaseNotes: release.body ?? '',
      releasePageUrl: release.html_url ?? GITHUB_RELEASES_PAGE,
      canSelfUpdate: false,
    };
  } catch {
    return {
      updateAvailable: false,
      currentVersion,
      latestVersion: currentVersion,
      downloadUrl: null,
      releaseNotes: '',
      releasePageUrl: GITHUB_RELEASES_PAGE,
      canSelfUpdate: false,
    };
  }
}

export async function startAppSelfUpdate(downloadUrl: string): Promise<void> {
  if (typeof window !== 'undefined' && window.jengaUpdater) {
    await window.jengaUpdater.startUpdate(downloadUrl);
    return;
  }
  window.open(downloadUrl, '_blank', 'noopener,noreferrer');
}

export function subscribeUpdateEvents(
  onProgress: (percent: number) => void,
  onError: (message: string) => void
): () => void {
  if (typeof window === 'undefined' || !window.jengaUpdater) {
    return () => undefined;
  }
  const offProgress = window.jengaUpdater.onProgress(onProgress);
  const offError = window.jengaUpdater.onError(onError);
  return () => {
    offProgress();
    offError();
  };
}
