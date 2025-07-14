const fs = require('fs');
const ytdl = require('ytdl-core');
const path = require('path');

module.exports = {
  pattern: 'song',
  alias: ['ytaudio'],
  description: 'Download YouTube audio',
  category: 'downloader',
  async run({ sock, m, args }) {
    if (!args[0]) {
      return sock.sendMessage(m.chat, { text: 'Please provide a YouTube link.\nExample: .song <link>' }, { quoted: m });
    }

    const url = args[0];
    if (!ytdl.validateURL(url)) {
      return sock.sendMessage(m.chat, { text: 'Invalid YouTube link.' }, { quoted: m });
    }

    try {
      // Get video info
      const info = await ytdl.getInfo(url);
      const title = info.videoDetails.title.replace(/[^\w\s]/gi, '');
      const fileName = `${title}.mp3`;
      const filePath = path.join(__dirname, fileName);

      // Notify user
      await sock.sendMessage(m.chat, { text: `Downloading *${title}*...` }, { quoted: m });

      // Download audio
      await new Promise((resolve, reject) => {
        const stream = ytdl(url, { filter: 'audioonly' });
        const file = fs.createWriteStream(filePath);
        stream.pipe(file);
        stream.on('end', resolve);
        stream.on('error', reject);
      });

      // Send audio file
      await sock.sendMessage(
        m.chat,
        {
          audio: fs.readFileSync(filePath),
          mimetype: 'audio/mp4',
          ptt: false, // set to true to send as voice note
          fileName: fileName
        },
        { quoted: m }
      );

      // Cleanup
      fs.unlinkSync(filePath);
    } catch (err) {
      console.error(err);
      await sock.sendMessage(m.chat, { text: '❌ Failed to download audio.' }, { quoted: m });
    }
  }
};

