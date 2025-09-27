\
// robust25.8.1-minigui-status-progress
// - Pannello unico (search/playing/error)
// - Anti-duplicazione pannello
// - Barra progressiva LIVE (aggiornamento periodico)
// - Capitalizzazione prima lettera titolo
import 'dotenv/config'
import sodium from 'libsodium-wrappers'; await sodium.ready

import { 
  Client, GatewayIntentBits,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle
} from 'discord.js'
import {
  joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior,
  AudioPlayerStatus, getVoiceConnection, StreamType
} from '@discordjs/voice'
import { spawn } from 'child_process'

const PREFIX = '!'
const DELETE_COMMANDS = (process.env.DELETE_COMMANDS || 'true').toLowerCase() === 'true'
const PROGRESS_INTERVAL_MS = Number(process.env.PROGRESS_INTERVAL_MS || 5000) // refresh pannello

const queues = new Map()

// Tema + emoji
const THEME = { color: Number(process.env.THEME_COLOR || 0xED4245) }
const EMO = { prev:'⏮️', pause:'⏸️', play:'▶️', stop:'⏹️', skip:'⏭️', search:'🔎', err:'❌' }

const capFirst = (s) => { s = String(s||'').trim(); return s ? s[0].toUpperCase()+s.slice(1) : s }
const fmtDur = (sec) => { if(sec==null) return '—'; sec=Math.max(0, Math.floor(sec)); const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60; return h?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${m}:${String(s).padStart(2,'0')}` }
function progressBar(pos=0, dur=0, width=18){
  if(!dur || dur<=0) return '―'.repeat(width)
  const p = Math.max(0, Math.min(1, pos/dur)); const i = Math.max(0, Math.min(width-1, Math.round(p*(width-1))))
  const left = '─'.repeat(i), right = '─'.repeat(width-1-i)
  return `${left}🔘${right}`
}

function ensureGuild(guildId, channel){
  if(!queues.has(guildId)){
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } })
    const data = { 
      queue: [], player, textChannel: channel, current: null, playing: false,
      nowTitle: null, controlsMsgId: null, uploader: null,
      requesterId: null, requesterTag: null, lastStatus: 'idle', lastError: null,
      resource: null, durationSec: null, progressTimer: null, nextQuery: null
    }
    player.on(AudioPlayerStatus.Idle, () => {
      data.playing = false; clearInterval(data.progressTimer); data.progressTimer = null
      cleanup(data); upsertPanel(channel.guild.id, 'idle')
      if (data.queue.length) playNext(channel.guild.id).catch(()=>{})
    })
    player.on('error', e => {
      console.error('[player]', e); data.playing=false; clearInterval(data.progressTimer); data.progressTimer = null
      cleanup(data); data.lastError = e?.message || 'Errore player'
      upsertPanel(channel.guild.id, 'error', { message: data.lastError })
      if (data.queue.length) playNext(channel.guild.id).catch(()=>{})
    })
    queues.set(guildId, data)
  }
  return queues.get(guildId)
}

function cleanup(data){
  try{ data.current?.feeder?.kill('SIGKILL') }catch{}
  try{ data.current?.proc?.kill('SIGKILL') }catch{}
  data.current = null
  data.resource = null
  data.durationSec = null
}

function isUrl(s){ try{ new URL(s); return true } catch { return false } }

function resolveMeta(input){
  return new Promise((resolve) => {
    const query = isUrl(input) ? input : ('ytsearch1:'+input)
    const args = ['--no-playlist','-f','ba[acodec=opus]/ba/bestaudio','--get-title','--get-uploader','--get-duration']
    const p = spawn('yt-dlp', [...args, query], { stdio: ['ignore','pipe','pipe'] })
    let out = ''; p.stdout.on('data', d => out += d.toString())
    p.on('close', () => {
      const lines = out.trim().split('\n')
      const title = capFirst(lines[0] || input)
      const uploader = lines[1] || 'YouTube'
      const durStr = lines[2] || null
      const durationSec = durStr ? durStr.split(':').reduce((acc,v)=>acc*60+Number(v||0),0) : null
      resolve({ title, uploader, durationSec })
    })
  })
}

function streamingPipeline(urlOrQuery){
  const inputArg = isUrl(urlOrQuery) ? urlOrQuery : ('ytsearch1:'+urlOrQuery)
  const feeder = spawn('yt-dlp', ['-f','ba[acodec=opus]/ba/bestaudio/best','--no-playlist','-o','-','--', inputArg], { stdio: ['ignore','pipe','pipe'] })
  feeder.stderr.on('data', d => console.error('[yt-dlp]', d.toString()))
  const ffmpeg = spawn('ffmpeg', ['-loglevel','error','-hide_banner','-i','pipe:0','-vn','-ac','2','-c:a','libopus','-b:a','128k','-f','ogg','pipe:1'], { stdio: ['pipe','pipe','pipe'] })
  feeder.stdout.pipe(ffmpeg.stdin).on('error',()=>{})
  ffmpeg.stderr.on('data', d => console.error('[ffmpeg]', d.toString()))
  return { feeder, proc: ffmpeg, stream: ffmpeg.stdout }
}

// ---- Pannello unico (stati: idle/search/playing/error) ----
function panelEmbed(data, status='idle', extra={}){
  const e = new EmbedBuilder().setColor(THEME.color)
  if (status==='search'){
    e.setDescription(`**${EMO.search} Sto preparando il brano…**\nRichiesta: \`${data.nextQuery || '—'}\``)
  } else if (status==='playing'){
    const requester = data.requesterId ? `<@${data.requesterId}>` : (data.requesterTag?`[${data.requesterTag}]`:'')
    // progress live
    const pos = data.resource ? Math.floor((data.resource.playbackDuration || 0)/1000) : 0
    const dur = data.durationSec ?? 0
    const bar = progressBar(pos, dur, 20)
    e.setDescription([
      `**Now Playing** \`${data.nowTitle||'—'}\`  by ${requester||'—'}`,
      dur ? `\`${bar}\` \`${fmtDur(pos)} / ${fmtDur(dur)}\`` : ''
    ].filter(Boolean).join('\n'))
  } else if (status==='error'){
    const msg = extra.message || data.lastError || 'Si è verificato un errore.'
    e.setDescription(`${EMO.err} **Errore**: ${'`'+msg+'`'}`)
  } else {
    e.setDescription('**Now Playing** — nessuna traccia\nUsa `!play <link|titolo>`')
  }
  return e
}
function panelButtons(status='idle'){
  const playing = status==='playing'
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ctrl_prev').setEmoji(EMO.prev).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(playing?'ctrl_pause':'ctrl_resume').setEmoji(playing?EMO.pause:EMO.play).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ctrl_skip').setEmoji(EMO.skip).setStyle(ButtonStyle.Secondary).setDisabled(!playing),
    new ButtonBuilder().setCustomId('ctrl_stop').setEmoji(EMO.stop).setStyle(ButtonStyle.Danger).setDisabled(!playing)
  )
  return [row]
}
async function upsertPanel(guildId, status='idle', extra={}){
  const data = queues.get(guildId); if (!data || !data.textChannel) return
  data.lastStatus = status
  const embed = panelEmbed(data, status, extra); const comps = panelButtons(status)
  try{
    // 1) aggiorna pannello già noto
    if (data.controlsMsgId){
      const m = await data.textChannel.messages.fetch(data.controlsMsgId).catch(()=>null)
      if (m) { await m.edit({ embeds:[embed], components: comps }); return }
    }
    // 2) riusa un messaggio precedente del bot (anti-duplicato)
    const recent = await data.textChannel.messages.fetch({ limit: 30 }).catch(()=>null)
    if (recent) {
      const mine = recent.find(msg => msg.author?.id === msg.client?.user?.id)
      if (mine) { data.controlsMsgId = mine.id; await mine.edit({ embeds:[embed], components: comps }); return }
    }
    // 3) crea pannello nuovo
    const sent = await data.textChannel.send({ embeds:[embed], components: comps })
    data.controlsMsgId = sent.id
  }catch(e){ console.error('[panel]', e) }
}

// ---------- Core playback ----------
async function playNext(guildId){
  const data = queues.get(guildId); if (!data) return
  if (data.playing) return
  const next = data.queue.shift(); if (!next){ upsertPanel(guildId,'idle'); return }
  data.playing = true
  data.nextQuery = next.query
  await upsertPanel(guildId, 'search')

  try {
    const meta = await resolveMeta(next.query)
    data.nowTitle = meta.title
    data.uploader = meta.uploader
    data.durationSec = meta.durationSec
    data.requesterId = next.requesterId || null
    data.requesterTag = next.requesterTag || null

    const { feeder, proc, stream } = streamingPipeline(next.query)
    data.current = { feeder, proc }

    const conn = getVoiceConnection(guildId) || null; if (conn) conn.subscribe(data.player)
    const resource = createAudioResource(stream, { inputType: StreamType.OggOpus })
    data.resource = resource

    data.player.once(AudioPlayerStatus.Playing, async () => {
      await upsertPanel(guildId,'playing')
      // avvia refresh progress
      clearInterval(data.progressTimer)
      data.progressTimer = setInterval(() => {
        if (data.player.state.status === AudioPlayerStatus.Playing) upsertPanel(guildId,'playing')
      }, PROGRESS_INTERVAL_MS)
    })
    data.player.play(resource)

    // fail-safe: se non passa a Playing rapidamente, rimani in "search"
    setTimeout(()=> {
      if (data.player.state.status !== AudioPlayerStatus.Playing) upsertPanel(guildId,'search')
    }, 1200)

  } catch (e) {
    console.error('[playNext]', e)
    data.lastError = e?.message || 'Ricerca/stream falliti'
    await upsertPanel(guildId, 'error', { message: data.lastError })
    data.playing = false
    if (data.queue.length) playNext(guildId).catch(()=>{})
  }
}

const client = new Client({ intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent
]})

client.once('clientReady', () => {
  console.log(`🤖 Online come ${client.user.tag}`)
  // badge istanza per diagnosticare doppie istanze
  client.user.setPresence({ activities: [{ name: `instance ${process.pid}`, type: 0 }], status: 'online' })
})

client.on('interactionCreate', async (i) => {
  try{
    if (!i.isButton()) return
    const data = queues.get(i.guildId)
    if (!data) return void i.reply({ content:'Nessuna sessione attiva.', ephemeral: true })

    if (i.customId==='ctrl_pause'){ data.player.pause(); await i.deferUpdate(); clearInterval(data.progressTimer); data.progressTimer=null; return upsertPanel(i.guildId, 'idle') }
    if (i.customId==='ctrl_resume'){ data.player.unpause(); await i.deferUpdate(); return upsertPanel(i.guildId, 'playing') }
    if (i.customId==='ctrl_skip'){ data.player.stop(true); cleanup(data); await i.deferUpdate(); clearInterval(data.progressTimer); data.progressTimer=null; if (data.queue.length) playNext(i.guildId).catch(()=>{}); return upsertPanel(i.guildId, 'idle') }
    if (i.customId==='ctrl_stop'){ data.queue.length=0; data.player.stop(true); cleanup(data); data.playing=false; await i.deferUpdate(); clearInterval(data.progressTimer); data.progressTimer=null; return upsertPanel(i.guildId, 'idle') }
  }catch(e){
    console.error('[interaction]', e)
    if (i.isRepliable() && !i.replied && !i.deferred) await i.reply({ content:'Errore interazione.', ephemeral:true })
  }
})

client.on('messageCreate', async (m) => {
  if (m.author.bot) return
  if (!m.content.startsWith(PREFIX)) return

  const args = m.content.slice(PREFIX.length).trim().split(/\s+/)
  const cmd = (args.shift()||'').toLowerCase()
  const data = ensureGuild(m.guildId, m.channel)
  const deleteLater = async () => { if (DELETE_COMMANDS) { try { await m.delete() } catch {} } }

  if (cmd === 'play'){
    const q = args.join(' ')
    if (!q) { await m.reply('Uso: `!play <link o titolo>`'); return deleteLater() }
    const vc = m.member.voice?.channel
    if (!vc) { await m.reply('Devi essere in un canale vocale 🎙️'); return deleteLater() }

    const conn = getVoiceConnection(m.guildId) || joinVoiceChannel({ channelId: vc.id, guildId: vc.guild.id, adapterCreator: vc.guild.voiceAdapterCreator, selfDeaf: true })
    conn.subscribe(data.player)

    data.queue.push({ query: q, requesterId: m.author.id, requesterTag: m.author.tag })
    if (data.player.state.status === AudioPlayerStatus.Idle && !data.playing) playNext(m.guildId).catch(()=>{})
    await upsertPanel(m.guildId, 'search', {})
    return deleteLater()
  }

  if (cmd === 'skip'){ data.player.stop(true); cleanup(data); clearInterval(data.progressTimer); data.progressTimer=null; await upsertPanel(m.guildId,'idle'); return deleteLater() }
  if (cmd === 'stop'){ data.queue.length=0; data.player.stop(true); cleanup(data); data.playing=false; clearInterval(data.progressTimer); data.progressTimer=null; await upsertPanel(m.guildId,'idle'); return deleteLater() }
  if (cmd === 'leave'){ getVoiceConnection(m.guildId)?.destroy(); cleanup(data); data.playing=false; clearInterval(data.progressTimer); data.progressTimer=null; await upsertPanel(m.guildId,'idle'); return deleteLater() }
  if (cmd === 'pause'){ data.player.pause(); clearInterval(data.progressTimer); data.progressTimer=null; await upsertPanel(m.guildId,'idle'); return deleteLater() }
  if (cmd === 'resume'){ data.player.unpause(); await upsertPanel(m.guildId,'playing'); return deleteLater() }
  if (cmd === 'queue'){ const rest = data.queue.map((q,i)=>`${i+1}. ${q.query}`).join('\\n') || '—'; await m.reply({ content:`In coda:\\n${rest}`, allowedMentions:{parse:[]} }); return deleteLater() }
})

client.login(process.env.DISCORD_TOKEN)
