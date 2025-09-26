import 'dotenv/config'
import { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder } from 'discord.js'
import { joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior, AudioPlayerStatus, getVoiceConnection } from '@discordjs/voice'
import * as play from 'play-dl'

const queues = new Map()
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages] })

client.once('ready', () => console.log(`🤖 Online come ${client.user.tag}`))

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
      .setFooter({ text: `Richiesto da ${next.requestedBy}` })
    data.textChannel?.send({ embeds: [embed] })
  } catch (err) {
    console.error(err)
    data.textChannel?.send(`⚠️ Errore con questo brano: ${err.message}`)
    playNext(guildId)
  }
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return
  const { commandName } = interaction
  const guildId = interaction.guildId

  if (!queues.has(guildId)) {
    queues.set(guildId, { queue: [], player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } }), textChannel: interaction.channel })
  }
  const data = queues.get(guildId)
  data.player.on(AudioPlayerStatus.Idle, () => playNext(guildId))

  // MUSICA
  if (commandName === 'play') {
    const query = interaction.options.getString('query', true)
    const memberVc = interaction.member.voice?.channel
    if (!memberVc) return interaction.reply({ content: 'Entra in vocale prima di usare /play', ephemeral: true })
    await interaction.deferReply()
    try {
      const connection = getVoiceConnection(guildId) || await connectToVoice(memberVc)
      connection.subscribe(data.player)
      data.queue.push({ query, requestedBy: interaction.user.tag })
      if (data.player.state.status === AudioPlayerStatus.Idle) playNext(guildId)
      await interaction.editReply(`🎶 Aggiunto alla coda: **${query}**`)
    } catch (err) { await interaction.editReply('❌ Non riesco a connettermi al canale vocale.') }
  }
  if (commandName === 'pause') { data.player.pause(); return interaction.reply('⏸️ Messo in pausa.') }
  if (commandName === 'resume') { data.player.unpause(); return interaction.reply('▶️ Ripresa la riproduzione.') }
  if (commandName === 'skip') { data.player.stop(true); return interaction.reply('⏭️ Saltato.') }
  if (commandName === 'stop') { data.queue.length = 0; data.player.stop(true); return interaction.reply('🛑 Fermato e coda svuotata.') }
  if (commandName === 'leave') { const conn = getVoiceConnection(guildId); if (conn) conn.destroy(); return interaction.reply('👋 Uscito dal canale.') }

  // GITHUB
  const GH_API = 'https://api.github.com'
  const defaultHeaders = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'discord-music-bot', ...(process.env.GITHUB_TOKEN ? { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}` } : {}) }
  const ensureRepo = () => process.env.GITHUB_REPO
  const parseRepo = (str) => { const [o, r] = (str || '').split('/'); if (!o||!r) throw new Error('Repo non valida'); return { owner:o, repo:r } }
  async function ghRequest(path, params={}) { const url = new URL(GH_API+path); Object.entries(params).forEach(([k,v])=>v&&url.searchParams.set(k,v)); const res=await fetch(url,{headers:defaultHeaders}); if(!res.ok) throw new Error(await res.text()); return res.json() }
  async function ghGetContents(owner,repo,path,ref) { return ghRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path||'')}`, ref?{ref}:{}) }

  if (commandName === 'ghrepo') return interaction.reply(`📦 Repo corrente: ${ensureRepo()||'non impostata'}`)
  if (commandName === 'ghlist') {
    const path = interaction.options.getString('path')||''
    const ref = interaction.options.getString('ref')||undefined
    const repoStr = ensureRepo(); if(!repoStr) return interaction.reply('⚠️ Nessuna repo impostata')
    const {owner,repo}=parseRepo(repoStr); const files=await ghGetContents(owner,repo,path,ref)
    const list=Array.isArray(files)?files.map(f=>`${f.type==='dir'?'📁':'📄'} ${f.name}`).join('\n'):'Nessun contenuto'
    return interaction.reply({embeds:[new EmbedBuilder().setTitle(`Contenuti ${path||''}`).setDescription(list)]})
  }
  if (commandName === 'ghfile') {
    const path = interaction.options.getString('path',true); const ref = interaction.options.getString('ref')||undefined
    const repoStr = ensureRepo(); if(!repoStr) return interaction.reply('⚠️ Nessuna repo impostata')
    const {owner,repo}=parseRepo(repoStr); const file=await ghGetContents(owner,repo,path,ref)
    if(file.type!=='file') return interaction.reply('❌ Non è un file.')
    const buff=Buffer.from(file.content||'','base64')
    const content=buff.toString('utf8'); const safe=content.length>1800?content.slice(0,1800)+'\n...(troncato)':content
    return interaction.reply({content:`**${file.name}**\n\n\`\`\`\n${safe}\n\`\`\``})
  }
})

client.login(process.env.DISCORD_TOKEN)
