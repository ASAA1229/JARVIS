/*
 * JARVIS browser extension: background (service worker on Chromium, event page on Firefox).
 * Reads a page ONLY in response to a user action (side panel button, context menu, keyboard shortcut).
 * No content script is declared in the manifest: the reader is injected on demand into the active tab.
 */
(function () {
  'use strict';
  var ext = globalThis.browser || globalThis.chrome;
  if (typeof importScripts === 'function') importScripts('lib/redact.js', 'lib/policy.js');
  var Policy = self.JarvisPolicy;

  var MENU = { page: 'jarvis-summarize-page', selection: 'jarvis-explain-selection', ask: 'jarvis-ask-page' };

  function setupMenus() {
    ext.contextMenus.removeAll(function () {
      ext.contextMenus.create({ id: MENU.page, title: 'JARVIS: summarize this page', contexts: ['page', 'frame'] });
      ext.contextMenus.create({ id: MENU.selection, title: 'JARVIS: explain selection', contexts: ['selection'] });
      ext.contextMenus.create({ id: MENU.ask, title: 'JARVIS: ask about this page', contexts: ['page', 'frame', 'selection'] });
    });
  }

  ext.runtime.onInstalled.addListener(function () {
    setupMenus();
    if (ext.sidePanel && ext.sidePanel.setPanelBehavior) ext.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(function () {});
  });
  if (ext.runtime.onStartup) ext.runtime.onStartup.addListener(setupMenus);

  // Firefox: the toolbar button toggles the sidebar.
  if (ext.sidebarAction && ext.action && ext.action.onClicked) {
    ext.action.onClicked.addListener(function () { ext.sidebarAction.toggle(); });
  }

  /** Must be called synchronously inside a user-gesture handler. */
  function openPanel(tab) {
    try {
      if (ext.sidePanel && ext.sidePanel.open && tab && tab.id !== undefined) return ext.sidePanel.open({ tabId: tab.id });
      if (ext.sidebarAction && ext.sidebarAction.open) return ext.sidebarAction.open();
    } catch (e) { /* fall through to the window fallback */ }
    return ext.windows.create({ url: ext.runtime.getURL('panel/panel.html?window=1'), type: 'popup', width: 420, height: 720 });
  }

  function queue(task) {
    var area = ext.storage.session || ext.storage.local;
    return area.set({ jarvisQueued: Object.assign({ at: Date.now() }, task) });
  }

  ext.contextMenus.onClicked.addListener(function (info, tab) {
    openPanel(tab); // synchronous: keeps the user gesture
    var action = info.menuItemId === MENU.page ? 'summarize' : info.menuItemId === MENU.selection ? 'explain' : info.menuItemId === MENU.ask ? 'focus-ask' : '';
    if (action) queue({ action: action, tabId: tab && tab.id });
  });

  ext.commands.onCommand.addListener(function (command, tab) {
    if (command !== 'summarize-page') return;
    openPanel(tab);
    queue({ action: 'summarize', tabId: tab && tab.id });
  });

  async function settings() {
    var stored = await ext.storage.local.get({ blocklist: null });
    return { blocklist: Array.isArray(stored.blocklist) ? stored.blocklist : Policy.DEFAULT_BLOCKLIST };
  }

  /** Read the page in `tabId`. include: { structured, forms }. Returns { ok, page } or { ok:false, reason, message }. */
  async function readPage(tabId, include) {
    var tab;
    try { tab = await ext.tabs.get(tabId); } catch (e) { return { ok: false, reason: 'no-tab', message: 'That tab is no longer available.' }; }
    if (tab.incognito) return { ok: false, reason: 'private', message: 'JARVIS is disabled in private windows.' };
    var cfg = await settings();
    if (tab.url && Policy.isBlocked(tab.url, cfg.blocklist)) {
      return { ok: false, reason: 'blocked', message: 'This site is on your blocklist (or is not a normal web page), so JARVIS will not read it.' };
    }
    var results;
    try {
      await ext.scripting.executeScript({ target: { tabId: tabId }, files: ['lib/extract.js'] });
      results = await ext.scripting.executeScript({
        target: { tabId: tabId },
        func: function (inc) {
          var selection = '';
          try { selection = String(window.getSelection() || ''); } catch (e) { /* none */ }
          return self.JarvisExtract.extractPage(document, { url: location.href, selection: selection, include: inc });
        },
        args: [include || {}]
      });
    } catch (e) {
      return { ok: false, reason: 'no-access', message: 'JARVIS can only read a tab after you use it there. Click the JARVIS toolbar icon (or use the context menu or shortcut) on this tab, then try again.' };
    }
    var page = results && results[0] && results[0].result;
    if (!page) return { ok: false, reason: 'empty', message: 'Nothing could be read from this page.' };
    // The final URL may differ from the tab URL (redirects, single-page apps): re-check the blocklist.
    if (Policy.isBlocked(page.url, cfg.blocklist)) return { ok: false, reason: 'blocked', message: 'This site is on your blocklist, so JARVIS discarded the content.' };
    return { ok: true, page: page };
  }

  ext.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    // Only this extension's own pages (the side panel) may ask for a read.
    if (sender.id !== ext.runtime.id || !message || message.type !== 'read-page' || typeof message.tabId !== 'number') return false;
    readPage(message.tabId, message.include).then(sendResponse, function () { sendResponse({ ok: false, reason: 'error', message: 'Reading the page failed.' }); });
    return true;
  });
})();
