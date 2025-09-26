import 'dotenv/config'
import { REST, Routes } from 'discord.js'

const commands = [
  { name: 'play', description: 'Riproduci musica da YouTube (URL o ricerca).',
    options: [{ name: 'query', description: 'URL di YouTube o termini di ricerca', type: 3, required: true }] },
  { name: 'pause', description: 'Metti in pausa.' },
  { name: 'resume', description: 'Riprendi la riproduzione.' },
  { name: 'skip', description: 'Salta al prossimo brano.' },
  { name: 'stop', description: 'Ferma e svuota la coda.' },
  { name: 'leave', description: 'Esci dal canale vocale.' },
  { name: 'ghrepo', description: 'Imposta o mostra il repository GitHub di default (owner/repo).',
    options: [{ name: 'set', description: 'owner/repo da impostare', type: 3, required: false }] },
  { name: 'ghlist', description: 'Lista file/dir dal repo (path opzionale).',
    options: [{ name: 'path', description: 'Percorso nella repo', type: 3, required: false },
              { name: 'ref', description: 'Branch o SHA', type: 3, required: false }] },
  { name: 'ghfile', description: 'Leggi un file dalla repo.',
    options: [{ name: 'path', description: 'Percorso del file', type: 3, required: true },
              { name: 'ref', description: 'Branch o SHA', type: 3, required: false }] }
]

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN)
await rest.put(
  Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
  { body: commands }
)
console.log('✅ Slash command registrati!')
