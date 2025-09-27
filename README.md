# discord-music-bot — 26.1 clean-chat (progress)

**Cosa fa**
- Player unico + coda unica (no duplicati)
- Elimina comandi dopo l’uso e messaggi non validi
- Stato: 🔎 preparazione → 🎶 riproduzione → ❌ errore
- Barra progressiva + timer trascorso/rimanente
- Streaming `yt-dlp -> WebM/Opus` (senza ffmpeg)

**Deploy consigliato (ZimaOS/Portainer + GHCR)**
1. Crea un repo GitHub e carica tutti i file di questo zip.
2. Modifica `docker-compose.portainer.yml` con la tua immagine: `ghcr.io/<TUO_UTENTE>/<TUO_REPO>:latest`.
3. Commit su `main` → parte il workflow **Build & Push (GHCR)**.
4. In Portainer → Stacks → **Add stack** → incolla `docker-compose.portainer.yml`.
5. Imposta **DISCORD_TOKEN**. Deploy.
6. In Discord: `!play <link o titolo>`.

**Permessi necessari**
- Il bot deve avere **Manage Messages** nel canale testo per poter cancellare i messaggi.
