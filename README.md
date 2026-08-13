# LLM Radar 0.7.0

LLM Radar is a phone-first local AI proof tool. The phone connects to a Local AI server running on a computer on the same Wi-Fi/LAN. The model does not run on the phone.

## 0.7.0 focus
- No Windows GUI in this release.
- Keep `Start_Here.bat` and the trusted command-window heartbeat.
- Mobile tab: **Chat** instead of **Test**.
- Chat box placeholder: **Enter chat here**.
- Refresh-first recovery language on phone and laptop.
- If Chat works but Sample text transfer fails, reconnect with QR and retry Sample.
- Clean TXT/MD uploads pass; obvious gibberish/repeated-token text is rejected.

## Quick path
1. Start Local AI on the computer.
2. Double-click `Start_Here.bat`.
3. On the phone, scan the QR code.
4. Open **Chat** and send one short message.
5. Open **Files** and try **Sample**.
6. If Chat works but Sample fails, tap **Reconnect QR**, scan again, then retry Sample.

## Notes
- Keep the command window open while using LLM Radar.
- Use **Refresh Status** on the browser page after starting or restarting Local AI.
- Use **Check Again** or **Reconnect QR** on the phone instead of starting over.
