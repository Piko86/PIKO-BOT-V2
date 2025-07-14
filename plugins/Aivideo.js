const { cmd } = require("../command");
const axios = require("axios");

cmd(
  {
    pattern: "aivideoframes",
    react: "🎬",
    desc: "Generate AI Video from text prompt",
    category: "ai",
    filename: __filename,
  },
  async (
    robin,
    mek,
    m,
    { from, quoted, body, isCmd, command, args, q, isGroup, sender, reply }
  ) => {
    try {
      if (!q) return reply("*Please provide a description for the video you want to generate.* 🎬✨\n\n*Example:* .aivideo a cat playing with a ball");

      // Send loading message
      await reply("🎬 *Generating your AI video...* ⏳\n*Creating animated sequence...*");

      // Clean and prepare the prompt
      const prompt = q.trim();
      
      // Generate a series of images for video-like effect
      const frames = [];
      const numFrames = 6;
      
      // Different motion keywords for each frame
      const motionKeywords = [
        "beginning scene",
        "slight movement", 
        "more motion",
        "peak action",
        "settling down",
        "final scene"
      ];

      for (let i = 0; i < numFrames; i++) {
        try {
          const framePrompt = encodeURIComponent(`${prompt}, ${motionKeywords[i]}, cinematic, high quality`);
          const imageUrl = `https://image.pollinations.ai/prompt/${framePrompt}?width=512&height=512&seed=${1000 + i}&enhance=true`;
          
          const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
          });

          if (response.data) {
            frames.push(response.data);
          }
        } catch (frameError) {
          console.log(`Frame ${i + 1} generation failed:`, frameError.message);
        }
        
        // Small delay between requests
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      if (frames.length > 0) {
        const caption = `🎬 *AI VIDEO SEQUENCE* 🎬

🎯 *Prompt*: ${prompt}
📸 *Frames*: ${frames.length} generated
📐 *Quality*: 512x512 HD
🎭 *Style*: Cinematic sequence
🤖 *Engine*: Pollinations AI

𝐌𝐚𝐝𝐞 𝐛𝐲 *P_I_K_O* ☯️

*Sending video sequence frames...*`;

        await reply(caption);

        // Send frames as a sequence with timing
        for (let i = 0; i < frames.length; i++) {
          await robin.sendMessage(
            from,
            {
              image: frames[i],
              caption: `🎬 *Frame ${i + 1}/${frames.length}*\n${motionKeywords[i]}\n\n*${prompt}*`
            },
            { quoted: mek }
          );
          
          // Quick succession for video-like effect
          if (i < frames.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        }

        reply("*Your AI video sequence is complete!* 🎬💜");
      } else {
        throw new Error("Failed to generate video frames");
      }

    } catch (e) {
      console.error("AI Video Generation Error:", e);
      reply(`❌ *Error generating video:* ${e.message}\n\n*Try using .imagine for single AI images instead.*`);
    }
  }
);

// More reliable GIF-style animation
cmd(
  {
    pattern: "aigifframes",
    react: "🎭",
    desc: "Generate AI animated sequence from text prompt",
    category: "ai",
    filename: __filename,
  },
  async (
    robin,
    mek,
    m,
    { from, quoted, body, isCmd, command, args, q, isGroup, sender, reply }
  ) => {
    try {
      if (!q) return reply("*Please provide a description for the animation you want to generate.* 🎭✨\n\n*Example:* .aigif dancing robot with neon lights");

      await reply("🎭 *Creating your AI animation...* ⏳\n*Generating motion sequence...*");

      const prompt = q.trim();
      
      // Generate 4 frames with motion variations
      const animationFrames = [
        `${prompt}, pose 1, starting position`,
        `${prompt}, pose 2, mid motion`, 
        `${prompt}, pose 3, peak movement`,
        `${prompt}, pose 4, return position`
      ];

      const frames = [];

      for (let i = 0; i < animationFrames.length; i++) {
        try {
          const framePrompt = encodeURIComponent(animationFrames[i]);
          const imageUrl = `https://image.pollinations.ai/prompt/${framePrompt}?width=512&height=512&seed=${2000 + i * 10}`;
          
          const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            timeout: 25000,
          });

          if (response.data) {
            frames.push({
              data: response.data,
              pose: `Pose ${i + 1}`
            });
          }
        } catch (frameError) {
          console.log(`Animation frame ${i + 1} failed:`, frameError.message);
        }
        
        await new Promise(resolve => setTimeout(resolve, 1800));
      }

      if (frames.length > 0) {
        const caption = `🎭 *AI ANIMATION SEQUENCE* 🎭

🎯 *Prompt*: ${prompt}
🎬 *Animation*: ${frames.length} poses
📐 *Quality*: 512x512
🎨 *Style*: Motion sequence
⚡ *Speed*: Fast playback

𝐌𝐚𝐝𝐞 𝐛𝐲 *P_I_K_O* ☯️

*Playing animation sequence...*`;

        await reply(caption);

        // Send animation frames rapidly for GIF-like effect
        for (let i = 0; i < frames.length; i++) {
          await robin.sendMessage(
            from,
            {
              image: frames[i].data,
              caption: `🎭 *${frames[i].pose}*\n*${prompt}*`
            },
            { quoted: mek }
          );
          
          // Very quick succession for animation effect
          if (i < frames.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 800));
          }
        }

        // Send all frames again quickly for loop effect
        await new Promise(resolve => setTimeout(resolve, 2000));
        reply("🔄 *Playing animation loop...*");
        
        for (let i = 0; i < frames.length; i++) {
          await robin.sendMessage(
            from,
            {
              image: frames[i].data,
              caption: `🔄 *Loop ${frames[i].pose}*`
            },
            { quoted: mek }
          );
          
          await new Promise(resolve => setTimeout(resolve, 600));
        }

        reply("*Your AI animation is complete!* 🎭💙");
      } else {
        throw new Error("Failed to generate animation frames");
      }

    } catch (e) {
      console.error("AI Animation Error:", e);
      reply(`❌ *Error creating animation:* ${e.message}\n\n*Please try a different prompt.*`);
    }
  }
);

// Simple and reliable slideshow
cmd(
  {
    pattern: "aislideshow",
    react: "📽️",
    desc: "Generate slideshow from text prompt",
    category: "ai",
    filename: __filename,
  },
  async (
    robin,
    mek,
    m,
    { from, quoted, body, isCmd, command, args, q, isGroup, sender, reply }
  ) => {
    try {
      if (!q) return reply("*Please provide a theme for your slideshow.* 📽️✨\n\n*Example:* .slideshow beautiful sunset landscapes");

      await reply("📽️ *Creating your slideshow...* ⏳\n*Generating themed images...*");

      const theme = q.trim();
      const slides = [];
      
      // Different perspectives for slideshow variety
      const perspectives = [
        "wide panoramic view",
        "close-up detailed shot",
        "artistic angle", 
        "dramatic perspective",
        "cinematic composition"
      ];

      for (let i = 0; i < perspectives.length; i++) {
        try {
          const slidePrompt = encodeURIComponent(`${theme}, ${perspectives[i]}, professional photography, high quality`);
          const imageUrl = `https://image.pollinations.ai/prompt/${slidePrompt}?width=1024&height=576&seed=${3000 + i * 50}`;
          
          const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
          });

          if (response.data) {
            slides.push({
              data: response.data,
              title: perspectives[i].charAt(0).toUpperCase() + perspectives[i].slice(1)
            });
          }
        } catch (slideError) {
          console.log(`Slide ${i + 1} generation failed:`, slideError.message);
        }
        
        await new Promise(resolve => setTimeout(resolve, 2500));
      }

      if (slides.length > 0) {
        const slideshowCaption = `📽️ *AI SLIDESHOW PRESENTATION* 📽️

🎯 *Theme*: ${theme}
📸 *Slides*: ${slides.length} images
📐 *Quality*: HD (1024x576)
🎨 *Style*: Professional photography
🎬 *Format*: Slideshow presentation

𝐌𝐚𝐝𝐞 𝐛𝐲 *P_I_K_O* ☯️

*Starting slideshow presentation...*`;

        await reply(slideshowCaption);

        // Present slideshow with proper timing
        for (let i = 0; i < slides.length; i++) {
          await robin.sendMessage(
            from,
            {
              image: slides[i].data,
              caption: `📽️ *Slide ${i + 1}/${slides.length}*\n\n🎬 *${slides[i].title}*\n📝 *Theme: ${theme}*\n\n*Professional AI Photography*`
            },
            { quoted: mek }
          );
          
          // Slideshow timing
          if (i < slides.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 4000));
          }
        }

        reply("*Slideshow presentation complete!* 📽️💜\n*Thank you for watching!*");
      } else {
        throw new Error("Failed to generate slideshow images");
      }

    } catch (e) {
      console.error("Slideshow Error:", e);
      reply(`❌ *Error creating slideshow:* ${e.message}\n\n*Please try a different theme.*`);
    }
  }
);

// Quick video preview (most reliable)
cmd(
  {
    pattern: "vidpreview",
    react: "🎥",
    desc: "Generate quick video preview from text",
    category: "ai", 
    filename: __filename,
  },
  async (
    robin,
    mek,
    m,
    { from, quoted, body, isCmd, command, args, q, isGroup, sender, reply }
  ) => {
    try {
      if (!q) return reply("*Provide a description for video preview.* 🎥✨\n\n*Example:* .vidpreview flying eagle over mountains");

      await reply("🎥 *Generating video preview...* ⏳");

      const prompt = q.trim();
      
      // Generate 3 key frames for preview
      const keyFrames = [
        `${prompt}, opening shot, cinematic`,
        `${prompt}, main action, dynamic`,
        `${prompt}, closing shot, cinematic`
      ];

      const previews = [];

      for (let i = 0; i < keyFrames.length; i++) {
        try {
          const framePrompt = encodeURIComponent(keyFrames[i]);
          const imageUrl = `https://image.pollinations.ai/prompt/${framePrompt}?width=854&height=480&seed=${4000 + i * 100}`;
          
          const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            timeout: 25000,
          });

          if (response.data) {
            previews.push({
              data: response.data,
              scene: ['Opening', 'Main Action', 'Closing'][i]
            });
          }
        } catch (error) {
          console.log(`Preview frame ${i + 1} failed:`, error.message);
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      if (previews.length > 0) {
        const previewCaption = `🎥 *VIDEO PREVIEW GENERATED* 🎥

🎬 *Concept*: ${prompt}
📹 *Scenes*: ${previews.length} key frames
📐 *Quality*: HD (854x480)
🎭 *Style*: Cinematic preview
⚡ *Type*: Quick preview

𝐌𝐚𝐝𝐞 𝐛𝐲 *P_I_K_O* ☯️

*Showing video preview...*`;

        await reply(previewCaption);

        for (let i = 0; i < previews.length; i++) {
          await robin.sendMessage(
            from,
            {
              image: previews[i].data,
              caption: `🎥 *${previews[i].scene} Scene*\n\n🎬 ${prompt}\n📹 *Preview ${i + 1}/${previews.length}*`
            },
            { quoted: mek }
          );
          
          if (i < previews.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 2500));
          }
        }

        reply("*Video preview complete!* 🎥💙\n*Use .aivideo for full sequence.*");
      } else {
        throw new Error("Failed to generate preview frames");
      }

    } catch (e) {
      console.error("Video Preview Error:", e);
      reply(`❌ *Error:* ${e.message}\n\n*Try .imagine for single images.*`);
    }
  }
);
