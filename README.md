### 26.1-fix3.4
- **Idle cleanup**: dopo `IDLE_MINUTES` senza riproduzione esce dal VC e **pulisce tutti i messaggi** del bot.
- **Client fallback** yt-dlp: `android` (con PO token se presente) → `ios` → `web`; formati `251/250/249` → `bestaudio`.
- **clientReady** al posto di `ready` (niente deprecation).
- Pannello unico (mutex) + coda preservata + skip effimero + canale bloccato `1421488309456208117`.
