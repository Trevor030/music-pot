// 26.1-fix3.2 — keep queue message while pruning, single panel mutex, fast skip feedback
import 'dotenv/config'
import {
  Client, GatewayIntentBits,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags
} from 'discord.js'
import {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, StreamType, getVoiceConnection
} from '@discordjs/voice'
import { spawn } from 'child_process'

const PREFIX = '!'
const PROGRESS_INTERVAL_MS = Number(process.env.PROGRESS_INTERVAL_MS || 3000)
const ALLOWED_TEXT_CHANNEL_ID = '1421488309456208117'

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
      requesterId: null, requesterTag: null,
      advancing: false,
      panelUpdating: false  // mutex pannello
    }
    player.on(AudioPlayerStatus.Idle, ()=>{
      const d = queues.get(guildId); if(!d) return
      stopTimers(d)
      if (!d.advancing) playNext(guildId).catch(()=>{})
    })
    player.on('error', (e)=>{
      console.error('[player]', e)
      const d = queues.get(guildId); if(!d) return
      stopTimers(d); killCurrent(d)
      d.lastError = e?.message || 'Errore player'
      upsertPanel(guildId, 'error', { message: d.lastError })
      if (!d.advancing && d.queue.length) playNext(guildId).catch(()=>{})
    })
    queues.set(guildId, data)
  }
  const d = queues.get(guildId)
  if (channel && channel.id === ALLOWED_TEXT_CHANNEL_ID) d.textChannel = channel // tieni canale coerente
  return d
}

// --- helpers ---
function wait(ms){ return new Promise(r=>setTimeout(r,ms)) }
function stopTimers(data){ try { clearInterval(data.progressTimer) } catch {} ; data.progressTimer=null }
function killCurrent(data){
  try{ data.player.stop(true) }catch{}
  try{ data.resource?.playStream?.destroy?.() }catch{}
  try{ data.resource?.audioPlayer?.stop?.() }catch{}
  try{ data.current?.proc?.kill?.('SIGKILL') }catch{}
  data.current=null; data.resource=null
}
async function safeStopAll(guildId){ const d=queues.get(guildId); if(!d) return; stopTimers(d); killCurrent(d); d.playing=false }

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

// --- panel lock & prune ---
async function withPanelLock(data, fn) {
  while (data.panelUpdating) await wait(35)
  data.panelUpdating = true
  try { return await fn() } finally { data.panelUpdating = false }
}
async function pruneOldPanels(data, keepIds = []) {
  const keep = new Set(keepIds.filter(Boolean))
  if (data.queueMsgId) keep.add(data.queueMsgId) // preserva SEMPRE la coda
  try {
    const recent = await data.textChannel.messages.fetch({ limit: 50 })
    const mine = [...recent.values()].filter(m => m.author?.id === m.client?.user?.id)
    for (const m of mine) {
      if (!keep.has(m.id)) await m.delete().catch(()=>{})
    }
  } catch {}
}

// --- UI ---
function panelEmbed(data, status='idle', extra={}){
  const THEME = 0x5865F2
  const e = new EmbedBuilder().setColor(THEME)
  if (status==='idle'){
    e.setTitle('Now Playing — nessuna traccia')
    e.setDescription('Usa `!play <link|titolo>` nel canale consentito.')
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
  return [ new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ctrl_skip').setEmoji('⏭️').setStyle(ButtonStyle.Primary).setDisabled(status!=='playing'),
    new ButtonBuilder().setCustomId('ctrl_stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('ctrl_disconnect').setEmoji('🔌').setStyle(ButtonStyle.Secondary)
  ) ]
}

async function upsertPanel(guildId, status='idle', extra={}){
  const data = queues.get(guildId); if (!data || !data.textChannel) return
  return withPanelLock(data, async () => {
    data.lastStatus = status
    const embed = panelEmbed(data, status, extra); const comps = panelButtons(status)

    if (data.controlsMsgId) {
      const m = await data.textChannel.messages.fetch(data.controlsMsgId).catch(()=>null)
      if (m) { await m.edit({ embeds:[embed], components: comps }); await pruneOldPanels(data, [m.id]); return }
      data.controlsMsgId = null
    }
    try {
      const recent = await data.textChannel.messages.fetch({ limit: 50 })
      const mine = [...recent.values()].find(msg => msg.author?.id === msg.client?.user?.id)
      if (mine) { data.controlsMsgId = mine.id; await mine.edit({ embeds:[embed], components: comps }); await pruneOldPanels(data, [mine.id]); return }
    } catch {}
    const sent = await data.textChannel.send({ embeds:[embed], components: comps })
    data.controlsMsgId = sent.id
    await pruneOldPanels(data, [sent.id])
  })
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
  if (data.advancing) return
  data.advancing = true

  try {
    stopTimers(data); killCurrent(data)

    const next = data.queue.shift()
    if (!next) {
      data.playing = false
      await upsertPanel(guildId, 'idle')
      await upsertQueueMessage(guildId)
      return
    }

    data.nextQuery = next.query
    data.requesterId = next.requesterId; data.requesterTag = next.requesterTag

    await upsertPanel(guildId,'search')

    let meta = { title: next.query, uploader: 'YouTube', durationSec: null }
    try { meta = await resolveMeta(next.query) } catch {}
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
    data.playing = true

    data.player.once(AudioPlayerStatus.Playing, async ()=>{
      await upsertPanel(guildId,'playing')
      stopTimers(data)
      data.progressTimer = setInterval(()=>{
        if (data.player.state.status === AudioPlayerStatus.Playing) upsertPanel(guildId,'playing')
      }, PROGRESS_INTERVAL_MS)
    })
    data.player.play(resource)
  } catch (e) {
    console.error('[playNext]', e)
    data.lastError = e?.message || 'Ricerca/stream falliti'
    await upsertPanel(guildId, 'error', { message: data.lastError })
    if (data.queue.length) { try { await playNext(guildId) } catch {} }
    else { data.playing = false }
  } finally {
    await upsertQueueMessage(guildId)
    data.advancing = false
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
  if (i.channelId !== ALLOWED_TEXT_CHANNEL_ID) return void i.deferUpdate()

  try {
    if (i.customId==='ctrl_skip'){
      const d = queues.get(i.guildId)
      const nextItem = d?.queue?.[0]

      if (nextItem) {
        await i.reply({ content: `⏭️ Skippato. Prossimo: **${nextItem.query}** — sto per riprodurlo…`, flags: MessageFlags.Ephemeral })
        d.nextQuery = nextItem.query
        await upsertPanel(i.guildId,'search')
        resolveMeta(nextItem.query).then(meta=>{
          try { i.editReply({ content: `⏭️ Skippato. Prossimo: **${meta.title}** — sto per riprodurlo…` }) } catch {}
        }).catch(()=>{})
      } else {
        try { await i.reply({ content: '⏭️ Skippato. **Coda vuota**.', flags: MessageFlags.Ephemeral }) } catch {}
      }

      await safeStopAll(i.guildId)
      if (queues.get(i.guildId)?.queue.length) {
        playNext(i.guildId).catch(()=>{})
      } else {
        await upsertPanel(i.guildId,'idle')
        await upsertQueueMessage(i.guildId)
      }
      return
    }
    if (i.customId==='ctrl_stop'){
      const d = queues.get(i.guildId); if (d) d.queue.length = 0
      await safeStopAll(i.guildId)
      await upsertPanel(i.guildId,'idle')
      await upsertQueueMessage(i.guildId)
      if (!i.deferred && !i.replied) await i.deferUpdate()
      return
    }
    if (i.customId==='ctrl_disconnect'){
      const d = queues.get(i.guildId); if (d) d.queue.length = 0
      await safeStopAll(i.guildId)
      const conn = getVoiceConnection(i.guildId); try { conn?.destroy() } catch {}
      await upsertPanel(i.guildId,'idle')
      await upsertQueueMessage(i.guildId)
      if (!i.deferred && !i.replied) await i.deferUpdate()
      return
    }
  } catch (e) {
    console.error('[interaction]', e)
    if (!i.deferred && !i.replied) try { await i.deferUpdate() } catch {}
  }
})

client.on('messageCreate', async (m)=>{
  if (!m.guild || m.author.bot) return
  if (m.channelId !== ALLOWED_TEXT_CHANNEL_ID) { try { await m.delete() } catch {} ; return }
  if (!m.content.startsWith(PREFIX)){ try { await m.delete() } catch {} ; return }

  const parts = m.content.slice(PREFIX.length).trim().split(/\s+/)
  const cmd = (parts.shift()||'').toLowerCase()
  const args = parts.join(' ')
  ensureSession(m.guildId, m.channel)

  const zap = async ()=>{ try{ await m.delete() }catch{} }

  if (cmd==='play'){
    const q = args.trim()
    const vc = m.member.voice?.channel
    if (!q || !vc) return zap()

    const conn = getVoiceConnection(m.guildId) || joinVoiceChannel({
      channelId: vc.id, guildId: vc.guild.id,
      adapterCreator: vc.guild.voiceAdapterCreator, selfDeaf: true
    })
    const data = queues.get(m.guildId)
    conn.subscribe(data.player)

    data.queue.push({ query: q, requesterId: m.author.id, requesterTag: m.author.tag, channelId: vc.id, adapterCreator: m.guild.voiceAdapterCreator })
    if (data.player.state.status === AudioPlayerStatus.Idle && !data.playing) playNext(m.guildId).catch(()=>{})
    await upsertPanel(m.guildId,'search')
    await upsertQueueMessage(m.guildId)
    return zap()
  }

  if (cmd==='skip'){
    const d = queues.get(m.guildId)
    const nextItem = d?.queue?.[0]
    if (nextItem) { d.nextQuery = nextItem.query; await upsertPanel(m.guildId,'search') } else { await upsertPanel(m.guildId,'idle') }
    await safeStopAll(m.guildId)
    if (queues.get(m.guildId)?.queue.length) playNext(m.guildId).catch(()=>{})
    else await upsertQueueMessage(m.guildId)
    return zap()
  }

  if (cmd==='stop'){
    const d = queues.get(m.guildId); if (d) d.queue.length = 0
    await safeStopAll(m.guildId)
    await upsertPanel(m.guildId,'idle')
    await upsertQueueMessage(m.guildId)
    return zap()
  }

  if (cmd==='disconnect'){
    const d = queues.get(m.guildId); if (d) d.queue.length = 0
    await safeStopAll(m.guildId)
    const conn = getVoiceConnection(m.guildId); try { conn?.destroy() } catch {}
    await upsertPanel(m.guildId,'idle')
    await upsertQueueMessage(m.guildId)
    return zap()
  }

  return zap()
})

client.login(process.env.DISCORD_TOKEN)
