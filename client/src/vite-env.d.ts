/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface JengaUpdaterBridge {
  getVersion: () => Promise<string>;
  checkForUpdate: () => Promise<{
    updateAvailable: boolean;
    currentVersion: string;
    latestVersion: string;
    downloadUrl: string | null;
    releaseNotes: string;
    releasePageUrl: string;
  }>;
  startUpdate: (downloadUrl: string) => Promise<void>;
  onProgress: (callback: (percent: number) => void) => () => void;
  onError: (callback: (message: string) => void) => () => void;
}

interface Window {
  jengaUpdater?: JengaUpdaterBridge;
}
