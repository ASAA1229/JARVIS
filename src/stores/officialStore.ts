export type StorePlatform = 'windows' | 'android' | 'ios';

export interface OfficialStoreSearch {
  platform: StorePlatform;
  query: string;
  storeName: string;
  searchUrl: string;
  installationMode: 'official-store-user-confirmation';
  automatedInstallAvailable: false;
  note: string;
}

const STORES: Record<StorePlatform, { name: string; baseUrl: string; note: string }> = {
  windows: {
    name: 'Microsoft Store',
    baseUrl: 'https://apps.microsoft.com/search?query=',
    note: 'Open the Microsoft Store result and confirm installation in Windows. This API does not silently install software.',
  },
  android: {
    name: 'Google Play',
    baseUrl: 'https://play.google.com/store/search?q=',
    note: 'Open Google Play on the selected enrolled Android device and confirm installation there.',
  },
  ios: {
    name: 'Apple App Store',
    baseUrl: 'https://apps.apple.com/search?term=',
    note: 'Open the Apple App Store on the selected iOS device and confirm installation there.',
  },
};

const BLOCKED_TERMS = /\b(phonepe|paytm|google pay|gpay|payment app|banking app|wallet app)\b/i;

export function createOfficialStoreSearch(platform: StorePlatform, query: string): OfficialStoreSearch {
  if (!Object.hasOwn(STORES, platform)) throw new Error('Unsupported store platform.');
  if (typeof query !== 'string' || !query.trim() || query.trim().length > 120) {
    throw new Error('Search query must contain 1–120 characters.');
  }
  if (BLOCKED_TERMS.test(query)) throw new Error('JARVIS general-purpose automation excludes payment and financial applications.');
  const store = STORES[platform];
  const normalizedQuery = query.trim();
  return {
    platform,
    query: normalizedQuery,
    storeName: store.name,
    searchUrl: store.baseUrl + encodeURIComponent(normalizedQuery) + (platform === 'android' ? '&c=apps' : ''),
    installationMode: 'official-store-user-confirmation',
    automatedInstallAvailable: false,
    note: store.note,
  };
}
