# Secure laptop-to-phone connection

## Required network shape

```
Android phone 1 ─┐
                 ├── private VPN / trusted private network ── HTTPS :443 ── Caddy ── 127.0.0.1:3000 JARVIS
Android phone 2 ─┘
```

JARVIS intentionally binds its Node server to loopback. Do not change it to `0.0.0.0` just to make the phones connect. Put a TLS reverse proxy in front of it and keep access limited to your private network.

## Caddy setup (template)

1. Install Caddy on the Windows laptop.
2. Choose a DNS hostname you control. Configure it to resolve to the laptop only for clients on your private VPN/network.
3. Copy `deploy/Caddyfile.example` into your Caddy configuration and replace `jarvis.example.com` with that hostname.
4. Ensure Caddy can obtain/renew a publicly trusted TLS certificate. Keep firewall rules restricted to the private VPN/network; do not create a general public port-forward to the JARVIS service.
5. Start JARVIS normally on loopback port 3000, then start/reload Caddy.
6. On each Android phone, enter the HTTPS hostname in JARVIS Companion. Never use `http://`, a certificate-warning bypass, or a permissive trust manager.
7. Test with a harmless read-only request before trying any action that changes state.

If a publicly trusted certificate cannot be issued for your private hostname, stop and choose a documented trusted certificate strategy before pairing. Do not disable certificate validation to work around TLS errors.

## Availability and safety

- The laptop must be awake and JARVIS/Caddy must be running. This setup does not implement remote wake.
- A disconnected phone must reconnect and establish a fresh session. Revoked devices must not be re-enrolled without a new owner-approved transaction.
- If a request times out, treat a state-changing result as unknown; check task/audit status before retrying.
- The current Android client supports enrollment, authenticated text requests, local user-initiated app launching, bounded read-only app inventory, encrypted offline sync queue storage, and optional WorkManager approval polling. Polling is opt-in and runs no more frequently than Android's 15-minute periodic-work minimum; it is not real-time push. The client does not receive remote arbitrary app-control commands, SMS/call actions, notification-list access, or remote wake.
- Do not expose the owner-control token or enrollment code in logs, screenshots, issue reports, or chat messages.
