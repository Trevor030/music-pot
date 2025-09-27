# discord-music-bot — 26.1 fix2 (clean chat + locked channel)

**Novità**
- Comandi e bottoni **solo** nel canale testo **1421488309456208117**
- Rimossi i pulsanti **Pausa** e **Coda**
- Aggiunto pulsante **Disconnetti** (svuota coda, ferma stream, lascia il canale vocale)
- Coda/Skip resi **atomici** (niente incastri/race)
- Player unico + coda unica, chat pulita

**Deploy (ZimaOS/Portainer + GHCR)**
1. Carica questi file in un repo GitHub.
2. Aggiorna `docker-compose.portainer.yml` con la tua immagine GHCR/Docker Hub.
3. Commit su main → parte il workflow (**Build & Push (GHCR)**).
4. In Portainer → Stacks → **Add stack** → incolla `docker-compose.portainer.yml`.
5. Variabili: `DISCORD_TOKEN`, opzionale `PROGRESS_INTERVAL_MS`.
6. In Discord usa il canale **1421488309456208117** e i comandi: `!play`, `!skip`, `!stop`, `!disconnect`.

**Permessi**
- Il bot deve avere **Manage Messages** sul canale 1421488309456208117 per cancellare i messaggi.
