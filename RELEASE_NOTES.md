# LLM Radar 0.7.0

0.7.0 is a no-GUI stabilization release focused on small UI polish, refresh-first recovery, and sample text transfer hardening.

## Highlights
- Skips Windows GUI work for now; keeps `Start_Here.bat` and the command-window heartbeat/dots.
- Mobile bottom tab changed from **Test** to **Chat**.
- Chat field now shows **Enter chat here**.
- Reduced exact repeated labels on QR, Answer/Response, and Consultant Pack screens.
- If Chat works but Sample text transfer fails, Files now shows **QR refresh needed** and the main action is **Reconnect QR**.
- Laptop/browser page main recheck action now uses **Refresh Status** wording.
- TXT/MD readable-text gate now rejects obvious gibberish/repeated-token text.

## QA
- TypeScript typecheck passed.
- Phone Access JS syntax check passed.
- Route smoke checks passed in no-Local-AI mode.
- Clean TXT accepted; gibberish TXT rejected.
