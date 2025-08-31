const { cmd } = require("../command");
const axios = require("axios");

cmd(
  {
    pattern: "imagine",
    react: "🖼️",
    desc: "Generate AI Image from Text Prompt",
    category: "tools",
    filename: __filename,
  },
  async (robin, mek, m, { from, q, reply }) => {
    try {
      if (!q) return reply("Please provide a text prompt to generate an image.");

      // Call Pollinations.AI API to generate image
      const response = await axios.get(`https://api.pollinations.ai/v1/generate?text=${encodeURIComponent(q)}`);
      const imageUrl = response.data.image_url;

      if (!imageUrl) {
        return reply("Failed to generate image. Please try again.");
      }

      // Send the generated image
      await robin.sendMessage(
        from,
        { image: { url: imageUrl }, caption: `🖼️ Generated Image for: "${q}"` },
        { quoted: mek }
      );
    } catch (error) {
      console.error(error);
      reply("An error occurred while generating the image. Please try again later.");
    }
  }
);
