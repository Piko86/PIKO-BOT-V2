const { cmd } = require("../command");
const yts = require("yt-search");
const axios = require("axios");

cmd(
  {
    pattern: "song",
    react: "🎶",
    desc: "Download YouTube Song (Audio + Document)",
    category: "download",
    filename: __filename,
  },
  async (robin, mek, m, { from, q, reply }) => {
    try {
      if (!q) return reply("*Provide a song name or a YouTube link.* 🎶");

      // Search video/song
      const search = await yts(q);
      if (!search.videos || search.videos.length === 0)
        return reply("❌ No results found. Try another query.");

      const data = search.videos[0];
      const url = data.url;

      // Song info message
      const desc = `🎶 *PIKO YT SONG DOWNLOADER* 🎶

🎤 *Title* : ${data.title}
📀 *Duration* : ${data.timestamp}
👁 *Views* : ${data.views}
📅 *Uploaded* : ${data.ago}
📺 *Channel* : ${data.author.name}
🔗 *Link* : ${data.url}

𝐌𝐚𝐝𝐞 𝐛𝐲 *P_I_K_O* ☯️`;

      await robin.sendMessage(
        from,
        { image: { url: data.thumbnail }, caption: desc },
        { quoted: mek }
      );

      // Download function (audio only)
      const downloadAudio = async (url) => {
        const apiUrl = `https://p.oceansaver.in/ajax/download.php?format=mp3&url=${encodeURIComponent(
          url
        )}&api=${process.env.OCEANSAVER_KEY || "default_key"}`;

        const { data: res } = await axios.get(apiUrl);
        if (!res || !res.success) throw new Error("Song download API failed.");

        const { id, title } = res;
        const progressUrl = `https://p.oceansaver.in/ajax/progress.php?id=${id}`;

        for (let i = 0; i < 10; i++) {
          const { data: progress } = await axios.get(progressUrl);
          if (progress.success && progress.progress === 1000) {
            const audioBuffer = await axios.get(progress.download_url, {
              responseType: "arraybuffer",
            });
            return { buffer: audioBuffer.data, title };
          }
          await new Promise((r) => setTimeout(r, 5000));
        }

        throw new Error("Audio download timed out. Try again later.");
      };

      // Download & send audio
      const song = await downloadAudio(url);

      // 🎵 Send as normal WhatsApp audio
      await robin.sendMessage(
        from,
        {
          audio: song.buffer,
          mimetype: "audio/mpeg",
          fileName: `${song.title}.mp3`,
          caption: `🎵 *${song.title}*\n\n𝐌𝐚𝐝𝐞 𝐛𝐲 *P_I_K_O* ☯️`,
        },
        { quoted: mek }
      );

      // 📂 Send again as document
      await robin.sendMessage(
        from,
        {
          document: song.buffer,
          mimetype: "audio/mpeg",
          fileName: `${song.title}.mp3`,
          caption: `📂 *${song.title}* (Document)\n\n𝐌𝐚𝐝𝐞 𝐛𝐲 *P_I_K_O* ☯️`,
        },
        { quoted: mek }
      );

      reply("*Enjoy your music!* 🎧💜");
    } catch (e) {
      console.error(e);
      reply(`❌ Error: ${e.message}`);
    }
  }
);
