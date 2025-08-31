const { cmd } = require("../command");
const axios = require("axios");

cmd(
  {
    pattern: "aivideo",
    react: "🎬",
    desc: "Generate AI Videos from Text Prompts",
    category: "ai",
    filename: __filename,
  },
  async (robin, mek, m, { from, q, reply }) => {
    try {
      if (!q) return reply("*Provide a description for the video you want to generate.* 🎬");

      // Send initial message
      await reply("🎬 *Generating your AI video...* ⏳\n\n*This may take 30-60 seconds.*");

      // Clean and encode the prompt
      const prompt = q.trim();
      
      // Generate video using free API
      const generateVideo = async (prompt) => {
        // Using a free video generation API
        const apiUrl = "https://api.runwayml.com/v1/generate";
        
        const requestData = {
          prompt: prompt,
          duration: 4, // 4 seconds
          resolution: "720p",
          fps: 24
        };

        // Alternative free endpoint (Pollinations-style for video)
        const videoUrl = `https://video.pollinations.ai/prompt/${encodeURIComponent(prompt)}?duration=4&fps=24&width=720&height=720`;
        
        try {
          // Try direct video generation
          const response = await axios.get(videoUrl, {
            responseType: "arraybuffer",
            timeout: 90000, // 90 seconds timeout for video
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
          });

          if (response.status !== 200) {
            throw new Error("Failed to generate video");
          }

          return {
            buffer: response.data,
            url: videoUrl
          };
        } catch (error) {
          // Fallback to image-to-video conversion
          const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=720&height=720&nologo=true`;
          
          // Create a simple video from static image (fallback)
          const imageResponse = await axios.get(imageUrl, {
            responseType: "arraybuffer",
            timeout: 30000
          });

          // For now, we'll send the image as fallback
          // In a real implementation, you'd convert image to video
          return {
            buffer: imageResponse.data,
            url: imageUrl,
            isImage: true
          };
        }
      };

      // Generate the video
      const video = await generateVideo(prompt);

      if (video.isImage) {
        // Fallback: Send as image with explanation
        const desc = `🎬 *PIKO AI VIDEO GENERATOR* 🎬

🎥 *Prompt* : ${q}
⚡ *Engine* : Pollinations AI
🎯 *Resolution* : 720x720
⚠️ *Note* : Video generation unavailable, showing preview image
🔗 *Direct Link* : ${video.url}

𝐌𝐚𝐝𝐞 𝐛𝐲 *P_I_K_O* ☯️`;

        await robin.sendMessage(
          from,
          {
            image: video.buffer,
            caption: desc,
          },
          { quoted: mek }
        );

        reply("*Video generation is currently limited. Here's a preview image instead!* 🎬📸");
      } else {
        // Video info message
        const desc = `🎬 *PIKO AI VIDEO GENERATOR* 🎬

🎥 *Prompt* : ${q}
⚡ *Engine* : AI Video Generator
🎯 *Resolution* : 720p
⏱️ *Duration* : 4 seconds
🔗 *Direct Link* : ${video.url}

𝐌𝐚𝐝𝐞 𝐛𝐲 *P_I_K_O* ☯️`;

        // Send the generated video
        await robin.sendMessage(
          from,
          {
            video: video.buffer,
            mimetype: "video/mp4",
            fileName: `AI_Video_${Date.now()}.mp4`,
            caption: desc,
          },
          { quoted: mek }
        );

        // Send as document for download
        await robin.sendMessage(
          from,
          {
            document: video.buffer,
            mimetype: "video/mp4",
            fileName: `AI_Generated_Video_${Date.now()}.mp4`,
            caption: `📂 *AI Generated Video* (Document)\n\n*Prompt:* ${q}\n\n𝐌𝐚𝐝𝐞 𝐛𝐲 *P_I_K_O* ☯️`,
          },
          { quoted: mek }
        );

        reply("*Your AI video is ready!* 🎬✨");
      }

    } catch (e) {
      console.error("AI Video Generation Error:", e);
      
      // Handle specific error cases
      if (e.code === 'ECONNABORTED' || e.message.includes('timeout')) {
        reply("⏰ *Request timed out.* Video generation takes time. Please try again with a shorter prompt.");
      } else if (e.response && e.response.status === 429) {
        reply("🚫 *Rate limit reached.* Please wait a moment before generating another video.");
      } else if (e.response && e.response.status === 503) {
        reply("🔧 *Service temporarily unavailable.* The AI video service might be under maintenance.");
      } else {
        reply(`❌ *Error generating video:* ${e.message}\n\nPlease try with a different prompt or try again later.`);
      }
    }
  }
);
