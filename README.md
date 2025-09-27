# music-pot — Bundle completo (custom)

Questo pacchetto contiene **tutto** per avere il tuo bot personalizzato:
- `index.js` (pannello, barra progressiva, timer; WebM/Opus diretto, senza ffmpeg)
- `package.json`
- `Dockerfile` (builda solo su GitHub Actions, non su ZimaOS)
- Workflow per **GHCR** e per **Docker Hub**
- Compose per Portainer che usa solo `image:` (niente build, niente volumi)
- `.env.example`

## Come procedere (consigliato GHCR)
1. Crea un repository GitHub e carica tutti i file di questo zip.
2. Modifica `docker-compose.portainer.yml` mettendo la tua immagine: `ghcr.io/<TUO_UTENTE>/<TUO_REPO>:latest`.
3. Commit su `main` → parte il workflow **Build & Push (GHCR)**.
4. In Portainer (ZimaOS), crea lo stack usando **docker-compose.portainer.yml**.
5. Imposta la variabile **DISCORD_TOKEN** (evita bind mounts). Deploy.

### Alternativa Docker Hub
- Imposta i secrets `DOCKERHUB_USERNAME` e `DOCKERHUB_TOKEN` nel repo.
- Lancia manualmente il workflow **Build & Push (Docker Hub)**.
- In Portainer usa `docker-compose.portainer.dockerhub.yml` (sostituisci `<DOCKERHUB_USER>/<REPO>`).

## Config
- `DISCORD_TOKEN`: token del bot (obbligatorio)
- `PROGRESS_INTERVAL_MS`: refresh barra/timer (default 3000 ms)

## Comandi
- `!play <link|titolo>` – aggiunge e avvia
- Bottoni: pausa, resume, skip, stop, queue

> ZimaOS non deve installare nulla: scarica solo l’immagine già buildata da GitHub/Docker Hub.
