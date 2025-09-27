# music-pot (GHCR bundle)

ZimaOS/Portainer non può installare pacchetti durante la build. Usa questo bundle:
- **Build** dell'immagine su GitHub Actions (GHCR)
- **Deploy** su Portainer solo con `image:` (nessuna build locale)

## Passi
1. Crea un repository GitHub e carica **tutti** i file di questo zip.
2. Sostituisci nel file `docker-compose.portainer.yml` la riga:
   `image: ghcr.io/<TUO_UTENTE>/<TUO_REPO>:latest`
   con il tuo utente/repo GitHub.
3. Committa su `main`: partirà l'Action che builda e pubblica l'immagine.
4. In Portainer, crea uno stack usando **docker-compose.portainer.yml** e imposta `DISCORD_TOKEN`.

### Comandi
- `!play <link|titolo>`

### Funzioni
- Stream diretto `yt-dlp -> WebM/Opus` (niente ffmpeg)
- Pannello unico con **barra progressiva** e **timer** (trascorso/rimanente)
- Bottoni: pausa, resume, skip, stop, queue (ephemeral)

### Variabili
- `DISCORD_TOKEN` (obbligatorio)
- `PROGRESS_INTERVAL_MS` (default 3000 ms)
