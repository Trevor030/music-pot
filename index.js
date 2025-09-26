import 'dotenv/config'
import { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder } from 'discord.js'
import { joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior, AudioPlayerStatus, getVoiceConnection } from '@discordjs/voice'
import * as play from 'play-dl'

// Optional: set YouTube cookie to bypass age/region restrictions
if (process.env.YT_COOKIE) {
  try {
    await play.setToken({ youtube: { cookie: process.env.YT_COOKIE } })
    console.log('🔑 YT cookie impostato.')
  } catch (e) {
    console.warn('⚠️ Impossibile impostare YT cookie:', e?.message || e)
  }
}

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

// Only clientReady (future-proof for v15)
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

function buildWatchUrlFromId(id) {
  return id ? `https://www.youtube.com/watch?v=${id}` : null
}

/**
 * Resolve query to a valid basic_info object and derived url/title.
 * Returns { info, title, url }
 */
async function resolveYouTube(query) {
  const kind = play.yt_validate(query)

  const loadBasic = async (candidate) => {
    const info = await play.video_basic_info(candidate)
    const vd = info?.video_details || {}
    const url = vd.url || buildWatchUrlFromId(vd.id) || candidate
    const title = vd.title || 'Video YouTube'
    if (!url || !url.startsWith('http')) throw new Error('URL non valido dal video.')
    return { info, title, url }
  }

  if (kind === 'video') {
    return await loadBasic(query)
  }

  const results = await play.search(query, { limit: 5, source: { youtube: 'video' } })
  for (const r of results || []) {
    const candidate = r?.url || buildWatchUrlFromId(r?.id)
    if (!candidate) continue
    try { return await loadBasic(candidate) } catch {}
  }
  throw new Error("Nessun risultato valido trovato su YouTube. Prova con un titolo più preciso o incolla l'URL completo.")
}

async function playNext(guildId) {
  const data = queues.get(guildId)
  if (!data) return
  const next = data.queue.shift()
  if (!next) { data.textChannel?.send('📭 Coda finita.'); return }

  try {
    const { info, title, url } = await resolveYouTube(next.query)
    // 🔧 Use info object directly to stream (more reliable than URL)
    const stream = await play.stream(info, { discordPlayerCompatibility: true })
    if (!stream?.stream || !stream?.type) throw new Error('Stream non disponibile per questo video.')
    const resource = createAudioResource(stream.stream, { inputType: stream.type })
    data.player.play(resource)

    const embed = new EmbedBuilder()
      .setTitle('▶️ In riproduzione')
      .setDescription(`[${title}](${url})`)
      .setFooter({ text: `Richiesto da ${next.requestedBy}` })
    data.textChannel?.send({ embeds: [embed] })
  } catch (err) {
    console.error('playNext error:', err)
    let msg = `⚠️ Errore con questo brano: ${err.message}`
    if (/age|confirm your age|signin|premium|login/i.test(err.message || '')) msg += '\n👉 Il video potrebbe avere restrizioni (età/regioni/login). Incolla un altro link o imposta YT_COOKIE.'
    data.textChannel?.send(msg)
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

  // MUSIC
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

  // GITHUB
  if (command === 'ghrepo') {
    const repo = process.env.GITHUB_REPO
    await message.reply(`📦 Repo corrente: ${repo || 'non impostata (setta env GITHUB_REPO)'}`)
    return
  }

  if (command === 'ghlist') {
    const path = args[0] || ''
    const ref = args[1]
    const repoStr = process.env.GITHUB_REPO
    if (!repoStr) { await message.reply('⚠️ Nessuna repo impostata (env GITHUB_REPO).'); return }
    const [owner, repo] = repoStr.split('/')
    if (!owner || !repo) { await message.reply('⚠️ GITHUB_REPO non valida, usa owner/repo.'); return }

    try {
      const url = new URL(`https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`)
      if (ref) url.searchParams.set('ref', ref)
      const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'discord-music-bot', ...(process.env.GITHUB_TOKEN ? { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}` } : {}) }
      const res = await fetch(url, { headers })
      if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`)
      const dataApi = await res.json()
      if (Array.isArray(dataApi)) {
        const list = dataApi.map(it => `${it.type === 'dir' ? '📁' : '📄'} ${it.name}`).join('\n') || '(vuoto)'
        await message.reply({ embeds: [new EmbedBuilder().setTitle(`Contenuti: /${path}`).setDescription(list).setFooter({ text: `${owner}/${repo}${ref ? `@${ref}` : ''}` })] })
      } else {
        await message.reply({ embeds: [new EmbedBuilder().setTitle(`📄 ${dataApi.name}`).setDescription(`Dimensione: ${dataApi.size} bytes\nPath: ${dataApi.path}`).setFooter({ text: `${owner}/${repo}${ref ? `@${ref}` : ''}` })] })
      }
    } catch (e) {
      console.error(e)
      await message.reply(`❌ Errore GitHub: ${e.message}`)
    }
    return
  }

  if (command === 'ghfile') {
    const path = args[0]
    const ref = args[1]
    if (!path) { await message.reply('Uso: `!ghfile <percorso> [ref]`'); return }
    const repoStr = process.env.GITHUB_REPO
    if (!repoStr) { await message.reply('⚠️ Nessuna repo impostata (env GITHUB_REPO).'); return }
    const [owner, repo] = repoStr.split('/')
    if (!owner || !repo) { await message.reply('⚠️ GITHUB_REPO non valida, usa owner/repo.'); return }

    try {
      const url = new URL(`https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`)
      if (ref) url.searchParams.set('ref', ref)
      const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'discord-music-bot', ...(process.env.GITHUB_TOKEN ? { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}` } : {}) }
      const res = await fetch(url, { headers })
      if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`)
      const file = await res.json()
      if (file.type !== 'file') { await message.reply('❌ Il percorso non è un file.'); return }

      const buff = Buffer.from(file.content || '', 'base64')
      const size = buff.byteLength
      const isText = /^text\//.test(file.type) || /\.(txt|md|json|yml|yaml|js|ts|tsx|jsx|css|html|env|gitignore)$/i.test(file.name)

      if (!isText || size > 1800) {
        const attach = new AttachmentBuilder(buff, { name: file.name })
        await message.reply({ content: `📎 ${file.name} (${size} bytes)`, files: [attach] })
      } else {
        const content = buff.toString('utf8')
        const safe = content.length > 1900 ? content.slice(0, 1900) + '\n…(troncato)' : content
        const codeBlock = '**' + file.name + '**\n\n```\n' + safe + '\n```'
        await message.reply({ content: codeBlock })
      }
    } catch (e) {
      console.error(e)
      await message.reply(`❌ Errore GitHub: ${e.message}`)
    }
    return
  }
})

client.login(process.env.DISCORD_TOKEN)
