const { cmd } = require('../command');
const { igdl } = require('ruhend-scraper');

cmd(
  {
    pattern: 'igpost',
    desc: 'Download Instagram image posts only.',
    category: 'download',
    filename: __filename,
  },
  async (client, m, mek, { q, reply }) => {
    try {
      if (!q || !q.includes("instagram.com")) {
        return reply('*🚫 Please provide a valid Instagram URL.*');
      }

      // ❌ Reject Reels, Stories, and Highlights
      const lowerUrl = q.toLowerCase();
      if (lowerUrl.includes('/reel/') || lowerUrl.includes('/reels/') || lowerUrl.includes('/stories/') || lowerUrl.includes('/highlights/')) {
        return reply('*🚫 This command only supports Instagram photo posts. Reels, Stories, and Highlights are not allowed.*');
      }

      await m.react('⏳');

      let result;
      try {
        result = await igdl(q);
      } catch (err) {
        console.error("Scraper error:", err);
        return reply('*❌ Failed to fetch data. Instagram may have changed or the link is private.*');
      }

      const mediaList = result?.data;
      if (!mediaList || mediaList.length === 0) {
        return reply('*🔍 No media found at this URL.*');
      }

      // 🔧 Filter out duplicates
      const uniqueUrls = new Set();
      const uniqueMedia = [];

      for (const media of mediaList) {
        if (media?.url && !uniqueUrls.has(media.url)) {
          uniqueUrls.add(media.url);
          uniqueMedia.push(media);
        }
      }

      await m.react('✅');

      for (let i = 0; i < uniqueMedia.length; i++) {
        const media = uniqueMedia[i];
        const isVideo = media.url.includes('.mp4');

        // 🚫 Reject if media is video
        if (isVideo) {
          return reply(`*🚫 This command is only for image posts. Video content like Reels is not supported.*`);
        }

        await client.sendMessage(m.chat, {
          image: { url: media.url },
          caption: `📥 *Downloaded via IG Downloader*\n_Media ${i + 1} of ${uniqueMedia.length}_\n_PIKO-BOT 🤖_`,
          fileName: `instagram_media_${i + 1}.jpg`,
          mimetype: 'image/jpeg'
        }, { quoted: m });
      }

    } catch (e) {
      console.error("IG command error:", e);
      await m.react('❌');
      reply('*🚫 Unexpected error occurred while downloading Instagram content.*');
    }
  }
);
