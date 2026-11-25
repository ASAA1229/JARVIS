/**
 * Manifest builder for the JARVIS browser extension (E3:D4.21). One source tree, two targets:
 *   chromium  Chrome, Edge, Brave, Opera, Arc and other Chromium browsers (service worker + side panel)
 *   firefox   Firefox (event page via background.scripts + sidebar_action)
 *
 * Permissions are minimal: no <all_urls>, no content scripts. Page content is read only on a user action
 * through activeTab + scripting. Host permissions cover loopback JARVIS URLs only.
 */
export const VERSION = '0.1.0';
export const TARGETS = ['chromium', 'firefox'];
export const BACKGROUND_SCRIPTS = ['lib/redact.js', 'lib/policy.js', 'background.js'];
export const LOOPBACK_HOSTS = ['http://127.0.0.1/*', 'http://localhost/*', 'http://[::1]/*'];

export function buildManifest(target) {
  if (!TARGETS.includes(target)) throw new Error(`Unknown target "${target}"`);
  const icons = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' };
  const manifest = {
    manifest_version: 3,
    name: 'JARVIS Browser Assistant',
    short_name: 'JARVIS',
    version: VERSION,
    description: 'ASAA JARVIS private browsing assistant: summarize, explain, extract and ask about the page you choose. Local-only, reads pages only on your action.',
    author: 'ASAA',
    icons,
    action: { default_title: 'JARVIS', default_icon: icons },
    permissions: ['activeTab', 'storage', 'contextMenus', 'scripting'],
    host_permissions: [...LOOPBACK_HOSTS],
    incognito: 'not_allowed',
    commands: {
      _execute_action: { suggested_key: { default: 'Alt+J' }, description: 'Open JARVIS' },
      'summarize-page': { suggested_key: { default: 'Alt+Shift+S' }, description: 'Summarize this page with JARVIS' },
    },
  };
  if (target === 'chromium') {
    manifest.permissions.push('sidePanel');
    manifest.minimum_chrome_version = '114';
    manifest.background = { service_worker: 'background.js' };
    manifest.side_panel = { default_path: 'panel/panel.html' };
  } else {
    manifest.background = { scripts: [...BACKGROUND_SCRIPTS] };
    manifest.sidebar_action = { default_title: 'JARVIS', default_panel: 'panel/panel.html', default_icon: icons, open_at_install: false };
    manifest.browser_specific_settings = { gecko: { id: 'jarvis-browser-assistant@asaa.local', strict_min_version: '128.0' } };
  }
  return manifest;
}
