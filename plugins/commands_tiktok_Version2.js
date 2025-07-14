const { cmd } = require("../command");
const axios = require("axios");

cmd(
  {
    pattern: "tiktok",
    react: "🎥",
    desc: "Download TikTok Video or Slideshow",
    category: "download",
    filename: __filename,
  },
  async (
    robin,
    mek,
    m,
    { from, quoted, q, reply }
  ) => {
    try {
      if (!q) return reply("*Provide a TikTok video link or ID.* 💜");

      // TikWM API endpoint
      const apiUrl = `https://tikwm.com/api/?url=${encodeURIComponent(q)}`;

      const { data } = await axios.get(apiUrl);

      if (!data || data.code !== 0 || !data.data) {
        return reply("❌ Failed to fetch video. Make sure the link is correct.");
      }

      const d = data.data;
      const title = d.title || "TikTok Video";
      const author = d.author?.nickname || d.author?.unique_id || "";
      const thumbnail = d.cover || d.origin_cover || "";

      let desc = `💜 *PIKO TIKTOK DOWNLOADER* 💜

👤 *Author*: ${author}
📝 *Title*: ${title}

🔗 *Video Link*: ${q}

𝐌𝐚𝐝𝐞 𝐛𝐲 *P_I_K_O* ☯️
`;

      // Send metadata and thumbnail message
      if (thumbnail) {
        await robin.sendMessage(
          from,
          { image: { url: thumbnail }, caption: desc },
          { quoted: mek }
        );
      } else {
        await reply(desc);
      }

      // --- Slideshow (photo mode) support ---
      if (Array.isArray(d.images) && d.images.length > 0) {
        // Send each image (or as an album if supported)
        for (let i = 0; i < d.images.length; i++) {
          await robin.sendMessage(
            from,
            {
              image: { url: d.images[i] },
              caption: i === 0
                ? `📮 *TikTok Slideshow*\n${d.images.length} photos\n\n𝐌𝐚𝐝𝐞 𝐛𝐲 *P_I_K_O* ☯️`
                : undefined,
            },
            { quoted: mek }
          );
        }
        // Optionally send music if available
        if (d.music) {
          await robin.sendMessage(
            from,
            {
              audio: { url: d.music },
              mimetype: "audio/mp4",
              caption: `🎵 *Audio from slideshow*\n\n𝐌𝐚𝐝𝐞 𝐛𝐲 *P_I_K_O* ☯️`,
            },
            { quoted: mek }
          );
        }

        return reply("*Sent TikTok Slideshow Images!* 🧧");
      }

      // --- Video (normal) support ---
      const videoUrl = d.play; // No watermark
      if (!videoUrl) {
        return reply("❌ No video or slideshow found for this link.");
      }

      // Fetch video buffer
      const videoBuffer = await axios.get(videoUrl, { responseType: "arraybuffer" });

      // Send video
      await robin.sendMessage(
        from,
        {
          video: videoBuffer.data,
          caption: `☮️ *${title}*\n\n𝐌𝐚𝐝𝐞 𝐛𝐲 *P_I_K_O* ☯️`,
        },
        { quoted: mek }
      );
      reply("*Thanks for using my bot!* 💙");
    } catch (e) {
      console.error(e);
      reply(`❌ Error: ${e.message}`);
    }
  }
);
