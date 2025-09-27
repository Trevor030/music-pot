// robust25.3e-stream: bot musica Discord con supporto query testuali, streaming diretto e UX messaggi
import 'dotenv/config'
import sodium from 'libsodium-wrappers'; await sodium.ready

import { Client, GatewayIntentBits } from 'discord.js'
import {
  joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior,
  AudioPlayerStatus, getVoiceConnection, StreamType
} from '@discordjs/voice'
import { spawn } from 'child_process'

const PREFIX = '!'
const queues = new Map()

function ensureGuild(guildId, channel) {
  if (!queues.has(guildId)) {
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } })
    const data = { queue: [], player, textChannel: channel, current: null, playing: false }
    player.on(AudioPlayerStatus.Idle, () => {
      data.playing = false
      cleanup(data)
      if (data.queue.length) playNext(channel.guild.id).catch(() => {})
    })
    player.on('error', e => {
      console.error('[player]', e); data.playing = false; cleanup(data)
      if (data.queue.length) playNext(channel.guild.id).catch(() => {})
    })
    queues.set(guildId, data)
  }
  return queues.get(guildId)
}

function cleanup(data) {
  try { data.current?.feeder?.kill('SIGKILL') } catch {}
  try { data.current?.proc?.kill('SIGKILL') } catch {}
  data.current = null
}

function isUrl(s) { try { new URL(s); return true } catch { return false } }

// Titolo veloce (senza URL) per UX
function quickTitle(input) {
  return new Promise((resolve) => {
    const args = ['--no-playlist','--no-progress','-f','ba[acodec=opus]/ba/bestaudio','--get-title']
    if (isUrl(input)) args.push(input); else args.unshift('ytsearch1:' + input)
    const p = spawn('yt-dlp', args, { stdio: ['ignore','pipe','pipe'] })
    let out = ''; p.stdout.on('data', d => out += d.toString())
    p.on('close', () => resolve(out.trim().split('\n')[0] || input))
  })
}

// Streaming pipeline: yt-dlp -> stdout -> ffmpeg -> opus/ogg
function streamingPipeline(urlOrQuery) {
  const inputArg = isUrl(urlOrQuery) ? urlOrQuery : ('ytsearch1:' + urlOrQuery)
  const ytdlpArgs = [
    '-f','ba[acodec=opus]/ba/bestaudio/best',
    '--no-playlist','-o','-',
    '--', inputArg
  ]
  const feeder = spawn('yt-dlp', ytdlpArgs, { stdio: ['ignore','pipe','pipe'] })
  feeder.stderr.on('data', d => console.error('[yt-dlp]', d.toString()))

  const ffmpeg = spawn('ffmpeg', [
    '-loglevel','error','-hide_banner',
    '-i','pipe:0','-vn','-ac','2',
    '-c:a','libopus','-b:a','128k',
    '-f','ogg','pipe:1'
  ], { stdio: ['pipe','pipe','pipe'] })

  feeder.stdout.pipe(ffmpeg.stdin).on('error', () => {})
  ffmpeg.stderr.on('data', d => console.error('[ffmpeg]', d.toString()))
  return { feeder, proc: ffmpeg, stream: ffmpeg.stdout }
}

async function playNext(guildId) {
  const data = queues.get(guildId); if (!data) return
  if (data.playing) return
  const next = data.queue.shift(); if (!next) { data.textChannel?.send('📭 Coda finita.'); return }
  data.playing = true

  let msg = null
  if (next.placeholderId) {
    try { msg = await data.textChannel.messages.fetch(next.placeholderId) } catch { msg = null }
  }
  if (!msg) { try { msg = await data.textChannel.send(`⏳ Sto cercando: **${next.query}**`) } catch {} }

  const slowTimer = setTimeout(() => {
    if (msg) { try { msg.edit(`🔎 Ancora un attimo… cerco la versione migliore di **${next.query}**`) } catch {} }
  }, 1000)

  try {
    const title = await quickTitle(next.query)
    const { feeder, proc, stream } = streamingPipeline(next.query)
    data.current = { feeder, proc }

    const conn = getVoiceConnection(guildId); if (conn) conn.subscribe(data.player)
    const resource = createAudioResource(stream, { inputType: StreamType.OggOpus })
    data.player.once(AudioPlayerStatus.Playing, async () => {
      clearTimeout(slowTimer)
      if (msg) { try { await msg.edit(`▶️ In riproduzione: **${title}**`) } catch {} }
    })
    data.player.play(resource)

  } catch (e) {
    clearTimeout(slowTimer)
    console.error('[playNext]', e)
    if (msg) { try { await msg.edit(`⚠️ ${e.message}`) } catch {} }
    data.playing = false
    if (data.queue.length) playNext(guildId).catch(() => {})
  }
}

const client = new Client({ intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent
]})

client.once('clientReady', () => console.log(`🤖 Online come ${client.user.tag}`))

client.on('messageCreate', async (m) => {
  if (m.author.bot) return
  if (!m.content.startsWith(PREFIX)) return

  const args = m.content.slice(PREFIX.length).trim().split(/\s+/)
  const cmd = (args.shift() || '').toLowerCase()
  const data = ensureGuild(m.guildId, m.channel)

  if (cmd === 'play') {
    const q = args.join(' ')
    if (!q) return void m.reply('Uso: `!play <link o titolo>`')
    const vc = m.member.voice?.channel
    if (!vc) return void m.reply('Devi essere in un canale vocale 🎙️')

    const conn = getVoiceConnection(m.guildId) || joinVoiceChannel({
      channelId: vc.id, guildId: vc.guild.id, adapterCreator: vc.guild.voiceAdapterCreator, selfDeaf: true
    })
    conn.subscribe(data.player)

    const placeholder = await m.reply(`⏳ Sto cercando: **${q}**`)
    data.queue.push({ query: q, placeholderId: placeholder.id })
    if (data.player.state.status === AudioPlayerStatus.Idle && !data.playing) playNext(m.guildId).catch(() => {})
    return
  }

  if (cmd === 'skip') { data.player.stop(true); cleanup(data); return void m.reply('⏭️ Skip.') }
  if (cmd === 'stop') { data.queue.length = 0; data.player.stop(true); cleanup(data); data.playing = false; return void m.reply('🛑 Fermato.') }
  if (cmd === 'leave') { getVoiceConnection(m.guildId)?.destroy(); cleanup(data); data.playing = false; return void m.reply('👋 Uscito.') }
  if (cmd === 'pause') { data.player.pause(); return void m.reply('⏸️ Pausa.') }
  if (cmd === 'resume') { data.player.unpause(); return void m.reply('▶️ Ripresa.') }
  if (cmd === 'queue') {
    const rest = data.queue.map((q,i)=>`${i+1}. ${q.query}`).join('\n') || '—'
    return void m.reply(`In coda:\n${rest}`)
  }
})

client.login(process.env.DISCORD_TOKEN)
