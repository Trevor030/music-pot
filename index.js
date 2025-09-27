// 26.1 clean-chat — single panel & single queue, auto-delete noise, WebM/Opus direct (no ffmpeg)
import 'dotenv/config'
import {
  Client, GatewayIntentBits,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle
} from 'discord.js'
import {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, StreamType, getVoiceConnection
} from '@discordjs/voice'
import { spawn } from 'child_process'

const PREFIX = '!'
const PROGRESS_INTERVAL_MS = Number(process.env.PROGRESS_INTERVAL_MS || 3000)

const queues = new Map() // guildId -> session

const capFirst = (s) => { s = String(s||'').trim(); return s ? s[0].toUpperCase()+s.slice(1) : s }
const fmtDur = (sec)=>{ if(sec==null)return '—'; sec=Math.max(0,Math.floor(sec)); const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60; return h?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${m}:${String(s).padStart(2,'0')}` }
const progressBar = (pos=0,dur=0,w=20)=>{
  if(!dur||dur<=0) return '🔘' + '─'.repeat(w-1)
  const p = Math.max(0, Math.min(1, pos/dur)); const i = Math.max(0, Math.min(w-1, Math.round(p*(w-1))))
  return `${'─'.repeat(i)}🔘${'─'.repeat(w-1-i)}`
}
const isUrl = (s)=>{ try{ new URL(s); return true }catch{ return false } }

function ensureSession(guildId, channel){
  if(!queues.has(guildId)){
    const player = createAudioPlayer()
    const data = {
      queue: [], player, textChannel: channel,
      current: null, playing: false,
      nowTitle: null, uploader: null,
      controlsMsgId: null, // unico pannello
      queueMsgId: null,    // unico messaggio coda
      lastStatus: 'idle', lastError: null,
      resource: null, durationSec: null,
      progressTimer: null, nextQuery: null,
      requesterId: null, requesterTag: null
    }
    player.on(AudioPlayerStatus.Idle, ()=>{
      data.playing = false
      clearInterval(data.progressTimer); data.progressTimer = null
      data.resource = null; data.durationSec = null; data.nowTitle = null
      if (data.queue.length) playNext(guildId).catch(()=>{})
      else upsertPanel(guildId, 'idle')
    })
    player.on('error', (e)=>{
      console.error('[player]', e)
      data.playing=false
      clearInterval(data.progressTimer); data.progressTimer = null
      data.lastError = e?.message || 'Errore player'
      upsertPanel(guildId, 'error', { message: data.lastError })
      if (data.queue.length) playNext(guildId).catch(()=>{})
    })
    queues.set(guildId, data)
  }
  return queues.get(guildId)
}

// --- yt-dlp helpers ---
function resolveMeta(input){
  return new Promise((resolve) => {
    const query = isUrl(input) ? input : ('ytsearch1:'+input)
    const p = spawn('yt-dlp', ['-J','--no-playlist','--', query], { stdio: ['ignore','pipe','pipe'] })
    let out=''; p.stdout.on('data', d => out += d.toString())
    p.on('close', ()=>{
      try{
        const j = JSON.parse(out||'{}')
        const info = Array.isArray(j.entries) ? j.entries?.[0] : j
        const title = capFirst(info?.title || input)
        const uploader = info?.uploader || info?.channel || 'YouTube'
        const durationSec = Number(info?.duration) || null
        resolve({ title, uploader, durationSec, url: input })
      }catch{
        resolve({ title: capFirst(input), uploader:'YouTube', durationSec:null, url: input })
      }
    })
  })
}

function streamWebmOpus(input){
  const query = isUrl(input) ? input : ('ytsearch1:'+input)
  const proc = spawn('yt-dlp', ['-f','251/bestaudio','--no-playlist','-o','-','--', query], { stdio:['ignore','pipe','pipe'] })
  proc.stderr.on('data', d => console.error('[yt-dlp]', d.toString().trim()))
  return { proc, stream: proc.stdout }
}

// --- UI ---
function panelEmbed(data, status='idle', extra={}){
  const THEME = 0x5865F2
  const e = new EmbedBuilder().setColor(THEME)
  if (status==='idle'){
    e.setTitle('Now Playing — nessuna traccia')
    e.setDescription('Usa `!play <link|titolo>`')
  } else if (status==='search'){
    e.setTitle('🔎 Sto preparando il brano…')
    e.setDescription(`Richiesta: \`${data.nextQuery || data.queue[0]?.query || '—'}\``)
  } else if (status==='playing'){
    const pos = data.resource ? Math.floor((data.resource.playbackDuration||0)/1000) : 0
    const dur = data.durationSec ?? 0
    const bar = progressBar(pos, dur, 20)
    const rem = dur ? Math.max(0, dur-pos) : null
    e.setTitle('In riproduzione 🎶')
    e.setDescription([
      `**${data.nowTitle||'—'}**  ${data.requesterTag?`_by ${data.requesterTag}_`:''}`.trim(),
      `\`${bar}\``,
      rem!=null ? `⏱️ **${fmtDur(pos)}** trascorsi • **-${fmtDur(rem)}** rimanenti  *(totale ${fmtDur(dur)})*`
                : `⏱️ **${fmtDur(pos)}** trascorsi • durata sconosciuta`
    ].join('\n'))
  } else if (status==='error'){
    e.setTitle('❌ Errore')
    e.setDescription('`'+(extra.message||'Problema di riproduzione')+'`')
  }
  return e
}
function panelButtons(status='idle'){
  const playing = status==='playing'
  return [ new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ctrl_pause').setEmoji('⏸️').setStyle(ButtonStyle.Secondary).setDisabled(!playing),
    new ButtonBuilder().setCustomId('ctrl_resume').setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(playing),
    new ButtonBuilder().setCustomId('ctrl_skip').setEmoji('⏭️').setStyle(ButtonStyle.Primary).setDisabled(!playing),
    new ButtonBuilder().setCustomId('ctrl_stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('ctrl_queue').setEmoji('🧭').setStyle(ButtonStyle.Secondary)
  ) ]
}

async function upsertPanel(guildId, status='idle', extra={}){
  const data = queues.get(guildId); if (!data || !data.textChannel) return
  data.lastStatus = status
  const embed = panelEmbed(data, status, extra); const comps = panelButtons(status)
  try{
    if (data.controlsMsgId){
      const m = await data.textChannel.messages.fetch(data.controlsMsgId).catch(()=>null)
      if (m){ await m.edit({ embeds:[embed], components: comps }); return }
      data.controlsMsgId = null
    }
    const recent = await data.textChannel.messages.fetch({ limit: 30 }).catch(()=>null)
    if (recent){
      const mine = recent.find(msg => msg.author?.id === msg.client?.user?.id)
      if (mine){ data.controlsMsgId = mine.id; await mine.edit({ embeds:[embed], components: comps });
        for (const m of recent.values()){
          if (m.id !== mine.id && m.author?.id === mine.author?.id) await m.delete().catch(()=>{})
        }
        return
      }
    }
    const sent = await data.textChannel.send({ embeds:[embed], components: comps })
    data.controlsMsgId = sent.id
    if (recent){
      for (const m of recent.values()){
        if (m.id !== sent.id && m.author?.id === sent.author?.id) await m.delete().catch(()=>{})
      }
    }
  }catch(e){ console.error('[panel]', e) }
}

async function upsertQueueMessage(guildId){
  const data = queues.get(guildId); if (!data || !data.textChannel) return
  const list = data.queue.slice(0, 15).map((q,i)=> `${i+1}. ${q.query}`).join('\n') || '—'
  const content = `Prossimi brani:\n${list}`
  try{
    if (data.queueMsgId){
      const m = await data.textChannel.messages.fetch(data.queueMsgId).catch(()=>null)
      if (m){ await m.edit({ content, allowedMentions:{parse:[]} }); return }
      data.queueMsgId = null
    }
    const sent = await data.textChannel.send({ content, allowedMentions:{parse:[]} })
    data.queueMsgId = sent.id
    const recent = await data.textChannel.messages.fetch({ limit: 30 }).catch(()=>null)
    if (recent){
      for (const m of recent.values()){
        if (m.id !== sent.id && m.author?.id === sent.author?.id && m.content?.startsWith('Prossimi brani:')) await m.delete().catch(()=>{})
      }
    }
  }catch(e){ console.error('[queueMsg]', e) }
}

// --- Core playback ---
async function playNext(guildId){
  const data = queues.get(guildId); if (!data) return
  const next = data.queue.shift()
  if (!next){ await upsertPanel(guildId,'idle'); await upsertQueueMessage(guildId); return }
  data.nextQuery = next.query
  data.requesterId = next.requesterId; data.requesterTag = next.requesterTag

  await upsertPanel(guildId,'search')

  try{
    const meta = await resolveMeta(next.query)
    data.nowTitle = meta.title
    data.uploader = meta.uploader
    data.durationSec = meta.durationSec

    const { proc, stream } = streamWebmOpus(next.query)
    data.current = { proc }

    const conn = getVoiceConnection(guildId) || joinVoiceChannel({
      channelId: next.channelId,
      guildId,
      adapterCreator: next.adapterCreator,
      selfDeaf: true
    })
    conn.subscribe(data.player)

    const resource = createAudioResource(stream, { inputType: StreamType.WebmOpus })
    data.resource = resource

    data.player.once(AudioPlayerStatus.Playing, async ()=>{
      await upsertPanel(guildId,'playing')
      clearInterval(data.progressTimer)
      data.progressTimer = setInterval(()=>{
        if (data.player.state.status === AudioPlayerStatus.Playing) upsertPanel(guildId,'playing')
      }, PROGRESS_INTERVAL_MS)
    })
    data.player.play(resource)
  }catch(e){
    console.error('[playNext]', e)
    data.lastError = e?.message || 'Ricerca/stream falliti'
    await upsertPanel(guildId, 'error', { message: data.lastError })
    if (data.queue.length) playNext(guildId).catch(()=>{})
  } finally {
    await upsertQueueMessage(guildId)
  }
}

// --- Client ---
const client = new Client({ intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent
]})

client.once('ready', ()=>{
  console.log(`🤖 Online come ${client.user.tag}`)
  client.user.setPresence({ activities:[{ name:`instance ${process.pid}`, type:0 }], status:'online' })
})

client.on('interactionCreate', async (i)=>{
  if (!i.isButton()) return
  const data = queues.get(i.guildId); if(!data) return void i.deferUpdate()
  try{
    if (i.customId==='ctrl_pause'){ data.player.pause(true); clearInterval(data.progressTimer); data.progressTimer=null; await upsertPanel(i.guildId,'idle'); await i.deferUpdate(); return }
    if (i.customId==='ctrl_resume'){ data.player.unpause(); await upsertPanel(i.guildId,'playing'); await i.deferUpdate(); return }
    if (i.customId==='ctrl_skip'){ data.player.stop(true); try{ data.current?.proc?.kill('SIGKILL') }catch{}; clearInterval(data.progressTimer); data.progressTimer=null; if (data.queue.length) playNext(i.guildId).catch(()=>{}); await upsertPanel(i.guildId,'idle'); await upsertQueueMessage(i.guildId); await i.deferUpdate(); return }
    if (i.customId==='ctrl_stop'){ data.queue.length=0; data.player.stop(true); try{ data.current?.proc?.kill('SIGKILL') }catch{}; clearInterval(data.progressTimer); data.progressTimer=null; await upsertPanel(i.guildId,'idle'); await upsertQueueMessage(i.guildId); await i.deferUpdate(); return }
    if (i.customId==='ctrl_queue'){ await upsertQueueMessage(i.guildId); await i.deferUpdate(); return }
  }catch(e){
    console.error('[interaction]', e)
    if (!i.deferred && !i.replied) await i.deferUpdate()
  }
})

client.on('messageCreate', async (m)=>{
  if (!m.guild || m.author.bot) return

  // Modalità CLEAN: cancella tutto ciò che non è comando
  if (!m.content.startsWith(PREFIX)){
    try { await m.delete() } catch {}
    return
  }

  const parts = m.content.slice(PREFIX.length).trim().split(/\s+/)
  const cmd = (parts.shift()||'').toLowerCase()
  const args = parts.join(' ')
  const data = ensureSession(m.guildId, m.channel)

  const zap = async ()=>{ try{ await m.delete() }catch{} }

  if (cmd==='play'){
    const q = args.trim()
    const vc = m.member.voice?.channel
    if (!q || !vc) return zap()

    const conn = getVoiceConnection(m.guildId) || joinVoiceChannel({
      channelId: vc.id,
      guildId: vc.guild.id,
      adapterCreator: vc.guild.voiceAdapterCreator,
      selfDeaf: true
    })
    conn.subscribe(data.player)

    data.queue.push({ query: q, requesterId: m.author.id, requesterTag: m.author.tag, channelId: vc.id, adapterCreator: m.guild.voiceAdapterCreator })
    if (data.player.state.status === AudioPlayerStatus.Idle && !data.playing) playNext(m.guildId).catch(()=>{})
    await upsertPanel(m.guildId,'search')
    await upsertQueueMessage(m.guildId)
    return zap()
  }

  if (cmd==='skip'){ data.player.stop(true); try{ data.current?.proc?.kill('SIGKILL') }catch{}; clearInterval(data.progressTimer); data.progressTimer=null; await upsertPanel(m.guildId,'idle'); await upsertQueueMessage(m.guildId); return zap() }
  if (cmd==='stop'){ data.queue.length=0; data.player.stop(true); try{ data.current?.proc?.kill('SIGKILL') }catch{}; clearInterval(data.progressTimer); data.progressTimer=null; await upsertPanel(m.guildId,'idle'); await upsertQueueMessage(m.guildId); return zap() }
  if (cmd==='pause'){ data.player.pause(true); clearInterval(data.progressTimer); data.progressTimer=null; await upsertPanel(m.guildId,'idle'); return zap() }
  if (cmd==='resume'){ data.player.unpause(); await upsertPanel(m.guildId,'playing'); return zap() }
  if (cmd==='queue'){ await upsertQueueMessage(m.guildId); return zap() }

  // Comando non valido → elimina senza rispondere
  return zap()
})

client.login(process.env.DISCORD_TOKEN)
