const { cmd } = require("../command");
const yts = require("yt-search");
const { ytmp3 } = require("@vreden/youtube_scraper");

cmd(
  {
    pattern: "song",
    react: "🎶",
    desc: "Download Song",
    category: "download",
    filename: __filename,
  },
  async (
    robin,
    mek,
    m,
    {
      from,
      q,
      reply,
    }
  ) => {
    try {
      if (!q) return reply("*Please provide a song name or YouTube link* ❤️");

      // Search on YouTube
      const search = await yts(q);
      const data = search.videos[0];
      if (!data) return reply("❌ No results found. Try another keyword.");

      // Validate duration (with guard)
      let durationSeconds = 0;
      if (data.timestamp) {
        let parts = data.timestamp.split(":").map(Number);
        durationSeconds =
          parts.length === 3
            ? parts[0] * 3600 + parts[1] * 60 + parts[2]
            : parts[0] * 60 + parts[1];

        if (durationSeconds > 1800) {
          return reply("⏱️ Audio limit is 30 minutes.");
        }
      }

      // Metadata caption
      let desc = `
*❤️💟 PIKO YT SONG DOWNLOADER 💜*

🎵 *Title* : ${data.title}
📄 *Description* : ${data.description || "N/A"}
⏱️ *Duration* : ${data.timestamp || "N/A"}
📅 *Published* : ${data.ago}
👁️ *Views* : ${data.views}
🔗 *Url* : ${data.url}

𝐌𝐚𝐝𝐞 𝐛𝐲 *P_I_K_O*
`;

      // Send preview thumbnail
      await robin.sendMessage(
        from,
        { image: { url: data.thumbnail }, caption: desc },
        { quoted: mek }
      );

      // Download audio
      const songData = await ytmp3(data.url, "128");
      if (!songData?.download?.url) {
        return reply("❌ Failed to fetch audio download link. Try again.");
      }

      // Safe filename
      const safeFileName = data.title.replace(/[\/\\?%*:|"<>]/g, "_") + ".mp3";

      // Send audio
      await robin.sendMessage(
        from,
        {
          audio: { url: songData.download.url },
          mimetype: "audio/mpeg",
        },
        { quoted: mek }
      );

      // Send as document (optional)
      await robin.sendMessage(
        from,
        {
          document: { url: songData.download.url },
          mimetype: "audio/mpeg",
          fileName: safeFileName,
          caption: "𝐌𝐚𝐝𝐞 𝐛𝐲 *P_I_K_O* 💜",
        },
        { quoted: mek }
      );

      return reply("*UPLOAD COMPLETED* ✅");
    } catch (e) {
      console.error(e);
      reply(`❌ Error: ${e.message}`);
    }
  }
);
