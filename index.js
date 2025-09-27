\
// music-pot GHCR bundle – WebM/Opus direct (no ffmpeg) – progress bar + timer + mini panel
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
const queues = new Map()

const capFirst = (s) => { s = String(s||'').trim(); return s ? s[0].toUpperCase()+s.slice(1) : s }
const fmtDur = (sec)=>{ if(sec==null)return '—'; sec=Math.max(0,Math.floor(sec)); const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60; return h?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${m}:${String(s).padStart(2,'0')}` }
const progressBar = (pos=0,dur=0,w=20)=>{
  if(!dur||dur<=0) return '🔘' + '─'.repeat(w-1)
  const p = Math.max(0, Math.min(1, pos/dur)); const i = Math.max(0, Math.min(w-1, Math.round(p*(w-1))))
  return `${'─'.repeat(i)}🔘${'─'.repeat(w-1-i)}`
}
const isUrl = (s)=>{ try{ new URL(s); return true }catch{ return false } }

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

function webmOpusStream(input){
  const query = isUrl(input) ? input : ('ytsearch1:'+input)
  const proc = spawn('yt-dlp', ['-f','251/bestaudio','--no-playlist','-o','-','--', query], { stdio:['ignore','pipe','pipe'] })
  proc.stderr.on('data', d => console.error('[yt-dlp]', d.toString().trim()))
  return { proc, stream: proc.stdout }
}

function ensureSession(guildId, channel){
  if(!queues.has(guildId)){
    const player = createAudioPlayer()
    const data = {
      player, textChannel: channel, queue: [], panelId: null,
      nowTitle: null, durationSec: null, resource: null,
      progressTimer: null, currentProc: null, requester: null, lastStatus:'idle'
    }
    player.on(AudioPlayerStatus.Idle, ()=>{
      clearInterval(data.progressTimer); data.progressTimer=null
      data.resource=null; data.nowTitle=null; data.durationSec=null
      if (data.queue.length) { playNext(guildId).catch(()=>{}) } else { upsertPanel(guildId, 'idle').catch(()=>{}) }
    })
    player.on('error', e => {
      console.error('[player]', e)
      clearInterval(data.progressTimer); data.progressTimer=null
      upsertPanel(guildId,'error',{message:e?.message||'Errore'}).catch(()=>{})
      if (data.queue.length) playNext(guildId).catch(()=>{})
    })
    queues.set(guildId, data)
  }
  return queues.get(guildId)
}

function panelEmbed(data, status='idle', extra={}){
  const THEME = 0x5865F2
  const e = new EmbedBuilder().setColor(THEME)
  if (status==='idle'){
    e.setTitle('Now Playing — nessuna traccia')
    e.setDescription('Usa `!play <link|titolo>`')
  } else if (status==='search'){
    e.setTitle('🔎 Sto preparando il brano…')
    e.setDescription(`Richiesta: \`${data.queue[0]?.query || '—'}\``)
  } else if (status==='playing'){
    const pos = data.resource ? Math.floor((data.resource.playbackDuration||0)/1000) : 0
    const dur = data.durationSec ?? 0
    const bar = progressBar(pos, dur, 20)
    const rem = dur ? Math.max(0, dur-pos) : null
    e.setTitle('In riproduzione 🎶')
    e.setDescription([
      `**${data.nowTitle||'—'}**  ${data.requester?`_by ${data.requester}_`:''}`.trim(),
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
    new ButtonBuilder().setCustomId('btn_pause').setEmoji('⏸️').setStyle(ButtonStyle.Secondary).setDisabled(!playing),
    new ButtonBuilder().setCustomId('btn_resume').setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(playing),
    new ButtonBuilder().setCustomId('btn_skip').setEmoji('⏭️').setStyle(ButtonStyle.Primary).setDisabled(!playing),
    new ButtonBuilder().setCustomId('btn_stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('btn_queue').setEmoji('🧭').setStyle(ButtonStyle.Secondary)
  ) ]
}
async function upsertPanel(guildId, status='idle', extra={}){
  const data = queues.get(guildId); if(!data||!data.textChannel) return
  data.lastStatus = status
  const embed = panelEmbed(data, status, extra)
  const comps = panelButtons(status)
  try{
    if (data.panelId){
      const ch = await data.textChannel.fetch()
      const m = await ch.messages.fetch(data.panelId).catch(()=>null)
      if (m){ await m.edit({ embeds:[embed], components: comps }); return }
    }
    const ch = await data.textChannel.fetch()
    const recent = await ch.messages.fetch({ limit: 30 }).catch(()=>null)
    if (recent){
      const mine = recent.find(msg => msg.author?.id === msg.client?.user?.id)
      if (mine){ data.panelId = mine.id; await mine.edit({ embeds:[embed], components: comps }); return }
    }
    const sent = await data.textChannel.send({ embeds:[embed], components: comps })
    data.panelId = sent.id
  }catch(e){ console.error('[panel]', e) }
}

async function playNext(guildId){
  const data = queues.get(guildId); if(!data) return
  const next = data.queue.shift()
  if (!next){ await upsertPanel(guildId,'idle'); return }
  data.requester = next.requesterTag
  data.nowTitle = next.meta?.title || capFirst(next.query)
  data.durationSec = next.meta?.durationSec ?? null

  await upsertPanel(guildId,'search')

  try{
    const { proc, stream } = webmOpusStream(next.query)
    data.currentProc = proc
    const resource = createAudioResource(stream, { inputType: StreamType.WebmOpus })
    data.resource = resource

    const conn = getVoiceConnection(guildId) || joinVoiceChannel({ channelId: next.voiceChannelId, guildId, adapterCreator: next.adapterCreator, selfDeaf: true })
    conn.subscribe(data.player)

    data.player.once(AudioPlayerStatus.Playing, async ()=>{
      await upsertPanel(guildId,'playing')
      clearInterval(data.progressTimer)
      data.progressTimer = setInterval(()=>{
        if (data.player.state.status === AudioPlayerStatus.Playing) upsertPanel(guildId,'playing')
      }, PROGRESS_INTERVAL_MS)
    })
    data.player.play(resource)
  }catch(err){
    console.error('[playNext]', err)
    await upsertPanel(guildId,'error',{message: err?.message || 'stream fallito'})
    clearInterval(data.progressTimer); data.progressTimer=null
    try{ data.currentProc?.kill('SIGKILL') }catch{}
    if (data.queue.length) playNext(guildId).catch(()=>{})
  }
}

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
  const data = queues.get(i.guildId); if(!data) return void i.reply({ content:'Nessuna sessione attiva', ephemeral:true })
  try{
    if (i.customId==='btn_pause'){ data.player.pause(true); await i.deferUpdate(); return upsertPanel(i.guildId,'idle') }
    if (i.customId==='btn_resume'){ data.player.unpause(); await i.deferUpdate(); return upsertPanel(i.guildId,'playing') }
    if (i.customId==='btn_skip'){ data.player.stop(true); try{ data.currentProc?.kill('SIGKILL') }catch{}; await i.deferUpdate(); return upsertPanel(i.guildId,'idle') }
    if (i.customId==='btn_stop'){ data.queue.length=0; data.player.stop(true); try{ data.currentProc?.kill('SIGKILL') }catch{}; await i.deferUpdate(); return upsertPanel(i.guildId,'idle') }
    if (i.customId==='btn_queue'){
      const list = data.queue.slice(0, 15).map((q,idx)=> `${idx+1}. ${q.query}`).join('\n') || '—'
      return void i.reply({ content: `Prossimi brani:\n${list}`, ephemeral: true })
    }
  }catch(e){
    console.error('[interaction]', e)
    if (i.isRepliable() && !i.replied && !i.deferred) await i.reply({ content:'Errore interazione', ephemeral:true })
  }
})

client.on('messageCreate', async (m)=>{
  if (m.author.bot || !m.guild) return
  if (!m.content.startsWith(PREFIX)) return
  const [cmd, ...rest] = m.content.slice(PREFIX.length).trim().split(/\s+/)
  const args = rest.join(' ')
  const session = ensureSession(m.guildId, m.channel)

  if (cmd.toLowerCase()==='play'){
    const q = args.trim()
    if (!q) return void m.reply(`Uso: \`${PREFIX}play <link|titolo>\``)
    const vc = m.member.voice?.channel
    if (!vc) return void m.reply('Devi essere in un canale vocale 🎙️')

    const meta = await resolveMeta(q).catch(()=>({ title: capFirst(q), durationSec:null }))
    session.queue.push({ query: q, meta, requesterId: m.author.id, requesterTag: m.author.tag, voiceChannelId: vc.id, adapterCreator: m.guild.voiceAdapterCreator })
    await m.react('🎵')
    if (session.player.state.status !== AudioPlayerStatus.Playing) playNext(m.guildId).catch(()=>{})
    else upsertPanel(m.guildId,'playing').catch(()=>{})
  }
})

client.login(process.env.DISCORD_TOKEN)
