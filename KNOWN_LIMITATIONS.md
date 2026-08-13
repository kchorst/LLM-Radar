# Known Limitations — 0.5.0H

- Android keyboard behavior still requires real-device acceptance testing.
- Local AI must be running for model summary/ask; Sample loading itself only needs the Computer file route.
- If Windows firewall or Wi-Fi isolation blocks the Computer file route, the app should now point the user to Rescan QR / Try Sample / Diagnostics.
- npm audit still reports existing dependency warnings: 16 vulnerabilities, 1 low and 15 moderate.
