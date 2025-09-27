import 'dotenv/config'
import sodium from 'libsodium-wrappers'
await sodium.ready

import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js'
import { joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior, AudioPlayerStatus, getVoiceConnection, StreamType } from '@discordjs/voice'
import { spawn } from 'child_process'
import https from 'https'
import { Readable } from 'stream'

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

function isUrl(str) { try { new URL(str); return true } catch { return false } }

// Resolve title + best opus URL quickly via yt-dlp, without starting a download process that stays alive
async function resolveYouTube(query) {
  if (isUrl(query)) {
    // If it's already a URL, try to fetch title + opus URL with yt-dlp
    return await resolveWithYtDlp(query)
  } else {
    return await resolveWithYtDlp(query, true)
  }
}

function resolveWithYtDlp(input, useSearch=false) {
  return new Promise((resolve, reject) => {
    const target = useSearch ? input : input
    const args = [
      '--no-playlist',
      '--no-progress',
      '--force-ipv4',
      '-f', 'bestaudio[acodec=opus]/bestaudio',
      '--get-title',
      '--get-url'
    ]
    if (useSearch) args.unshift('--default-search','ytsearch')
    args.push(target)
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    proc.stdout.on('data', d => { out += d.toString() })
    proc.stderr.on('data', d => console.error('[yt-dlp resolve]', d.toString()))
    proc.on('close', code => {
      if (code !== 0) return reject(new Error('yt-dlp resolve failed'))
      const lines = out.trim().split('\n')
      if (lines.length < 2) return reject(new Error('Nessun risultato valido trovato.'))
      const title = lines[0]
      const url = lines[1]
      resolve({ title, url })
    })
  })
}

// Direct HTTP streaming with keep-alive; no ffmpeg in the fast path
function httpOpusStream(mediaUrl) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 6 })
  return new Promise((resolve, reject) => {
    const req = https.get(mediaUrl, {
      agent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Node Discord Music Bot)',
        'Accept': '*/*',
        'Connection': 'keep-alive'
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error('HTTP ' + res.statusCode))
      }
      // Convert web stream to Node Readable if necessary (res is already Readable)
      resolve(res)
    })
    req.on('error', reject)
  })
}

function transcodePipeline(urlOrQuery) {
  const ytdlp = spawn('yt-dlp', ['-f', 'bestaudio', '--no-playlist', '-o', '-', urlOrQuery], { stdio: ['ignore', 'pipe', 'pipe'] })
  ytdlp.stderr.on('data', d => console.error('[yt-dlp]', d.toString()))
  const ffmpeg = spawn('ffmpeg', [
    '-loglevel', 'error', '-hide_banner',
    '-i', 'pipe:0',
    '-vn',
    '-ac', '2',
    '-c:a', 'libopus', '-b:a', '128k',
    '-f', 'ogg', 'pipe:1'
  ], { stdio: ['pipe', 'pipe', 'pipe'] })
  ytdlp.stdout.pipe(ffmpeg.stdin)
  ffmpeg.stderr.on('data', d => console.error('[ffmpeg]', d.toString()))
  return ffmpeg.stdout
}

async function playNext(guildId) {
  const data = queues.get(guildId)
  if (!data) return
  const next = data.queue.shift()
  if (!next) { data.textChannel?.send('📭 Coda finita.'); return }
  try {
    const { url, title } = await resolveYouTube(next.query)

    // Quick attempt: use direct HTTP stream (assumes opus/webm from yt-dlp format selection)
    let started = false
    let resource
    try {
      const httpStream = await httpOpusStream(url)
      resource = createAudioResource(httpStream, { inputType: StreamType.WebmOpus })
      data.player.once(AudioPlayerStatus.Playing, () => { started = true })
      data.player.play(resource)
    } catch (e) {
      console.warn('Direct HTTP stream failed, falling back to ffmpeg:', e.message)
    }

    // Fallback only if not started within a short window
    setTimeout(() => {
      if (!started) {
        const trans = transcodePipeline(url)
        resource = createAudioResource(trans, { inputType: StreamType.OggOpus })
        data.player.play(resource)
      }
    }, 1500)

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
