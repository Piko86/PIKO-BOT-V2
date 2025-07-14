// plugins/ytsing.js

const { cmd } = require("../command");
const ytdl = require("ytdl-core");
const fs = require("fs");
const path = require("path");

// Create a temporary downloads folder if it doesn't exist
const TMP_DIR = path.join(__dirname, "..", "temp");
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR);
}

cmd(
  {
    pattern: "ytsing",
    alias: ["yta"],
    desc: "Download YouTube audio as mp3",
    category: "download",
    react: "🎵",
    filename: __filename,
  },
  async (robin, mek, m, { from, body, reply }) => {
    try {
      // Extract the URL argument
      const url = body.trim().split(/\s+/)[1];
      if (!url) return reply("❌ Please provide a YouTube link.\nExample: *.ytsing https://youtu.be/xyz*");

      // Validate URL
      if (!ytdl.validateURL(url)) return reply("❌ Invalid YouTube URL.");

      reply(`🔄 Downloading audio...\n🔗 *URL:* ${url}`);

      // Get video info
      const info = await ytdl.getInfo(url);
      const title = info.videoDetails.title.replace(/[^\w\s]/gi, "").substring(0, 40);
      const filePath = path.join(TMP_DIR, `${title}_${Date.now()}.mp3`);

      // Download audio stream
      const audioStream = ytdl(url, { filter: "audioonly", quality: "highestaudio" });

      // Save to file
      const file = fs.createWriteStream(filePath);
      audioStream.pipe(file);

      // Wait until finished
      await new Promise((resolve, reject) => {
        file.on("finish", resolve);
        file.on("error", reject);
      });

      // Send audio
      await robin.sendMessage(from, { audio: { url: filePath }, mimetype: "audio/mpeg" }, { quoted: mek });

      reply(`✅ Done! *${title}* sent.`);

      // Clean up
      fs.unlinkSync(filePath);

    } catch (e) {
      console.error("Error downloading YouTube audio:", e);
      reply(`❌ Error: ${e.message}`);
    }
  }
);
