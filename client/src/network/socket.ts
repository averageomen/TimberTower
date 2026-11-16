import { io, Socket } from 'socket.io-client';

const STORAGE_KEY = 'jenga_server_url';

export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return 'http://localhost:3001';
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}

function getDefaultServerUrl(): string {
  const envUrl = import.meta.env.VITE_SERVER_URL;
  if (typeof envUrl === 'string' && envUrl.trim().length > 0) {
    return normalizeServerUrl(envUrl);
  }
  if (
    typeof window !== 'undefined' &&
    window.location.protocol.startsWith('http') &&
    window.location.hostname
  ) {
    return `http://${window.location.hostname}:3001`;
  }
  return 'http://localhost:3001';
}

function loadSavedServerUrl(): string {
  if (typeof window !== 'undefined') {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved && saved.trim().length > 0) {
        return normalizeServerUrl(saved);
      }
    } catch {
      // Ignore storage access errors in restricted environments
    }
  }
  return getDefaultServerUrl();
}

let currentServerUrl = loadSavedServerUrl();
let socketInstance: Socket | null = null;

export function getServerUrl(): string {
  return currentServerUrl;
}

export function setServerUrl(nextUrl: string): string {
  const normalized = normalizeServerUrl(nextUrl);
  currentServerUrl = normalized;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, normalized);
    } catch {
      // Ignore storage access errors
    }
  }
  if (socketInstance) {
    socketInstance.removeAllListeners();
    socketInstance.disconnect();
    socketInstance = null;
  }
  return normalized;
}

export function getSocket(): Socket {
  if (!socketInstance) {
    socketInstance = io(currentServerUrl, {
      autoConnect: false,
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 8,
      reconnectionDelay: 1000,
    });
  }
  return socketInstance;
}

export function connectSocket(): Socket {
  const socket = getSocket();
  if (!socket.connected) {
    socket.connect();
  }
  return socket;
}

export function disconnectSocket(): void {
  if (socketInstance?.connected) {
    socketInstance.disconnect();
  }
}
