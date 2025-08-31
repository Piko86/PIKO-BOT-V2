const { cmd } = require("../command");
const axios = require("axios");

async function fetchAIImage(prompt) {
  const encodedPrompt = encodeURIComponent(prompt.trim());
  const url = `https://subnp.com/api/v1/generate-image?prompt=${encodedPrompt}&width=1024&height=1024`;

  try {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    if (response.data) {
      return response.data;
    } else {
      throw new Error("No image data received");
    }
  } catch (error) {
    throw new Error(`Image generation failed: ${error.message}`);
  }
}

cmd(
  {
    pattern: "imagine",
    react: "🎨",
    desc: "Generate AI Image from text prompt",
    category: "ai",
    filename: __filename,
  },
  async (robin, mek, m, { from, quoted, body, isCmd, command, args, q, isGroup, sender, reply }) => {
    if (!q) return reply("Please provide a description for the image you want to generate. 🎨✨");

    await reply("🎨 Generating your AI image... ⏳");

    try {
      const imageData = await fetchAIImage(q);

      const caption = `🎨 AI GENERATED IMAGE 🎨\n\n✨ Prompt: ${q}\n🤖 Powered by: SubNP AI\n⚡ Resolution: 1024x1024`;

      await robin.sendMessage(
        from,
        { image: imageData, caption: caption },
        { quoted: mek }
      );

      reply("Your AI image has been generated successfully! 🎨💜");
    } catch (error) {
      console.error("AI Image Generation Error:", error);
      reply(`❌ Error generating image: ${error.message}`);
    }
  }
);
