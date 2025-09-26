import 'dotenv/config'
import sodium from 'libsodium-wrappers'
await sodium.ready

import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js'
import { joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior, AudioPlayerStatus, getVoiceConnection, StreamType } from '@discordjs/voice'
import { spawn } from 'child_process'

const PREFIX = '!'
const queues = new Map()

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
})

client.once('clientReady', () => console.log(`🤖 Online come ${client.user.tag}`))

function ensureGuild(guildId, channel) {
  if (!queues.has(guildId)) {
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } })
    player.on('error', e => console.error('Audio player error:', e))
    queues.set(guildId, { queue: [], player, textChannel: channel })
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

// Build a robust pipeline: yt-dlp -> ffmpeg (transcode/demux) -> ogg/opus
function buildAudioPipeline(query) {
  const ytdlp = spawn('yt-dlp', ['-f', 'bestaudio', '--no-playlist', '-o', '-', query], { stdio: ['ignore', 'pipe', 'pipe'] })
  ytdlp.stderr.on('data', d => console.error('[yt-dlp]', d.toString()))
  const ffmpeg = spawn('ffmpeg', [
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-vn',
    '-ac', '2',
    '-f', 'ogg',
    '-c:a', 'libopus',
    '-b:a', '128k',
    'pipe:1'
  ], { stdio: ['pipe', 'pipe', 'pipe'] })
  ytdlp.stdout.pipe(ffmpeg.stdin)
  ffmpeg.stderr.on('data', d => console.error('[ffmpeg]', d.toString()))
  return ffmpeg.stdout
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
    const stream = buildAudioPipeline(url)
    const resource = createAudioResource(stream, { inputType: StreamType.OggOpus })
    data.player.play(resource)
    const embed = new EmbedBuilder().setTitle('▶️ In riproduzione').setDescription(`[${title}](${url})`).setFooter({ text: `Richiesto da ${next.requestedBy}` })
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
    if (!query) return void message.reply('Uso: `!play <link YouTube o titolo>`')
    const vc = message.member.voice?.channel
    if (!vc) return void message.reply('Devi essere in un canale vocale 🎙️')
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
  if (command === 'pause') { data.player.pause(); return void message.reply('⏸️ Pausa.') }
  if (command === 'resume') { data.player.unpause(); return void message.reply('▶️ Ripresa.') }
  if (command === 'skip') { data.player.stop(true); return void message.reply('⏭️ Skip.') }
  if (command === 'stop') { data.queue.length = 0; data.player.stop(true); return void message.reply('🛑 Fermato e coda svuotata.') }
  if (command === 'leave') { getVoiceConnection(guildId)?.destroy(); return void message.reply('👋 Uscito dal canale.') }
})

client.login(process.env.DISCORD_TOKEN)
