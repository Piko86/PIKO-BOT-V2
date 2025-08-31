const { cmd } = require("../command");
const axios = require("axios");

cmd(
  {
    pattern: "imagine",
    react: "🎨",
    desc: "Generate AI Images from Text Prompts",
    category: "ai",
    filename: __filename,
  },
  async (robin, mek, m, { from, q, reply }) => {
    try {
      if (!q) return reply("*Provide a description for the image you want to generate.* 🎨");

      // Send initial message
      await reply("🎨 *Generating your AI image...* ⏳\n\n*This may take a few moments.*");

      // Clean and encode the prompt
      const prompt = encodeURIComponent(q.trim());
      
      // Generate image using Pollinations.ai (Free API)
      const generateImage = async (prompt) => {
        // Pollinations.ai free endpoint
        const imageUrl = `https://image.pollinations.ai/prompt/${prompt}?width=1024&height=1024&nologo=true&enhance=true`;
        
        // Download the generated image
        const response = await axios.get(imageUrl, {
          responseType: "arraybuffer",
          timeout: 60000, // 60 seconds timeout
        });

        if (response.status !== 200) {
          throw new Error("Failed to generate image");
        }

        return {
          buffer: response.data,
          url: imageUrl
        };
      };

      // Generate the image
      const image = await generateImage(prompt);

      // Image info message
      const desc = `🎨 *PIKO AI IMAGE GENERATOR* 🎨

🖼️ *Prompt* : ${q}
⚡ *Engine* : Pollinations AI
🎯 *Resolution* : 1024x1024
🔗 *Direct Link* : ${image.url}

𝐌𝐚𝐝𝐞 𝐛𝐲 *P_I_K_O* ☯️`;

      // Send the generated image
      await robin.sendMessage(
        from,
        {
          image: image.buffer,
          caption: desc,
        },
        { quoted: mek }
      );

      reply("*Your AI masterpiece is ready!* 🎨✨");

    } catch (e) {
      console.error("AI Image Generation Error:", e);
      
      // Handle specific error cases
      if (e.code === 'ECONNABORTED' || e.message.includes('timeout')) {
        reply("⏰ *Request timed out.* The AI service might be busy. Please try again in a moment.");
      } else if (e.response && e.response.status === 429) {
        reply("🚫 *Rate limit reached.* Please wait a moment before generating another image.");
      } else {
        reply(`❌ *Error generating image:* ${e.message}\n\nPlease try with a different prompt or try again later.`);
      }
    }
  }
);
