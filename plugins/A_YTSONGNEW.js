
const { cmd, commands } = require("../command");
const yts = require("yt-search");
const { ytmp3 } = require("@vreden/youtube_scraper");

cmd(
  {
    pattern: "song2",
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
      quoted,
      body,
      isCmd,
      command,
      args,
      q,
      isGroup,
      sender,
      senderNumber,
      botNumber2,
      botNumber,
      pushname,
      isMe,
      isOwner,
      groupMetadata,
      groupName,
      participants,
      groupAdmins,
      isBotAdmins,
      isAdmins,
      reply,
    }
  ) => {
    try {
      if (!q) return reply("*Please Give A Name Or A Link To The Audio* ❤️");

      const search = await yts(q);
      const data = search.videos[0];
      if (!data) return reply("❌ No results found for your search.");

      const url = data.url;

      const desc = `
*❤️💟 PIKO YT SONG DOWNLOADER 💜*

👻 *Title* : ${data.title}
👻 *Description* : ${data.description || "No description"}
👻 *Time* : ${data.timestamp || "Unknown"}
👻 *Ago* : ${data.ago}
👻 *Views* : ${data.views}
👻 *Url* : ${data.url}

𝐌𝐚𝐝𝐞 𝐛𝐲 *P_I_K_O*
`;

      await robin.sendMessage(
        from,
        { image: { url: data.thumbnail }, caption: desc },
        { quoted: mek }
      );

      const quality = "128";
      const songData = await ytmp3(url, quality);
      if (!songData?.download?.url) return reply("❌ Failed to get the download link.");

      // Safely calculate duration
      let durationInSeconds = 0;
      if (data.timestamp) {
        const parts = data.timestamp.split(":").map(Number);
        if (parts.length === 3) {
          durationInSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
        } else if (parts.length === 2) {
          durationInSeconds = parts[0] * 60 + parts[1];
        }
      }

      if (durationInSeconds > 1800) {
        return reply("⏱️ Audio limit is 30 minutes.");
      }

      await robin.sendMessage(
        from,
        {
          audio: { url: songData.download.url },
          mimetype: "audio/mpeg",
        },
        { quoted: mek }
      );

      await robin.sendMessage(
        from,
        {
          document: { url: songData.download.url },
          mimetype: "audio/mpeg",
          fileName: `${data.title}.mp3`,
          caption: "𝐌𝐚𝐝𝐞 𝐛𝐲 *P_I_K_O* 💜",
        },
        { quoted: mek }
      );

      return reply("*UPLOAD COMPLETED* ✅");

    } catch (e) {
      console.log("🔴 Song plugin error:", e); // Log in terminal
      reply("❌ Something went wrong while processing your request. Please try again.");
    }
  }
);
