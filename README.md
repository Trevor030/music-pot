# Discord Music Bot (prefix `!`) + GitHub reader — Docker ready

## Comandi (prefisso `!`)
Musica:
- `!play <url o ricerca>`
- `!pause`, `!resume`, `!skip`, `!stop`, `!leave`

GitHub:
- `!ghrepo` — mostra la repo corrente (da env `GITHUB_REPO`)
- `!ghlist [percorso] [ref]`
- `!ghfile <percorso> [ref]`

> Nota: per leggere i messaggi serve abilitare **MESSAGE CONTENT INTENT** nel Discord Developer Portal (sezione Bot).

## Variabili (Portainer → Environment)
- `DISCORD_TOKEN` (obbligatorio)
- `CLIENT_ID` (consigliato, non usato nei comandi prefix ma utile a identificazione)
- `GUILD_ID` (consigliato)
- `GITHUB_TOKEN` (necessario per repo private — fine-grained, Contents: Read-only)
- `GITHUB_REPO` (es. `owner/nome-repo`, default per i comandi GitHub)

## Deploy con Portainer (consigliato, senza file .env)
1. Stacks → Add stack → Web editor.
2. Incolla il contenuto di `docker-compose.yml` da questa cartella.
3. In basso **Environment variables**: aggiungi le variabili qui sopra.
4. Deploy.

Se preferisci Docker CLI:
```bash
docker build -t discord-music-bot .
docker run -d --name discord-music-bot \  -e DISCORD_TOKEN=xxx -e GITHUB_REPO=owner/repo \  --restart unless-stopped discord-music-bot
```

## Note
- `opusscript` evita build native; meno performante ma stabile su Portainer.
- FFmpeg è già installato nell'immagine.
