const { cmd, commands } = require("../command");
const yts = require("yt-search");
const ytdl = require("ytdl-core");
const fs = require("fs");
const path = require("path");
const os = require("os");

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

// Helper function to sanitize filename
function sanitizeFilename(filename) {
  return filename
    .replace(/[^\w\s-]/g, '') // Remove special characters
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .substring(0, 50); // Limit length
}

// Helper function to safely create directory
function ensureDirectoryExists(dirPath) {
  try {
    // First, check if path exists and what it is
    if (fs.existsSync(dirPath)) {
      const stats = fs.statSync(dirPath);
      if (!stats.isDirectory()) {
        // If it's a file, remove it first
        fs.unlinkSync(dirPath);
      }
    }
    
    // Create directory if it doesn't exist
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    
    return true;
  } catch (error) {
    console.error('Error creating directory:', error);
    return false;
  }
}

// Helper function to safely clean up files
function cleanupFiles(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      if (stats.isFile()) {
        fs.unlinkSync(filePath);
      }
    }
  } catch (error) {
    console.error('Error during cleanup:', error);
  }
}

// Helper function to get a safe temp directory
function getSafeTempDir() {
  const baseDir = os.tmpdir();
  const tempDir = path.join(baseDir, 'piko_bot_temp');
  
  if (ensureDirectoryExists(tempDir)) {
    return tempDir;
  }
  
  // Fallback to system temp
  return baseDir;
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
          // Validate URL first
          if (!ytdl.validateURL(videoUrl)) {
            return reply("❌ *Invalid YouTube URL*");
          }
          
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
          console.error('URL validation error:', error);
          return reply("❌ *Invalid YouTube URL or video not accessible*\n\n💡 Try searching by song name instead");
        }
      } else {
        // Search for the song
        try {
          const search = await yts(q);
          if (!search.videos || search.videos.length === 0) {
            return reply("❌ *No songs found for your search query*\n\n💡 Try different keywords");
          }
          
          videoData = search.videos[0];
          videoUrl = videoData.url;
          
          // Validate the found URL
          if (!ytdl.validateURL(videoUrl)) {
            return reply("❌ *Found video is not accessible*\n\n💡 Try a different search term");
          }
        } catch (error) {
          console.error('Search error:', error);
          return reply("❌ *Search failed*\n\n💡 Try again with different keywords");
        }
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

      // Get safe temp directory
      const tempDir = getSafeTempDir();
      const sanitizedTitle = sanitizeFilename(videoData.title);
      const fileName = `${Date.now()}_${sanitizedTitle}`;
      const audioPath = path.join(tempDir, `${fileName}.mp4`);

      // Download audio directly without FFmpeg conversion
      const audioStream = ytdl(videoUrl, {
        filter: 'audioonly',
        quality: 'highestaudio',
        format: 'mp4'
      });

      // Save the audio file
      const writeStream = fs.createWriteStream(audioPath);
      
      await new Promise((resolve, reject) => {
        audioStream.pipe(writeStream);
        
        audioStream.on('error', (err) => {
          console.error('Download error:', err);
          reject(err);
        });
        
        writeStream.on('finish', () => {
          resolve();
        });
        
        writeStream.on('error', (err) => {
          console.error('Write error:', err);
          reject(err);
        });
      });

      // Check if file was created successfully
      if (!fs.existsSync(audioPath)) {
        throw new Error('Failed to create audio file');
      }

      const fileStats = fs.statSync(audioPath);
      const fileSize = formatFileSize(fileStats.size);

      // Check file size (limit: 50MB for WhatsApp)
      if (fileStats.size > 50 * 1024 * 1024) {
        cleanupFiles(audioPath);
        return reply("📁 *File too large for WhatsApp*\n\n⚠️ Maximum size: 50MB\n💡 Try a shorter song");
      }

      // Send audio file
      await robin.sendMessage(
        from,
        {
          audio: fs.readFileSync(audioPath),
          mimetype: "audio/mp4",
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
          mimetype: "audio/mp4",
          fileName: `${sanitizedTitle}.mp4`,
          caption: `🎵 *${videoData.title}*\n\n📊 *Size:* ${fileSize}\n⏱️ *Duration:* ${videoData.duration?.timestamp}\n\n*Made by P_I_K_O* 💜`,
        },
        { quoted: mek }
      );

      // Clean up temporary file after a delay
      setTimeout(() => {
        cleanupFiles(audioPath);
      }, 30000); // Delete after 30 seconds

      return reply("✅ *DOWNLOAD COMPLETED SUCCESSFULLY!*");

    } catch (error) {
      console.error('Song download error:', error);
      
      let errorMessage = "❌ *Download failed!*\n\n";
      
      if (error.message.includes('Video unavailable') || error.statusCode === 410) {
        errorMessage += "🚫 *Video is not available, private, or has been removed*";
      } else if (error.message.includes('age-restricted')) {
        errorMessage += "🔞 *Video is age-restricted*";
      } else if (error.message.includes('copyright')) {
        errorMessage += "⚖️ *Video has copyright restrictions*";
      } else if (error.message.includes('network') || error.code === 'ENOTFOUND') {
        errorMessage += "🌐 *Network connection error*";
      } else if (error.statusCode === 403) {
        errorMessage += "🔒 *Access denied - video may be restricted*";
      } else if (error.code === 'ENOTDIR' || error.code === 'ENOENT') {
        errorMessage += "📁 *File system error - trying again may help*";
      } else {
        errorMessage += `🔧 *Error:* ${error.message}`;
      }
      
      errorMessage += "\n\n💡 *Try:*\n• Different search terms\n• Another song\n• Check your internet connection\n• Try again in a few minutes";
      
      return reply(errorMessage);
    }
  }
);
