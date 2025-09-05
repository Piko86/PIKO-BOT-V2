/**
 * plugins/video2mp3.js
 *
 * Command: .video2mp3 (with a video file attachment)
 * - Extracts audio from an uploaded video and converts it to MP3 format.
 * - Supports common video formats (e.g., MP4, MKV).
 *
 * Requirements:
 * - ffmpeg must be installed and available in the system PATH.
 *
 * Usage:
 * - Send a video file to the bot with the caption ".video2mp3".
 *
 * Dependencies:
 * - ffmpeg
 */

const { cmd } = require("../command");
const path = require("path");
const fs = require("fs-extra");
const { exec } = require("child_process");

cmd(
  {
    pattern: "tomp3",
    react: "🎵",
    desc: "Convert a video attachment to MP3 audio.",
    category: "conversion",
    filename: __filename,
  },
  async (robin, mek, m, { from, reply, quoted, sender }) => {
    try {
      // Ensure the user has sent a video file along with the command
      if (!quoted || !quoted.message || !quoted.message.videoMessage) {
        return reply("❌ Please reply to a video file with the command '.video2mp3'.");
      }

      const videoMessage = quoted.message.videoMessage;
      const mediaKey = videoMessage.mediaKey;
      const mimeType = videoMessage.mimetype;

      if (!mediaKey || !mimeType || !mimeType.startsWith("video/")) {
        return reply("❌ The replied message is not a valid video file.");
      }

      const tempDir = path.join(__dirname, "..", "temp");
      const videoPath = path.join(tempDir, `${Date.now()}_input.mp4`);
      const outputPath = path.join(tempDir, `${Date.now()}_output.mp3`);

      // Ensure temp directory exists
      if (!(await fs.pathExists(tempDir))) await fs.ensureDir(tempDir);

      // Download the video file
      const videoStream = await robin.downloadAndSaveMediaMessage(quoted, videoPath);

      if (!videoStream) {
        return reply("❌ Failed to download the video file. Please try again.");
      }

      reply("⏳ Converting video to MP3. Please wait...");

      // Convert video to MP3 using ffmpeg
      const ffmpegCmd = `ffmpeg -i "${videoPath}" -b:a 192K -vn "${outputPath}"`;
      exec(ffmpegCmd, async (error, stdout, stderr) => {
        // Cleanup the video file after conversion
        await fs.remove(videoPath);

        if (error) {
          console.error("ffmpeg error:", error);
          return reply(`❌ Failed to convert the video to MP3. Error:\n${stderr}`);
        }

        if (!(await fs.pathExists(outputPath))) {
          return reply("❌ Conversion failed. MP3 file was not created.");
        }

        const fileSize = (await fs.stat(outputPath)).size;
        const maxSize = 50 * 1024 * 1024; // 50 MB limit
        if (fileSize > maxSize) {
          reply(
            "❌ The converted MP3 file is too large to send. Please try a shorter video or a smaller file."
          );
          await fs.remove(outputPath);
          return;
        }

        const fileBuffer = await fs.readFile(outputPath);
        const fileName = `audio_${Date.now()}.mp3`;

        try {
          await robin.sendMessage(
            from,
            {
              document: fileBuffer,
              mimetype: "audio/mpeg",
              fileName,
              caption: "🎵 Here's your MP3 audio file.",
            },
            { quoted: mek }
          );
        } catch (e) {
          console.error("Error sending MP3 file:", e);
          reply("❌ Failed to send the MP3 file. Please try again.");
        } finally {
          // Cleanup the MP3 file
          await fs.remove(outputPath);
        }
      });
    } catch (error) {
      console.error("video2mp3 command error:", error);
      reply(`❌ An error occurred: ${error.message || error}`);
    }
  }
);

module.exports = {};
