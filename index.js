import 'dotenv/config'
import { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder } from 'discord.js'
import { joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior, AudioPlayerStatus, getVoiceConnection } from '@discordjs/voice'
import * as play from 'play-dl'

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

client.once('ready', () => console.log(`🤖 Online come ${client.user.tag}`))

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

async function playNext(guildId) {
  const data = queues.get(guildId)
  if (!data) return
  const next = data.queue.shift()
  if (!next) { data.textChannel?.send('📭 Coda finita.'); return }

  try {
    let ytInfo
    if (play.yt_validate(next.query) === 'video') {
      ytInfo = await play.video_info(next.query)
    } else {
      const res = await play.search(next.query, { limit: 1, source: { youtube: 'video' } })
      if (!res.length) throw new Error('Nessun risultato trovato.')
      ytInfo = await play.video_info(res[0].url)
    }
    const stream = await play.stream(ytInfo.video_details.url, { discordPlayerCompatibility: true })
    const resource = createAudioResource(stream.stream, { inputType: stream.type })
    data.player.play(resource)

    const embed = new EmbedBuilder()
      .setTitle('▶️ In riproduzione')
      .setDescription(`[${ytInfo.video_details.title}](${ytInfo.video_details.url})`)
      .addFields(
        { name: 'Durata', value: ytInfo.video_details.durationRaw || 'sconosciuta', inline: true },
        { name: 'Canale', value: ytInfo.video_details.channel?.name || 'YouTube', inline: true }
      )
      .setFooter({ text: `Richiesto da ${next.requestedBy}` })
    data.textChannel?.send({ embeds: [embed] })
  } catch (err) {
    console.error(err)
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

  // MUSIC
  if (command === 'play') {
    const query = args.join(' ')
    if (!query) return void message.reply('Devi scrivere un link o un titolo, es: `!play bohemian rhapsody`')
    const vc = message.member.voice?.channel
    if (!vc) return void message.reply('Devi essere in un canale vocale 🎙️')

    try {
      const conn = getVoiceConnection(guildId) || await connectToVoice(vc)
      conn.subscribe(data.player)
      data.queue.push({ query, requestedBy: message.author.tag })
      if (data.player.state.status === AudioPlayerStatus.Idle) playNext(guildId)
      return void message.reply(`🎶 Aggiunto in coda: **${query}**`)
    } catch (e) {
      console.error(e)
      return void message.reply('❌ Non riesco a connettermi al canale vocale.')
    }
  }

  if (command === 'pause') { data.player.pause(); return void message.reply('⏸️ Pausa.') }
  if (command === 'resume') { data.player.unpause(); return void message.reply('▶️ Ripresa.') }
  if (command === 'skip') { data.player.stop(true); return void message.reply('⏭️ Skip.') }
  if (command === 'stop') { data.queue.length = 0; data.player.stop(true); return void message.reply('🛑 Fermato e coda svuotata.') }
  if (command === 'leave') { getVoiceConnection(guildId)?.destroy(); return void message.reply('👋 Uscito dal canale.') }

  // GITHUB (usa GitHub API)
  if (command === 'ghrepo') {
    const repo = process.env.GITHUB_REPO
    return void message.reply(`📦 Repo corrente: ${repo || 'non impostata (setta env GITHUB_REPO)'}`)
  }

  if (command === 'ghlist') {
    const path = args[0] || ''
    const ref = args[1] // opzionale
    const repoStr = process.env.GITHUB_REPO
    if (!repoStr) return void message.reply('⚠️ Nessuna repo impostata (env GITHUB_REPO).')
    const [owner, repo] = repoStr.split('/')
    if (!owner || !repo) return void message.reply('⚠️ GITHUB_REPO non valida, usa owner/repo.')

    try {
      const url = new URL(`https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`)
      if (ref) url.searchParams.set('ref', ref)
      const headers = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'discord-music-bot',
        ...(process.env.GITHUB_TOKEN ? { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}` } : {})
      }
      const res = await fetch(url, { headers })
      if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`)
      const dataApi = await res.json()
      if (Array.isArray(dataApi)) {
        const list = dataApi.map(it => `${it.type === 'dir' ? '📁' : '📄'} ${it.name}`).join('\n') || '(vuoto)'
        return void message.reply({ embeds: [new EmbedBuilder().setTitle(`Contenuti: /${path}`).setDescription(list).setFooter({ text: `${owner}/${repo}${ref ? `@${ref}` : ''}` })] })
      } else {
        return void message.reply({ embeds: [new EmbedBuilder().setTitle(`📄 ${dataApi.name}`).setDescription(`Dimensione: ${dataApi.size} bytes\nPath: ${dataApi.path}`).setFooter({ text: `${owner}/${repo}${ref ? `@${ref}` : ''}` })] })
      }
    } catch (e) {
      console.error(e)
      return void message.reply(`❌ Errore GitHub: ${e.message}`)
    }
  }

  if (command === 'ghfile') {
    const path = args[0]
    const ref = args[1]
    if (!path) return void message.reply('Uso: `!ghfile <percorso> [ref]`')
    const repoStr = process.env.GITHUB_REPO
    if (!repoStr) return void message.reply('⚠️ Nessuna repo impostata (env GITHUB_REPO).')
    const [owner, repo] = repoStr.split('/')
    if (!owner || !repo) return void message.reply('⚠️ GITHUB_REPO non valida, usa owner/repo.')

    try {
      const url = new URL(`https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`)
      if (ref) url.searchParams.set('ref', ref)
      const headers = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'discord-music-bot',
        ...(process.env.GITHUB_TOKEN ? { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}` } : {})
      }
      const res = await fetch(url, { headers })
      if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`)
      const file = await res.json()
      if (file.type !== 'file') return void message.reply('❌ Il percorso non è un file.')

      const buff = Buffer.from(file.content || '', 'base64')
      const size = buff.byteLength
      const isText = /^text\//.test(file.type) || /\.(txt|md|json|yml|yaml|js|ts|tsx|jsx|css|html|env|gitignore)$/i.test(file.name)

      if (!isText || size > 1800) {
        const attach = new AttachmentBuilder(buff, { name: file.name })
        return void message.reply({ content: `📎 ${file.name} (${size} bytes)`, files: [attach] })
      } else {
        const content = buff.toString('utf8')
        const safe = content.length > 1900 ? content.slice(0, 1900) + '\n…(troncato)' : content
        return void message.reply({ content: `**${file.name}**\n\n\` + '`' + '`\n' + safe + '\n' + '`' + '`' + '`' })
      }
    } catch (e) {
      console.error(e)
      return void message.reply(`❌ Errore GitHub: ${e.message}`)
    }
  }
})

client.login(process.env.DISCORD_TOKEN)
