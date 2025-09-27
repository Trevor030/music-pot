\
// robust25.5-stream-help-controls: streaming + Help interattivo + pannello controlli Now Playing
import 'dotenv/config'
import sodium from 'libsodium-wrappers'; await sodium.ready

import { 
  Client, GatewayIntentBits,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder
} from 'discord.js'
import {
  joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior,
  AudioPlayerStatus, getVoiceConnection, StreamType
} from '@discordjs/voice'
import { spawn } from 'child_process'

const PREFIX = '!'
const queues = new Map()
const SHOW_HELP_ON_START = (process.env.SHOW_HELP_ON_START || 'false').toLowerCase() === 'true'

// ---- HELP UI (embed + menu + bottoni) ----
const HELP_SECTIONS = {
  main: new EmbedBuilder()
    .setTitle('📖 Menu Comandi')
    .setDescription('Seleziona una categoria dal menu qui sotto per vedere i comandi.\nPrefisso: `!`')
    .addFields(
      { name: '🎵 Musica', value: '`play`, `pause`, `resume`' },
      { name: '🧭 Coda', value: '`queue`, `skip`, `stop`' },
      { name: '⚙️ Varie', value: '`leave`, `np`, `help`' }
    ),
  music: new EmbedBuilder()
    .setTitle('🎵 Comandi Musica')
    .setDescription([
      '`!play <link|titolo>` — cerca/streamma e riproduce subito',
      '`!pause` — mette in pausa',
      '`!resume` — riprende la riproduzione'
    ].join('\n')),
  queue: new EmbedBuilder()
    .setTitle('🧭 Comandi Coda')
    .setDescription([
      '`!queue` — mostra la coda',
      '`!skip` — salta il brano corrente',
      '`!stop` — ferma tutto e svuota la coda'
    ].join('\n')),
  misc: new EmbedBuilder()
    .setTitle('⚙️ Altri Comandi')
    .setDescription([
      '`!leave` — il bot esce dal canale vocale',
      '`!np` — mostra il pannello controlli',
      '`!help` — apre questo menu'
    ].join('\n')),
}

function helpComponents(active = 'main') {
  const select = new StringSelectMenuBuilder()
    .setCustomId('help_select')
    .setPlaceholder('Scegli una categoria…')
    .addOptions(
      { label: 'Panoramica', value: 'main', emoji: '📖', default: active==='main' },
      { label: 'Musica', value: 'music', emoji: '🎵', default: active==='music' },
      { label: 'Coda', value: 'queue', emoji: '🧭', default: active==='queue' },
      { label: 'Varie', value: 'misc',  emoji: '⚙️', default: active==='misc'  },
    )
  const row1 = new ActionRowBuilder().addComponents(select)
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('help_prev').setLabel('◀️ Indice').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('help_music').setLabel('Musica').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('help_queue').setLabel('Coda').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('help_misc').setLabel('Varie').setStyle(ButtonStyle.Primary),
  )
  return [row1, row2]
}

// ---- NOW PLAYING CONTROLS ----
function controlEmbed(title, status = 'idle') {
  const playing = status === 'playing'
  return new EmbedBuilder()
    .setTitle(playing ? '🎧 In riproduzione' : '⏹️ Non in riproduzione')
    .setDescription(playing ? `**${title || '—'}**` : 'Usa `!play <link|titolo>` per iniziare.')
}

function controlComponents(status = 'idle') {
  const playing = status === 'playing'
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(playing ? 'ctrl_pause' : 'ctrl_resume')
      .setLabel(playing ? 'Pausa' : 'Riprendi').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ctrl_skip').setLabel('Skip').setStyle(ButtonStyle.Primary).setDisabled(!playing),
    new ButtonBuilder().setCustomId('ctrl_stop').setLabel('Stop').setStyle(ButtonStyle.Danger).setDisabled(!playing),
    new ButtonBuilder().setCustomId('ctrl_queue').setLabel('Queue').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ctrl_leave').setLabel('Leave').setStyle(ButtonStyle.Secondary)
  )
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ctrl_refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary)
  )
  return [row, row2]
}

async function upsertControls(guildId, status = 'idle') {
  const data = queues.get(guildId); if (!data || !data.textChannel) return
  const embed = controlEmbed(data.nowTitle, status)
  const comps = controlComponents(status)
  try {
    if (data.controlsMsgId) {
      const m = await data.textChannel.messages.fetch(data.controlsMsgId).catch(() => null)
      if (m) { await m.edit({ embeds: [embed], components: comps }); return }
    }
    const sent = await data.textChannel.send({ embeds: [embed], components: comps })
    data.controlsMsgId = sent.id
  } catch (e) { console.error('[controls]', e) }
}

// ---------- Helpers ----------
function ensureGuild(guildId, channel){
  if(!queues.has(guildId)){
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } })
    const data = { 
      queue: [], player, textChannel: channel, current: null, playing: false,
      nowTitle: null, controlsMsgId: null
    }
    player.on(AudioPlayerStatus.Idle, () => {
      data.playing = false
      cleanup(data)
      upsertControls(channel.guild.id, 'idle')
      if (data.queue.length) playNext(channel.guild.id).catch(()=>{})
    })
    player.on('error', e => {
      console.error('[player]', e); data.playing = false; cleanup(data)
      upsertControls(channel.guild.id, 'idle')
      if (data.queue.length) playNext(channel.guild.id).catch(()=>{})
    })
    queues.set(guildId, data)
  }
  return queues.get(guildId)
}

function cleanup(data){
  try { data.current?.feeder?.kill('SIGKILL') } catch {}
  try { data.current?.proc?.kill('SIGKILL') } catch {}
  data.current = null
}

function isUrl(s){ try{ new URL(s); return true } catch { return false } }

// Titolo veloce (senza URL) per UX
function quickTitle(input){
  return new Promise((resolve) => {
    const args = ['--no-playlist','--no-progress','-f','ba[acodec=opus]/ba/bestaudio','--get-title']
    if (isUrl(input)) args.push(input); else args.unshift('ytsearch1:'+input)
    const p = spawn('yt-dlp', args, { stdio: ['ignore','pipe','pipe'] })
    let out=''; p.stdout.on('data',d=>out+=d.toString())
    p.on('close', () => resolve(out.trim().split('\n')[0] || input))
  })
}

// Streaming pipeline: yt-dlp -> stdout -> ffmpeg -> opus/ogg
function streamingPipeline(urlOrQuery){
  const inputArg = isUrl(urlOrQuery) ? urlOrQuery : ('ytsearch1:'+urlOrQuery)
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

  feeder.stdout.pipe(ffmpeg.stdin).on('error',()=>{})
  ffmpeg.stderr.on('data', d => console.error('[ffmpeg]', d.toString()))
  return { feeder, proc: ffmpeg, stream: ffmpeg.stdout }
}

// ---------- Core playback ----------
async function playNext(guildId){
  const data = queues.get(guildId); if (!data) return
  if (data.playing) return
  const next = data.queue.shift(); if (!next){ data.textChannel?.send('📭 Coda finita.'); return }
  data.playing = true

  // placeholder
  let msg = null
  if (next.placeholderId){
    try { msg = await data.textChannel.messages.fetch(next.placeholderId) } catch { msg = null }
  }
  if (!msg) { try { msg = await data.textChannel.send(`⏳ Sto cercando: **${next.query}**`) } catch{} }

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
      data.nowTitle = title
      if (msg) { try { await msg.edit(`▶️ In riproduzione: **${title}**`) } catch {} }
      upsertControls(guildId, 'playing')
    })
    data.player.play(resource)

    // fallback: prova a mostrare i controlli anche se l'evento non scatta
    setTimeout(() => upsertControls(guildId, data.player.state.status === AudioPlayerStatus.Playing ? 'playing' : 'idle'), 1500)

  } catch (e) {
    clearTimeout(slowTimer)
    console.error('[playNext]', e)
    if (msg) { try { await msg.edit(`⚠️ ${e.message}`) } catch {} }
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

client.once('clientReady', async () => {
  console.log(`🤖 Online come ${client.user.tag}`)
  if (!SHOW_HELP_ON_START) return
  for (const guild of client.guilds.cache.values()) {
    try {
      const ch = (await guild.channels.fetch())
        .filter(c => c?.isTextBased?.())
        .first()
      if (ch) await ch.send({ embeds: [HELP_SECTIONS.main], components: helpComponents('main') })
    } catch {}
  }
})

client.on('interactionCreate', async (i) => {
  try {
    // ----- HELP -----
    if (i.isStringSelectMenu() && i.customId === 'help_select') {
      const value = i.values?.[0] || 'main'
      const embed = HELP_SECTIONS[value] || HELP_SECTIONS.main
      return void i.update({ embeds: [embed], components: helpComponents(value) })
    }
    if (i.isButton() && i.customId.startsWith('help_')) {
      if (i.customId === 'help_prev')  return void i.update({ embeds: [HELP_SECTIONS.main],  components: helpComponents('main') })
      if (i.customId === 'help_music') return void i.update({ embeds: [HELP_SECTIONS.music], components: helpComponents('music') })
      if (i.customId === 'help_queue') return void i.update({ embeds: [HELP_SECTIONS.queue], components: helpComponents('queue') })
      if (i.customId === 'help_misc') return void i.update({ embeds: [HELP_SECTIONS.misc],  components: helpComponents('misc') })
    }

    // ----- CONTROLS -----
    if (i.isButton() && i.customId.startsWith('ctrl_')) {
      const data = queues.get(i.guildId)
      if (!data) return void i.reply({ content: 'Nessun contesto di riproduzione.', ephemeral: true })

      if (i.customId === 'ctrl_pause') {
        data.player.pause()
        await i.deferUpdate()
        return upsertControls(i.guildId, 'idle')
      }
      if (i.customId === 'ctrl_resume') {
        data.player.unpause()
        await i.deferUpdate()
        return upsertControls(i.guildId, 'playing')
      }
      if (i.customId === 'ctrl_skip') {
        data.player.stop(true); cleanup(data)
        await i.deferUpdate()
        if (data.queue.length) playNext(i.guildId).catch(()=>{})
        return upsertControls(i.guildId, 'idle')
      }
      if (i.customId === 'ctrl_stop') {
        data.queue.length = 0; data.player.stop(true); cleanup(data); data.playing = false
        await i.deferUpdate()
        return upsertControls(i.guildId, 'idle')
      }
      if (i.customId === 'ctrl_leave') {
        getVoiceConnection(i.guildId)?.destroy(); cleanup(data); data.playing = false
        await i.deferUpdate()
        return upsertControls(i.guildId, 'idle')
      }
      if (i.customId === 'ctrl_queue') {
        const rest = data.queue.map((q, idx) => `${idx+1}. ${q.query}`).join('\n') || '—'
        return void i.reply({ content: `In coda:\n${rest}`, ephemeral: true })
      }
      if (i.customId === 'ctrl_refresh') {
        await i.deferUpdate()
        return upsertControls(i.guildId, data.player.state.status === AudioPlayerStatus.Playing ? 'playing' : 'idle')
      }
    }
  } catch (err) {
    console.error('[interaction]', err)
    if (i.isRepliable() && !i.replied && !i.deferred) {
      await i.reply({ content: '❌ Qualcosa è andato storto.', ephemeral: true })
    }
  }
})

client.on('messageCreate', async (m) => {
  if (m.author.bot) return
  if (!m.content.startsWith(PREFIX)) return

  const args = m.content.slice(PREFIX.length).trim().split(/\s+/)
  const cmd = (args.shift()||'').toLowerCase()
  const data = ensureGuild(m.guildId, m.channel)

  if (cmd === 'help') return void m.reply({ embeds: [HELP_SECTIONS.main], components: helpComponents('main') })
  if (cmd === 'np') { await upsertControls(m.guildId, (data.player.state.status === AudioPlayerStatus.Playing ? 'playing' : 'idle')); return }

  if (cmd === 'play'){
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
    if (data.player.state.status === AudioPlayerStatus.Idle && !data.playing) playNext(m.guildId).catch(()=>{})
    return
  }

  if (cmd === 'skip'){ data.player.stop(true); cleanup(data); return void m.reply('⏭️ Skip.') }
  if (cmd === 'stop'){ data.queue.length = 0; data.player.stop(true); cleanup(data); data.playing = false; return void m.reply('🛑 Fermato.') }
  if (cmd === 'leave'){ getVoiceConnection(m.guildId)?.destroy(); cleanup(data); data.playing = false; return void m.reply('👋 Uscito.') }
  if (cmd === 'pause'){ data.player.pause(); return void m.reply('⏸️ Pausa.') }
  if (cmd === 'resume'){ data.player.unpause(); return void m.reply('▶️ Ripresa.') }
  if (cmd === 'queue'){ const rest = data.queue.map((q,i)=>`${i+1}. ${q.query}`).join('\n') || '—'; return void m.reply(`In coda:\n${rest}`) }
})

client.login(process.env.DISCORD_TOKEN)
