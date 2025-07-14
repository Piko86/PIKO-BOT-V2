const { cmd } = require('../command');
const { igdl } = require('ruhend-scraper');

cmd(
  {
    pattern: 'igvideo',
    desc: 'Download Instagram videos',
    category: 'download',
    filename: __filename,
  },
  async (
    client,
    m,
    mek,
    { q, reply }
  ) => {
    try {
      if (!q || !q.includes("instagram.com")) {
        return reply('*🚫 Please provide a valid Instagram URL.*');
      }

      // ❌ Reject Reels, Stories, and Highlights
      const lowerUrl = q.toLowerCase();
      if (lowerUrl.includes('/p/') || lowerUrl.includes('/stories/') || lowerUrl.includes('/highlights/')) {
        return reply('*🚫 This command only supports Instagram reels. Post, Stories, and Highlights are not allowed.*');
      }

      await m.react('⏳');
      let result;
      try {
        result = await igdl(q);
      } catch (err) {
        console.error("Scraper error:", err);
        return reply('*❌ Failed to fetch data. Instagram may have changed or the link is private.*');
      }

      if (!result?.data || result.data.length === 0) {
        return reply('*🔍 No media found for this link.*');
      }

      // Try to find the best available resolution
      const video = result.data.find(v => v.url?.includes("http"));
      if (!video) {
        return reply('*⚠️ No downloadable video found.*');
      }

      await m.react('✅');
      await client.sendMessage(m.chat, {
        video: { url: video.url },
        caption: '📥 *Downloaded via IG Downloader*\n_PIKO-BOT 🤖_',
        fileName: 'instagram_video.mp4',
        mimetype: 'video/mp4'
      }, { quoted: m });
    } catch (e) {
      console.error("IG command error:", e);
      await m.react('❌');
      reply('*🚫 Unexpected error occurred while downloading.*');
    }
  }
);
