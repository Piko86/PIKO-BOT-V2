const { cmd } = require("../command");
const { downloadMediaMessage } = require("../lib/msg.js"); // Adjust the path as needed

cmd(
  {
    pattern: "vv",
    alias: ["savevo", "vo2img"],
    react: "👁‍🗨",
    desc: "Convert a View Once image/video to a normal message",
    category: "utility",
    filename: __filename,
  },
  async (
    robin,
    mek,
    m,
    {
      from,
      quoted,
      reply,
    }
  ) => {
    try {
      // Ensure the message is a quoted view-once image or video
      if (
        !quoted ||
        !(
          (quoted.imageMessage && quoted.imageMessage.viewOnce) ||
          (quoted.videoMessage && quoted.videoMessage.viewOnce)
        )
      ) {
        return reply(
          "*Please reply to a View Once image or video message to save it as normal.* 🧧"
        );
      }

      // Download the media
      const media = await downloadMediaMessage(quoted, "viewOnceInput");
      if (!media) return reply("Failed to download the media. Try again!❌");

      // Send as normal image or video
      if (quoted.imageMessage) {
        await robin.sendMessage(
          from,
          { image: media, caption: "Here is your saved image.💜" },
          { quoted: mek }
        );
      } else if (quoted.videoMessage) {
        await robin.sendMessage(
          from,
          { video: media, caption: "Here is your saved video.💜" },
          { quoted: mek }
        );
      }
    } catch (e) {
      console.error(e);
      reply(`Error: ${e.message || e}`);
    }
  }
);
