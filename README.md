# discord-music-bot-prefix — 26.0 clean-chat

Questo pacchetto applica:
- **Player unico** (pannello) e **coda unica** (un messaggio)
- **Elimina tutto il resto**: comandi (subito dopo l'elaborazione), messaggi non validi, duplicati
- Streaming diretto `yt-dlp -> WebM/Opus` (nessun ffmpeg)
- Nessun bind mount/volume richiesto su Portainer

## Come deployare su ZimaOS/Portainer (consigliato GHCR)
1. Crea un repo GitHub e carica tutti i file.
2. Modifica `docker-compose.portainer.yml` con la tua immagine: `ghcr.io/<TUO_UTENTE>/<TUO_REPO>:latest`.
3. Commit su `main` → parte il workflow **Build & Push (GHCR)**.
4. In Portainer → Stacks → **Add stack** → incolla `docker-compose.portainer.yml`.
5. Imposta la variabile d'ambiente **DISCORD_TOKEN**. **Deploy**.
6. In Discord: `!play <link o titolo>`.

> ZimaOS non può scrivere su `/data/compose` e non permette build: per questo qui usi **solo `image:`**.

## Permessi
- Il bot deve avere **Manage Messages** nel canale testo per poter cancellare i messaggi.

## Config
- `DISCORD_TOKEN` – token bot Discord (obbligatorio)
- `PROGRESS_INTERVAL_MS` – refresh barra/timer (default 3000 ms)
