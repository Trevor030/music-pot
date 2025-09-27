import {
  Client, GatewayIntentBits,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle
} from "discord.js";
import {
  joinVoiceChannel, createAudioPlayer,
  createAudioResource, AudioPlayerStatus
} from "@discordjs/voice";
import { spawn } from "child_process";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const PREFIX = "!";
const queue = new Map();
const PROGRESS_INTERVAL_MS = process.env.PROGRESS_INTERVAL_MS
  ? parseInt(process.env.PROGRESS_INTERVAL_MS)
  : 3000;

// Capitalizza prima lettera
function capFirst(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
// Format mm:ss
function fmtDur(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
// Barra progressiva
function progressBar(pos, dur, size = 20) {
  if (dur <= 0) return "🔘" + "─".repeat(size - 1);
  const p = Math.floor((pos / dur) * size);
  return "─".repeat(p) + "🔘" + "─".repeat(size - p - 1);
}

// 🔎 Recupera metadati
function resolveMeta(input) {
  return new Promise((resolve) => {
    const query = /^https?:\/\//.test(input) ? input : `ytsearch1:${input}`;
    const p = spawn("yt-dlp", ["-J", "--no-playlist", "--", query]);

    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", () => {
      try {
        const j = JSON.parse(out || "{}");
        const info = Array.isArray(j.entries) ? j.entries[0] : j;
        const title = capFirst(info?.title || input);
        const uploader = info?.uploader || info?.channel || "YouTube";
        const durationSec = Number(info?.duration) || null;
        resolve({ title, uploader, durationSec });
      } catch {
        resolve({ title: capFirst(input), uploader: "YouTube", durationSec: null });
      }
    });
  });
}

// 🎨 Pannello Embed
function panelEmbed(guildId, status, data) {
  const e = new EmbedBuilder().setColor(0x9b59b6);

  if (status === "idle") {
    e.setTitle("Now Playing — nessuna traccia");
    e.setDescription(`Usa \`${PREFIX}play <link|titolo>\``);
  } else if (status === "search") {
    e.setTitle("Sto cercando il brano...");
  } else if (status === "playing") {
    const requester = data.requesterTag || "—";
    const pos = data.resource ? Math.floor((data.resource.playbackDuration || 0) / 1000) : 0;
    const dur = data.durationSec ?? 0;
    const bar = dur > 0 ? progressBar(pos, dur, 20) : "🔘" + "─".repeat(19);
    const rem = dur > 0 ? Math.max(0, dur - pos) : null;

    e.setTitle("In riproduzione 🎶");
    e.setDescription([
      `**${data.nowTitle || "—"}**  _(by ${requester})_`,
      `\`${bar}\``,
      rem != null
        ? `⏱️ ${fmtDur(pos)} trascorsi • -${fmtDur(rem)} rimanenti (totale ${fmtDur(dur)})`
        : `⏱️ ${fmtDur(pos)} trascorsi • durata sconosciuta`
    ].join("\n"));
  }

  return e;
}

// Bottoni controlli
function controlsRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("prev").setEmoji("⏮️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("pause").setEmoji("⏸️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("resume").setEmoji("▶️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("stop").setEmoji("⏹️").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("skip").setEmoji("⏭️").setStyle(ButtonStyle.Secondary)
  );
}

// 📌 Aggiorna/crea pannello
async function upsertPanel(guildId, status) {
  const data = queue.get(guildId);
  const ch = await client.channels.fetch(data.textChannel);
  if (!ch) return;

  if (!data.panelMsg) {
    data.panelMsg = await ch.send({
      embeds: [panelEmbed(guildId, status, data)],
      components: [controlsRow()]
    });
  } else {
    await data.panelMsg.edit({
      embeds: [panelEmbed(guildId, status, data)],
      components: [controlsRow()]
    });
  }
}

// ▶️ Play next
async function playNext(guildId) {
  const data = queue.get(guildId);
  if (!data || data.songs.length === 0) {
    data.nowTitle = null;
    await upsertPanel(guildId, "idle");
    return;
  }

  const song = data.songs.shift();
  data.nowTitle = song.title;
  data.durationSec = song.durationSec;

  await upsertPanel(guildId, "search");

  const ytdlp = spawn("yt-dlp", [
    "-f", "bestaudio",
    "-o", "-", "--no-playlist", "--", song.url
  ]);

  const resource = createAudioResource(ytdlp.stdout, { inlineVolume: true });
  data.resource = resource;
  data.player.play(resource);

  data.player.once(AudioPlayerStatus.Playing, async () => {
    await upsertPanel(guildId, "playing");
    clearInterval(data.progressTimer);
    data.progressTimer = setInterval(() => {
      if (data.player.state.status === AudioPlayerStatus.Playing) {
        upsertPanel(guildId, "playing");
      }
    }, PROGRESS_INTERVAL_MS);
  });

  data.player.once(AudioPlayerStatus.Idle, () => {
    clearInterval(data.progressTimer);
    playNext(guildId);
  });
}

// 🎧 Comandi testuali
client.on("messageCreate", async (msg) => {
  if (!msg.content.startsWith(PREFIX) || msg.author.bot) return;
  const args = msg.content.slice(PREFIX.length).trim().split(/ +/);
  const cmd = args.shift().toLowerCase();
  const guildId = msg.guild.id;

  if (cmd === "play") {
    const query = args.join(" ");
    if (!query) return msg.reply("Inserisci un titolo o link!");

    const vc = msg.member?.voice?.channel;
    if (!vc) return msg.reply("Devi essere in un canale vocale!");

    let data = queue.get(guildId);
    if (!data) {
      const conn = joinVoiceChannel({
        channelId: vc.id,
        guildId,
        adapterCreator: msg.guild.voiceAdapterCreator
      });
      const player = createAudioPlayer();
      conn.subscribe(player);
      data = { textChannel: msg.channel.id, voiceChannel: vc.id, conn, player, songs: [] };
      queue.set(guildId, data);
    }

    const meta = await resolveMeta(query);
    data.songs.push({ title: meta.title, url: query, durationSec: meta.durationSec });
    msg.reply(`🎶 Aggiunto in coda: **${meta.title}**`);

    if (data.player.state.status !== AudioPlayerStatus.Playing) playNext(guildId);
    else upsertPanel(guildId, "playing");
  }
});

// 🔘 Pulsanti
client.on("interactionCreate", async (i) => {
  if (!i.isButton()) return;
  const data = queue.get(i.guild.id);
  if (!data) return;

  switch (i.customId) {
    case "pause": data.player.pause(); break;
    case "resume": data.player.unpause(); break;
    case "skip": data.player.stop(); break;
    case "stop": data.songs = []; data.player.stop(); break;
  }
  await i.deferUpdate();
});

// 🚀 Avvio
client.once("ready", () => {
  console.log(`🤖 Online come ${client.user.tag}`);
});
client.login(process.env.DISCORD_TOKEN);
