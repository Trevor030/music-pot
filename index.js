import 'dotenv/config'
import sodium from 'libsodium-wrappers'            // ensure encryption lib is ready
await sodium.ready

import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js'
import { joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior, AudioPlayerStatus, getVoiceConnection } from '@discordjs/voice'
import { spawn } from 'child_process'

const PREFIX = '!'
const queues = new Map()

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
})

client.once('clientReady', () => console.log(`🤖 Online come ${client.user.tag}`))

function ensureGuild(guildId, channel) {
  if (!queues.has(guildId)) {
    queues.set(guildId, {
      queue: [],
      player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } }),
      textChannel: channel
    })
  }
  return queues.get(guildId)
}

async function connectToVoice(channel) {
  return joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true
  })
}

function isUrl(str) {
  try { new URL(str); return true } catch { return false }
}

function ytDlpStream(query) {
  const args = ['-f', 'bestaudio', '--no-playlist', '-o', '-', query]
  const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stderr.on('data', d => console.error('[yt-dlp]', d.toString()))
  return child.stdout
}

async function resolveYouTube(query) {
  if (isUrl(query)) {
    return { url: query, title: query }
  } else {
    return new Promise((resolve, reject) => {
      const args = ['--default-search', 'ytsearch', '-f', 'bestaudio', '--no-playlist', '--get-title', '--get-url', query]
      const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      proc.stderr.on('data', d => console.error('[yt-dlp search]', d.toString()))
      let output = ''
      proc.stdout.on('data', d => { output += d.toString() })
      proc.on('close', code => {
        if (code !== 0) return reject(new Error('yt-dlp search failed'))
        const lines = output.trim().split('\n')
        if (lines.length < 2) return reject(new Error('Nessun risultato valido trovato.'))
        const title = lines[0]
        const url = lines[1]
        resolve({ url, title })
      })
    })
  }
}

async function playNext(guildId) {
  const data = queues.get(guildId)
  if (!data) return
  const next = data.queue.shift()
  if (!next) { data.textChannel?.send('📭 Coda finita.'); return }
  try {
    const { url, title } = await resolveYouTube(next.query)
    const stream = ytDlpStream(url)
    const resource = createAudioResource(stream)
    data.player.play(resource)
    const embed = new EmbedBuilder()
      .setTitle('▶️ In riproduzione')
      .setDescription(`[${title}](${url})`)
      .setFooter({ text: `Richiesto da ${next.requestedBy}` })
    data.textChannel?.send({ embeds: [embed] })
  } catch (err) {
    console.error('playNext error:', err)
    data.textChannel?.send(`⚠️ Errore con questo brano: ${err.message}`)
    playNext(guildId)
  }
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return
  if (!message.content.startsWith(PREFIX)) return

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/)
  const command = (args.shift() || '').toLowerCase()
  const guildId = message.guildId
  const data = ensureGuild(guildId, message.channel)

  if (command === 'play') {
    const query = args.join(' ')
    if (!query) { await message.reply('Uso: `!play <link YouTube o titolo>`'); return }
    const vc = message.member.voice?.channel
    if (!vc) { await message.reply('Devi essere in un canale vocale 🎙️'); return }
    try {
      const conn = getVoiceConnection(guildId) || await connectToVoice(vc)
      conn.subscribe(data.player)
      data.queue.push({ query, requestedBy: message.author.tag })
      if (data.player.state.status === AudioPlayerStatus.Idle) playNext(guildId)
      await message.reply(`🎶 Aggiunto in coda: **${query}**`)
    } catch (e) {
      console.error(e)
      await message.reply('❌ Non riesco a connettermi al canale vocale.')
    }
    return
  }
  if (command === 'pause') { data.player.pause(); await message.reply('⏸️ Pausa.'); return }
  if (command === 'resume') { data.player.unpause(); await message.reply('▶️ Ripresa.'); return }
  if (command === 'skip') { data.player.stop(true); await message.reply('⏭️ Skip.'); return }
  if (command === 'stop') { data.queue.length = 0; data.player.stop(true); await message.reply('🛑 Fermato e coda svuotata.'); return }
  if (command === 'leave') { getVoiceConnection(guildId)?.destroy(); await message.reply('👋 Uscito dal canale.'); return }
})

client.login(process.env.DISCORD_TOKEN)
