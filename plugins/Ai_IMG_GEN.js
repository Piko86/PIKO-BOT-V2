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
      
      // Generate image using multiple free APIs with advanced prompt support
      const generateImage = async (prompt) => {
        const decodedPrompt = decodeURIComponent(prompt);
        
        // Try multiple free APIs for better results
        const apis = [
          // Hugging Face Inference API (Free)
          {
            name: "Stable Diffusion XL",
            url: "https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            data: {
              inputs: decodedPrompt,
              parameters: {
                negative_prompt: "blurry, bad quality, distorted, ugly",
                num_inference_steps: 20,
                guidance_scale: 7.5,
                width: 1024,
                height: 1024
              }
            }
          },
          // Backup API - Pollinations with better parameters
          {
            name: "Pollinations Enhanced",
            url: `https://image.pollinations.ai/prompt/${prompt}?width=1024&height=1024&nologo=true&enhance=true&model=flux`,
            method: "GET"
          },
          // Third option - Prodia (Free)
          {
            name: "Prodia AI",
            url: "https://api.prodia.com/v1/sd/generate",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            data: {
              prompt: decodedPrompt,
              model: "absolutereality_V16.safetensors [37db0fc3]",
              negative_prompt: "bad quality, blurry, low resolution",
              steps: 20,
              cfg_scale: 7,
              width: 1024,
              height: 1024,
              sampler: "DPM++ 2M Karras"
            }
          }
        ];

        // Try each API until one works
        for (const api of apis) {
          try {
            let response;
            
            if (api.method === "POST") {
              response = await axios.post(api.url, api.data, {
                headers: api.headers,
                responseType: "arraybuffer",
                timeout: 60000,
              });
            } else {
              response = await axios.get(api.url, {
                responseType: "arraybuffer",
                timeout: 60000,
              });
            }

            if (response.status === 200 && response.data.byteLength > 1000) {
              return {
                buffer: response.data,
                url: api.method === "GET" ? api.url : `Generated via ${api.name}`,
                engine: api.name
              };
            }
          } catch (apiError) {
            console.log(`${api.name} failed, trying next...`);
            continue;
          }
        }

        throw new Error("All image generation services are currently unavailable");
      };

      // Generate the image
      const image = await generateImage(prompt);

      // Image info message
      const desc = `🎨 *PIKO AI IMAGE GENERATOR* 🎨

🖼️ *Prompt* : ${q}
⚡ *Engine* : ${image.engine}
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

      // Send as document for download
      await robin.sendMessage(
        from,
        {
          document: image.buffer,
          mimetype: "image/png",
          fileName: `AI_Generated_${Date.now()}.png`,
          caption: `📂 *AI Generated Image* (Document)\n\n*Prompt:* ${q}\n\n𝐌𝐚𝐝𝐞 𝐛𝐲 *P_I_K_O* ☯️`,
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
