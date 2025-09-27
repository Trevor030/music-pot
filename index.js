\
// robust24.1: instant placeholder + parallel join + fast search + cache + stable queue/skip cleanup
import 'dotenv/config'
import sodium from 'libsodium-wrappers'; await sodium.ready

import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js'
import {
  joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior,
  AudioPlayerStatus, getVoiceConnection, StreamType
} from '@discordjs/voice'
import { spawn } from 'child_process'
import https from 'https'

const PREFIX = '!'
const queues = new Map()
const searchCache = new Map() // query -> {title,url}

// ---------- Helpers ----------
function isUrl(str){ try { new URL(str); return true } catch { return false } }

function killChildSafe(child){
  if(!child) return
  try { child.stdin?.destroy() } catch {}
  try { child.stdout?.destroy() } catch {}
  try { child.stderr?.destroy() } catch {}
  try { child.kill?.('SIGKILL') } catch {}
}

function ensureGuild(guildId, channel){
  if(!queues.has(guildId)){
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } })
    const data = { queue: [], player, textChannel: channel, currentProc: null, playing: false }
    // Auto-next & cleanup
    player.on(AudioPlayerStatus.Idle, () => {
      data.playing = false
      if (data.currentProc){
        killChildSafe(data.currentProc.main)
        killChildSafe(data.currentProc.feeder)
        data.currentProc = null
      }
      if (data.queue.length > 0) playNext(guildId).catch(e => console.error('playNext err:', e))
    })
    player.on('error', (e) => {
      console.error('Audio player error:', e)
      data.playing = false
      if (data.currentProc){
        killChildSafe(data.currentProc.main)
        killChildSafe(data.currentProc.feeder)
        data.currentProc = null
      }
      if (data.queue.length > 0) playNext(guildId).catch(()=>{})
    })
    queues.set(guildId, data)
  }
  return queues.get(guildId)
}

// ---------- Search: ytsearch1 for speed + cache ----------
async function resolveYouTube(query){
  if (isUrl(query)){
    return await resolveWithYtDlp(query, false)
  }
  const key = query.toLowerCase()
  if (searchCache.has(key)) return searchCache.get(key)
  const res = await resolveWithYtDlp(query, true)
  searchCache.set(key, res)
  return res
}

function resolveWithYtDlp(input, useSearch){
  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist', '--no-progress', '--force-ipv4',
      '-f', 'bestaudio[acodec=opus]/bestaudio',
      '--get-title', '--get-url'
    ]
    if (useSearch){
      args.unshift('ytsearch1:'+input)     // fastest: only first result
    } else {
      args.push(input)
    }
    const proc = spawn('yt-dlp', args, { stdio: ['ignore','pipe','pipe'] })
    let out = ''
    proc.stdout.on('data', d => { out += d.toString() })
    proc.stderr.on('data', d => console.error('[yt-dlp resolve]', d.toString()))
    proc.on('close', code => {
      if (code !== 0) return reject(new Error('yt-dlp resolve failed'))
      const lines = out.trim().split('\n')
      if (lines.length < 2) return reject(new Error('Nessun risultato valido.'))
      const title = lines[0]; const url = lines[1]
      resolve({ title, url })
    })
  })
}

// ---------- Playback pipelines ----------

// Fast direct HTTP stream (WebM/Opus expected)
function httpOpusStream(mediaUrl){
  const agent = new https.Agent({ keepAlive: true, maxSockets: 6 })
  return new Promise((resolve, reject) => {
    const req = https.get(mediaUrl, { agent, headers: {
      'User-Agent': 'Mozilla/5.0 (DiscordMusicBot)',
      'Accept': '*/*', 'Connection': 'keep-alive'
    }}, (res) => {
      if (res.statusCode !== 200) return reject(new Error('HTTP '+res.statusCode))
      resolve(res)
    })
    req.on('error', reject)
  })
}

// Fallback: yt-dlp -> ffmpeg (ogg/opus)
function transcodePipeline(urlOrQuery){
  const feeder = spawn('yt-dlp', ['-f','bestaudio','--no-playlist','-o','-', urlOrQuery], { stdio: ['ignore','pipe','pipe'] })
  feeder.stderr.on('data', d => console.error('[yt-dlp]', d.toString()))
  feeder.stdout.on('error', () => {})

  const ffmpeg = spawn('ffmpeg', [
    '-reconnect','1','-reconnect_streamed','1','-reconnect_on_network_error','1',
    '-loglevel','error','-hide_banner',
    '-i','pipe:0','-vn','-ac','2',
    '-c:a','libopus','-b:a','128k','-f','ogg','pipe:1'
  ], { stdio: ['pipe','pipe','pipe'] })

  feeder.stdout.pipe(ffmpeg.stdin).on('error', () => {})
  ffmpeg.stdin.on('error', () => {})
  ffmpeg.stdout.on('error', () => {})
  ffmpeg.stderr.on('data', d => console.error('[ffmpeg]', d.toString()))
  return { proc: ffmpeg, feeder, stream: ffmpeg.stdout }
}

// ---------- Core playback with placeholder/edit ----------
async function playNext(guildId){
  const data = queues.get(guildId); if (!data) return
  if (data.playing) return
  const next = data.queue.shift()
  if (!next){ data.textChannel?.send('📭 Coda finita.'); return }
  data.playing = true

  // placeholder message (create or fetch)
  let msg = null
  if (next.placeholderId){
    try { msg = await data.textChannel.messages.fetch(next.placeholderId) } catch { msg = null }
  }
  if (!msg) msg = await data.textChannel.send(`⏳ Preparo: **${next.query}**`)

  // Show “searching” if resolution takes > 1s
  const slowTimer = setTimeout(() => {
    if (msg && !msg.embeds?.length) msg.edit(`🔎 Sto cercando la versione più veloce di **${next.query}**...`)
  }, 1000)

  try {
    const { url, title } = await resolveYouTube(next.query)

    let started = false
    // Fast path: direct HTTP Opus/WebM
    try {
      const httpStream = await httpOpusStream(url)
      data.currentProc = { main: { kill(){ try{httpStream.destroy()}catch{} } } }
      const resource = createAudioResource(httpStream, { inputType: StreamType.WebmOpus })
      data.player.once(AudioPlayerStatus.Playing, async () => {
        started = true
        clearTimeout(slowTimer)
        await msg.edit({ content: null, embeds: [
          new EmbedBuilder().setTitle('▶️ In riproduzione').setDescription(`[${title}](${url})`).setFooter({ text: `Richiesto da ${next.requestedBy}` })
        ]})
      })
      data.player.play(resource)
    } catch (e) {
      // Direct failed immediately -> fallback now
      const { proc, feeder, stream } = transcodePipeline(url)
      data.currentProc = { main: proc, feeder }
      const resource = createAudioResource(stream, { inputType: StreamType.OggOpus })
      data.player.once(AudioPlayerStatus.Playing, async () => {
        started = true
        clearTimeout(slowTimer)
        await msg.edit({ content: null, embeds: [
          new EmbedBuilder().setTitle('▶️ In riproduzione').setDescription(`[${title}](${url})`).setFooter({ text: `Richiesto da ${next.requestedBy}` })
        ]})
      })
      data.player.play(resource)
    }

    // Safety fallback if still not started after 1.2s (e.g. HTTP stalled)
    setTimeout(() => {
      if (!started){
        const { proc, feeder, stream } = transcodePipeline(url)
        data.currentProc = { main: proc, feeder }
        const resource = createAudioResource(stream, { inputType: StreamType.OggOpus })
        data.player.play(resource)
      }
    }, 1200)

  } catch (err) {
    clearTimeout(slowTimer)
    console.error('playNext error:', err)
    await msg.edit(`⚠️ Errore: ${err.message}`)
    data.playing = false
    if (data.queue.length > 0) playNext(guildId).catch(()=>{})
  }
}

// ---------- Discord client & commands ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
})

client.once('clientReady', () => console.log(`🤖 Online come ${client.user.tag}`))

client.on('messageCreate', async (message) => {
  if (message.author.bot) return
  if (!message.content.startsWith(PREFIX)) return

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/)
  const command = (args.shift() || '').toLowerCase()
  const guildId = message.guildId
  const data = ensureGuild(guildId, message.channel)

  if (command === 'play'){
    const query = args.join(' ')
    if (!query) return void message.reply('Uso: `!play <link YouTube o titolo>`')
    const vc = message.member.voice?.channel
    if (!vc) return void message.reply('Devi essere in un canale vocale 🎙️')

    // show typing + placeholder immediately
    message.channel.sendTyping()
    const placeholder = await message.reply(`⏳ Preparo: **${query}**`)

    // join in parallel
    const joinP = (async () => {
      const existing = getVoiceConnection(guildId)
      if (existing) return existing
      return joinVoiceChannel({ channelId: vc.id, guildId: vc.guild.id, adapterCreator: vc.guild.voiceAdapterCreator, selfDeaf: true })
    })()

    // enqueue and kick playback if idle
    data.queue.push({ query, requestedBy: message.author.tag, placeholderId: placeholder.id })
    if (data.player.state.status === AudioPlayerStatus.Idle && !data.playing) playNext(guildId).catch(()=>{})
    return
  }

  if (command === 'pause'){ data.player.pause(); return void message.reply('⏸️ Pausa.') }
  if (command === 'resume'){ data.player.unpause(); return void message.reply('▶️ Ripresa.') }

  if (command === 'skip'){
    data.player.stop(true)
    if (data.currentProc){ killChildSafe(data.currentProc.main); killChildSafe(data.currentProc.feeder); data.currentProc = null }
    return void message.reply('⏭️ Skip.')
  }

  if (command === 'stop'){
    data.queue.length = 0
    data.player.stop(true)
    if (data.currentProc){ killChildSafe(data.currentProc.main); killChildSafe(data.currentProc.feeder); data.currentProc = null }
    data.playing = false
    return void message.reply('🛑 Fermato e coda svuotata.')
  }

  if (command === 'leave'){
    getVoiceConnection(guildId)?.destroy()
    if (data.currentProc){ killChildSafe(data.currentProc.main); killChildSafe(data.currentProc.feeder); data.currentProc = null }
    data.playing = false
    return void message.reply('👋 Uscito dal canale.')
  }

  if (command === 'queue'){
    const rest = data.queue.map((q,i)=>`${i+1}. ${q.query}`).join('\n') || '—'
    if (data.playing){
      return void message.reply(`**🎧 in riproduzione**\nIn coda:\n${rest}`)
    } else {
      return void message.reply(`In coda:\n${rest}`)
    }
  }
})

client.login(process.env.DISCORD_TOKEN)
