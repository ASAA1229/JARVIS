# JARVIS Browser Assistant

An ASAA / JARVIS browsing assistant for Chrome, Edge, Brave, Opera, Arc (and other Chromium browsers) and Firefox.
It talks only to your local JARVIS (`http://127.0.0.1:<port>`), reads a page only when you ask, and learns nothing without your approval.

## Build

```
npm run build:browser-extension
```

Outputs `browser-extension/dist/chromium` and `browser-extension/dist/firefox` (no bundler, no dependencies).

## Create a browser key

```
npm run browser-key -- create chrome-laptop
```

(or Studio, Learning page, "From the browser", "Create browser key"). The key is shown once; JARVIS stores only its hash.
Revoke with `npm run browser-key -- revoke chrome-laptop` or from Studio. JARVIS must be running.

## Load unpacked

Chrome / Edge / Brave / Opera / Arc: open `chrome://extensions` (Edge `edge://extensions`), enable Developer mode, choose
"Load unpacked" and select `browser-extension/dist/chromium`. Click the JARVIS toolbar icon to open the side panel.

Firefox: open `about:debugging#/runtime/this-firefox`, choose "Load Temporary Add-on" and select
`browser-extension/dist/firefox/manifest.json`. Open the sidebar from the toolbar icon (or View, Sidebar).

## Connect

Open "Settings and privacy" in the panel, keep the address `http://127.0.0.1:3000` (use your JARVIS port), paste the
browser key, press Save. "Forget key" removes it. By default the key is kept only for the browser session.

## Privacy

- No host access to the web: only `activeTab` (granted when you click the icon, use the context menu or the shortcut Alt+Shift+S).
- Banking, mail and health sites are blocked by default (editable); private windows are disabled.
- Password and payment fields are never read; text is redacted before it is sent; only loopback JARVIS URLs are used.
- Pages you read are saved in JARVIS as pending; approve or reject them in Studio, Learning page.
