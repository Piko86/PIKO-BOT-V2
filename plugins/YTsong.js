const { cmd, commands } = require("../command");
const yts = require("yt-search");
const ytdl = require("ytdl-core");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const ffmpeg = require("fluent-ffmpeg");

// Helper function to format duration
function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

// Helper function to convert bytes to readable format
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

cmd(
  {
    pattern: "song",
    react: "🎶",
    desc: "Download Song from YouTube",
    category: "download",
    filename: __filename,
  },
  async (
    robin,
    mek,
    m,
    {
      from,
      quoted,
      body,
      isCmd,
      command,
      args,
      q,
      isGroup,
      sender,
      senderNumber,
      botNumber2,
      botNumber,
      pushname,
      isMe,
      isOwner,
      groupMetadata,
      groupName,
      participants,
      groupAdmins,
      isBotAdmins,
      isAdmins,
      reply,
    }
  ) => {
    try {
      // Validate input
      if (!q) {
        return reply("*Please provide a song name or YouTube URL* 🎵\n\nExample: `.song Despacito`");
      }

      // Send initial processing message
      await reply("🔍 *Searching for your song...*");

      let videoUrl;
      let videoData;

      // Check if input is a YouTube URL
      if (q.includes("youtube.com") || q.includes("youtu.be")) {
        videoUrl = q;
        try {
          const info = await ytdl.getInfo(videoUrl);
          videoData = {
            title: info.videoDetails.title,
            description: info.videoDetails.description?.substring(0, 100) + "..." || "No description",
            duration: {
              seconds_total: parseInt(info.videoDetails.lengthSeconds),
              timestamp: formatDuration(parseInt(info.videoDetails.lengthSeconds))
            },
            ago: info.videoDetails.publishDate || "Unknown",
            views: parseInt(info.videoDetails.viewCount).toLocaleString(),
            url: videoUrl,
            thumbnail: info.videoDetails.thumbnails[info.videoDetails.thumbnails.length - 1].url,
            author: {
              name: info.videoDetails.author.name
            }
          };
        } catch (error) {
          return reply("❌ *Invalid YouTube URL or video not accessible*");
        }
      } else {
        // Search for the song
        const search = await yts(q);
        if (!search.videos || search.videos.length === 0) {
          return reply("❌ *No songs found for your search query*");
        }
        
        videoData = search.videos[0];
        videoUrl = videoData.url;
      }

      // Validate video duration (limit: 10 minutes for better performance)
      const maxDuration = 600; // 10 minutes in seconds
      if (videoData.duration?.seconds_total > maxDuration) {
        return reply(`⏱️ *Song is too long!*\n\n📝 Duration: ${videoData.duration.timestamp}\n⚠️ Maximum allowed: 10 minutes\n\nPlease try a shorter song.`);
      }

      // Create song info message
      let desc = `
🎵 *PIKO MUSIC DOWNLOADER* 🎵

📝 *Title:* ${videoData.title}
👤 *Channel:* ${videoData.author?.name || 'Unknown'}
⏱️ *Duration:* ${videoData.duration?.timestamp || 'Unknown'}
👀 *Views:* ${videoData.views || 'Unknown'}
📅 *Published:* ${videoData.ago || 'Unknown'}
🔗 *URL:* ${videoData.url}

⬇️ *Downloading audio...*

*Made by P_I_K_O* 💜
`;

      // Send thumbnail with info
      await robin.sendMessage(
        from,
        { 
          image: { url: videoData.thumbnail }, 
          caption: desc 
        },
        { quoted: mek }
      );

      // Download and convert audio
      const tempDir = path.join(__dirname, 'temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const fileName = `${Date.now()}_${videoData.title.replace(/[^\w\s]/gi, '').substring(0, 50)}`;
      const audioPath = path.join(tempDir, `${fileName}.mp3`);

      // Download audio using ytdl-core
      const audioStream = ytdl(videoUrl, {
        filter: 'audioonly',
        quality: 'highestaudio',
        format: 'mp4'
      });

      // Convert to MP3 using ffmpeg
      await new Promise((resolve, reject) => {
        ffmpeg(audioStream)
          .audioBitrate(128)
          .format('mp3')
          .on('error', (err) => {
            console.error('FFmpeg error:', err);
            reject(err);
          })
          .on('end', () => {
            resolve();
          })
          .save(audioPath);
      });

      // Check if file was created successfully
      if (!fs.existsSync(audioPath)) {
        throw new Error('Failed to create audio file');
      }

      const fileStats = fs.statSync(audioPath);
      const fileSize = formatFileSize(fileStats.size);

      // Send audio file
      await robin.sendMessage(
        from,
        {
          audio: fs.readFileSync(audioPath),
          mimetype: "audio/mpeg",
          ptt: false,
          contextInfo: {
            externalAdReply: {
              title: videoData.title,
              body: `Duration: ${videoData.duration?.timestamp} | Size: ${fileSize}`,
              thumbnailUrl: videoData.thumbnail,
              mediaType: 2,
              mediaUrl: videoData.url,
              sourceUrl: videoData.url
            }
          }
        },
        { quoted: mek }
      );

      // Send as document (backup)
      await robin.sendMessage(
        from,
        {
          document: fs.readFileSync(audioPath),
          mimetype: "audio/mpeg",
          fileName: `${videoData.title.substring(0, 50)}.mp3`,
          caption: `🎵 *${videoData.title}*\n\n📊 *Size:* ${fileSize}\n⏱️ *Duration:* ${videoData.duration?.timestamp}\n\n*Made by P_I_K_O* 💜`,
        },
        { quoted: mek }
      );

      // Clean up temporary file
      setTimeout(() => {
        if (fs.existsSync(audioPath)) {
          fs.unlinkSync(audioPath);
        }
      }, 30000); // Delete after 30 seconds

      return reply("✅ *DOWNLOAD COMPLETED SUCCESSFULLY!*");

    } catch (error) {
      console.error('Song download error:', error);
      
      // Clean up any temporary files on error
      const tempDir = path.join(__dirname, 'temp');
      if (fs.existsSync(tempDir)) {
        const files = fs.readdirSync(tempDir);
        files.forEach(file => {
          const filePath = path.join(tempDir, file);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        });
      }

      let errorMessage = "❌ *Download failed!*\n\n";
      
      if (error.message.includes('Video unavailable')) {
        errorMessage += "🚫 *Video is not available or private*";
      } else if (error.message.includes('age-restricted')) {
        errorMessage += "🔞 *Video is age-restricted*";
      } else if (error.message.includes('copyright')) {
        errorMessage += "⚖️ *Video has copyright restrictions*";
      } else if (error.message.includes('network')) {
        errorMessage += "🌐 *Network connection error*";
      } else {
        errorMessage += `🔧 *Error:* ${error.message}`;
      }
      
      errorMessage += "\n\n💡 *Try:*\n• Different search terms\n• Another song\n• Check your internet connection";
      
      return reply(errorMessage);
    }
  }
);
