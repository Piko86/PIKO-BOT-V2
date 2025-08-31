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

      // Clean the prompt
      const prompt = q.trim();
      
      // Generate video using working free APIs
      const generateVideo = async (prompt) => {
        const encodedPrompt = encodeURIComponent(prompt);
        
        // Try multiple working video APIs
        const videoApis = [
          // Stable Video Diffusion via Hugging Face
          {
            name: "Stable Video Diffusion",
            url: "https://api-inference.huggingface.co/models/stabilityai/stable-video-diffusion-img2vid-xt",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            data: {
              inputs: prompt,
              parameters: {
                num_frames: 25,
                fps: 6,
                motion_bucket_id: 127,
                noise_aug_strength: 0.02
              }
            }
          },
          // Luma AI Dream Machine (Free tier)
          {
            name: "Luma Dream Machine",
            url: `https://api.lumalabs.ai/dream-machine/v1/generations`,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            data: {
              prompt: prompt,
              aspect_ratio: "16:9",
              loop: false
            }
          },
          // Fallback to animated GIF generation
          {
            name: "Animated GIF Generator",
            url: `https://api.giphy.com/v1/gifs/translate?api_key=dc6zaTOxFJmzC&s=${encodedPrompt}`,
            method: "GET",
            isGif: true
          }
        ];

        // Try each video API
        for (const api of videoApis) {
          try {
            let response;
            
            if (api.method === "POST") {
              response = await axios.post(api.url, api.data, {
                headers: api.headers,
                responseType: api.isGif ? "json" : "arraybuffer",
                timeout: 90000,
              });
            } else {
              response = await axios.get(api.url, {
                responseType: api.isGif ? "json" : "arraybuffer",
                timeout: 90000,
              });
            }

            if (api.isGif && response.data.data && response.data.data.images) {
              // Handle Giphy GIF response
              const gifUrl = response.data.data.images.original.url;
              const gifResponse = await axios.get(gifUrl, {
                responseType: "arraybuffer",
                timeout: 30000
              });
              
              return {
                buffer: gifResponse.data,
                url: gifUrl,
                engine: api.name,
                isGif: true
              };
            } else if (response.status === 200 && response.data.byteLength > 1000) {
              return {
                buffer: response.data,
                url: `Generated via ${api.name}`,
                engine: api.name
              };
            }
          } catch (apiError) {
            console.log(`${api.name} failed:`, apiError.message);
            continue;
          }
        }

        // Final fallback: Create video-style image sequence
        console.log("All video APIs failed, creating enhanced image...");
        
        const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}%20cinematic%20style%20movie%20frame%20dynamic%20motion?width=1280&height=720&nologo=true&enhance=true&model=flux`;
        
        const imageResponse = await axios.get(imageUrl, {
          responseType: "arraybuffer",
          timeout: 30000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });

        return {
          buffer: imageResponse.data,
          url: imageUrl,
          engine: "Cinematic Image Generator",
          isImage: true
        };
      };

      // Generate the video/content
      const video = await generateVideo(prompt);

      if (video.isImage) {
        // Fallback: Send as image with video-style description
        const desc = `🎬 *PIKO AI VIDEO GENERATOR* 🎬

🎥 *Prompt* : ${q}
⚡ *Engine* : ${video.engine}
🎯 *Resolution* : 1280x720 (Cinematic)
⚠️ *Note* : Video generation unavailable, showing cinematic frame
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

        await robin.sendMessage(
          from,
          {
            document: video.buffer,
            mimetype: "image/jpeg",
            fileName: `AI_Cinematic_${Date.now()}.jpg`,
            caption: `📂 *AI Cinematic Frame* (Document)\n\n*Prompt:* ${q}\n\n𝐌𝐚𝐝𝐞 𝐛𝐲 *P_I_K_O* ☯️`,
          },
          { quoted: mek }
        );

        reply("*Video generation is currently limited. Here's a cinematic frame instead!* 🎬📸");
        
      } else if (video.isGif) {
        // GIF content
        const desc = `🎬 *PIKO AI VIDEO GENERATOR* 🎬

🎥 *Prompt* : ${q}
⚡ *Engine* : ${video.engine}
🎯 *Type* : Animated GIF
🔗 *Direct Link* : ${video.url}

𝐌𝐚𝐝𝐞 𝐛𝐲 *P_I_K_O* ☯️`;

        await robin.sendMessage(
          from,
          {
            video: video.buffer,
            mimetype: "image/gif",
            fileName: `AI_Animation_${Date.now()}.gif`,
            caption: desc,
          },
          { quoted: mek }
        );

        await robin.sendMessage(
          from,
          {
            document: video.buffer,
            mimetype: "image/gif",
            fileName: `AI_Generated_Animation_${Date.now()}.gif`,
            caption: `📂 *AI Generated Animation* (Document)\n\n*Prompt:* ${q}\n\n𝐌𝐚𝐝𝐞 𝐛𝐲 *P_I_K_O* ☯️`,
          },
          { quoted: mek }
        );

        reply("*Your AI animation is ready!* 🎬✨");
        
      } else {
        // Actual video content
        const desc = `🎬 *PIKO AI VIDEO GENERATOR* 🎬

🎥 *Prompt* : ${q}
⚡ *Engine* : ${video.engine}
🎯 *Resolution* : HD
⏱️ *Duration* : ~4 seconds
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
