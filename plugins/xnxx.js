/**
 * plugins/xnxx.js
 *
 * .xnxx <query>        -> Search xnxx for videos and return a numbered list (reply-to-menu required)
 * (reply to list) 1..6 -> Bot downloads the selected video (using yt-dlp) and sends it as document/audio
 *
 * Requirements:
 *  - npm i axios cheerio uuid
 *  - yt-dlp installed on host and available in PATH (https://github.com/yt-dlp/yt-dlp)
 *
 * Notes:
 *  - This plugin scrapes xnxx search results to provide quick previews. Scraping can break if the site changes.
 *  - Downloading is done with yt-dlp CLI which supports many sites including xnxx. If yt-dlp is not installed the bot will return an actionable error.
 *  - Large videos may exceed WhatsApp limits. The plugin enforces a file size limit (env XNXX_MAX_FILE_MB, default 40 MB) and will send the remote URL if the downloaded file is larger.
 *  - Sessions are chat+user-scoped and expire after 8 minutes (same behavior as your menu).
 */

const { cmd } = require("../command");
const axios = require("axios");
const cheerio = require("cheerio");
const { v4: uuidv4 } = require("uuid");
const { spawn } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs").promises;
const fsSync = require("fs");

// In-memory session store (keyed by `${senderNumber}|${chatId}`)
const xnxxSession = new Map();
const SESSION_TTL = 8 * 60 * 1000; // 8 minutes

// Auto-cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, state] of xnxxSession) {
    if (!state || !state.timestamp || now - state.timestamp > SESSION_TTL) {
      xnxxSession.delete(key);
      console.log(`🧹 Cleaned xnxx session ${key}`);
    }
  }
}, 60 * 1000);

// Helper: build session key per user per chat
const makeSessionKey = (senderNumber, chatId) => `${senderNumber}|${chatId}`;

// Helper: safe axios with UA
const axiosClient = axios.create({
  timeout: 20000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml",
  },
});

// Search xnxx and return top N results
async function searchXnxx(query, maxResults = 6) {
  const url = `https://www.xnxx.com/?k=${encodeURIComponent(query)}`;
  const res = await axiosClient.get(url);
  const $ = cheerio.load(res.data);

  const results = [];
  // Heuristics: look for anchors to video pages within search results
  // Typical structure: div.thumb > a[href^="/video-..."]
  $("div.thumb a").each((i, el) => {
    if (results.length >= maxResults) return false;
    const href = $(el).attr("href");
    const title = ($(el).attr("title") || $(el).find("img").attr("alt") || "").trim();
    const img = $(el).find("img").attr("data-src") || $(el).find("img").attr("src") || null;

    if (href && href.startsWith("/video")) {
      const fullUrl = "https://www.xnxx.com" + href;
      results.push({
        id: uuidv4(),
        title: title || "Untitled",
        url: fullUrl,
        thumb: img,
      });
    }
  });

  // Fallback: other selectors if above yields nothing
  if (results.length === 0) {
    $("a").each((i, el) => {
      if (results.length >= maxResults) return false;
      const href = $(el).attr("href") || "";
      if (href.startsWith("/video")) {
        const title = ($(el).text() || "").trim() || "Untitled";
        const img = $(el).find("img").attr("data-src") || $(el).find("img").attr("src") || null;
        results.push({
          id: uuidv4(),
          title,
          url: "https://www.xnxx.com" + href,
          thumb: img,
        });
      }
    });
  }

  return results;
}

// Download video using yt-dlp CLI into tmp directory and return file path
async function downloadWithYtDlp(videoUrl, outDir, progressCallback) {
  // Check yt-dlp exists
  const cmdName = "yt-dlp"; // fallback: you can change to 'youtube-dl' if you prefer
  try {
    // simple check
    const which = require("child_process").spawnSync(cmdName, ["--version"], { encoding: "utf8" });
    if (which.error) throw which.error;
  } catch (e) {
    throw new Error("yt-dlp not found on the host. Install yt-dlp and ensure it's in PATH. See: https://github.com/yt-dlp/yt-dlp");
  }

  // Output template: unique id to find file afterwards
  const uid = uuidv4();
  const outTemplate = path.join(outDir, `${uid}.%(ext)s`);

  // Build args
  // -f best (best quality), --no-playlist, --no-warnings, -o <out>
  const args = ["-f", "best", "--no-playlist", "--no-warnings", "-o", outTemplate, videoUrl];

  return new Promise((resolve, reject) => {
    const proc = spawn(cmdName, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      // Optional: parse progress lines and call progressCallback if provided
      if (progressCallback) {
        const text = chunk.toString();
        // yt-dlp progress lines include something like "[download]  12.3%"
        const m = text.match(/(\d+\.\d+)%/);
        if (m) {
          progressCallback(parseFloat(m[1]));
        }
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });

    proc.on("close", async (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp exited with code ${code}. ${stderr.slice(0, 500)}`));
      }
      // Find the file matching uid.*
      try {
        const files = await fs.readdir(outDir);
        const match = files.find((f) => f.startsWith(uid + "."));
        if (!match) return reject(new Error("Downloaded file not found after yt-dlp finished."));
        const fullPath = path.join(outDir, match);
        resolve(fullPath);
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Utility to get file size in MB
function fileSizeMB(filePath) {
  try {
    const stats = fsSync.statSync(filePath);
    return stats.size / (1024 * 1024);
  } catch (e) {
    return Infinity;
  }
}

// Main command: .xnxx <query>
cmd(
  {
    pattern: "xnxx",
    react: "🔞",
    desc: "Search xnxx and download a chosen video (adult content - use responsibly)",
    category: "download",
    filename: __filename,
  },
  async (robin, mek, m, { from, q, reply, senderNumber }) => {
    try {
      if (!q) return reply("*Provide a search term.* Example: .xnxx big tits");

      // Perform search
      await robin.sendMessage(from, { text: `🔎 Searching xnxx for: ${q}\nPlease wait...` }, { quoted: mek });

      const results = await searchXnxx(q, 6);
      if (!results || results.length === 0) return reply("❌ No results found on xnxx for that query.");

      // Save session
      const sessionKey = makeSessionKey(senderNumber, from);
      xnxxSession.set(sessionKey, {
        timestamp: Date.now(),
        results,
        messageId: null, // will set after sending
      });

      // Build numbered list caption (short)
      let listText = `🔞 Search results for: ${q}\nReply to this message with the number of the video to download (1-${results.length}).\n\n`;
      results.forEach((r, i) => {
        listText += `*${i + 1}.* ${r.title}\n${r.url}\n\n`;
      });
      listText += "⛔ Use responsibly. Downloads may be large.";

      // Send thumbnail of first result + caption list (so user can reply to it)
      const firstThumb = results[0].thumb;
      let sent;
      try {
        if (firstThumb && /^https?:\/\//i.test(firstThumb)) {
          sent = await robin.sendMessage(
            from,
            { image: { url: firstThumb }, caption: listText },
            { quoted: mek }
          );
        } else {
          sent = await robin.sendMessage(from, { text: listText }, { quoted: mek });
        }
      } catch (e) {
        // fallback to text-only
        sent = await robin.sendMessage(from, { text: listText }, { quoted: mek });
      }

      // store message id for reply-checks
      try {
        const msgId = sent?.key?.id || sent?.id || null;
        const s = xnxxSession.get(sessionKey);
        if (s) {
          s.messageId = msgId;
          s.timestamp = Date.now();
          xnxxSession.set(sessionKey, s);
        }
      } catch (e) {
        // ignore
      }
    } catch (e) {
      console.error("xnxx search error:", e);
      reply(`❌ Error searching xnxx: ${e.message || "Unknown error"}`);
    }
  }
);

// Reply handler - user replies with number to download
cmd(
  {
    on: "body",
    fromMe: false,
  },
  async (robin, mek, m, { from, senderNumber, body, quoted, reply }) => {
    try {
      const sessionKey = makeSessionKey(senderNumber, from);
      const session = xnxxSession.get(sessionKey);
      if (!session || !session.results || session.results.length === 0) return;

      // Only accept replies to the original session message
      if (!quoted) return;
      const quotedId =
        quoted?.key?.id ||
        quoted?.id ||
        quoted?.message?.extendedTextMessage?.contextInfo?.stanzaId ||
        quoted?.message?.extendedTextMessage?.contextInfo?.id ||
        null;
      if (!quotedId) return;

      if (session.messageId && quotedId !== session.messageId) {
        // Not replying to the session message
        return;
      }

      // parse number
      const selected = parseInt((body || "").trim(), 10);
      if (isNaN(selected) || selected < 1 || selected > session.results.length) {
        return reply(`❌ Please reply with a valid number (1-${session.results.length}).`);
      }

      const item = session.results[selected - 1];
      if (!item) return reply("❌ Selected item not found (expired?). Try .xnxx again.");

      // Update timestamp to keep session alive during download
      session.timestamp = Date.now();
      xnxxSession.set(sessionKey, session);

      await robin.sendMessage(from, { text: `⏬ Downloading: ${item.title}\nThis may take a while.` }, { quoted: mek });

      // Prepare tmp directory
      const tmpDir = path.join(os.tmpdir(), "piko_xnxx");
      if (!fsSync.existsSync(tmpDir)) fsSync.mkdirSync(tmpDir, { recursive: true });

      // Max file size (MB)
      const MAX_FILE_MB = parseFloat(process.env.XNXX_MAX_FILE_MB || "40");

      // Download using yt-dlp to tmp
      let downloadedFile;
      try {
        downloadedFile = await downloadWithYtDlp(item.url, tmpDir, (percent) => {
          // Optionally, we could update user on progress. For now we just log.
          console.log(`yt-dlp progress: ${percent}%`);
        });
      } catch (e) {
        console.error("Download error:", e);
        return reply(`❌ Failed to download video: ${e.message || "yt-dlp error"}`);
      }

      if (!downloadedFile || !fsSync.existsSync(downloadedFile)) {
        return reply("❌ Download finished but file not found.");
      }

      const sizeMb = fileSizeMB(downloadedFile);
      if (sizeMb > MAX_FILE_MB) {
        // Too big to send: send URL and inform user
        await robin.sendMessage(
          from,
          {
            text: `⚠️ Downloaded file is ${Math.round(sizeMb)} MB which exceeds the configured limit of ${MAX_FILE_MB} MB.\nI will not upload large files.\nYou can download directly from the URL: ${item.url}`,
          },
          { quoted: mek }
        );
        // Cleanup file
        try {
          await fs.unlink(downloadedFile);
        } catch (e) {}
        return;
      }

      // Read file buffer
      const buffer = await fs.readFile(downloadedFile);

      // Send as document (more reliable) with filename
      const safeName = path.basename(downloadedFile).replace(/[^\w.\-() ]+/g, "");
      try {
        await robin.sendMessage(
          from,
          {
            document: buffer,
            mimetype: "video/mp4",
            fileName: safeName,
            caption: `🎬 ${item.title}`,
          },
          { quoted: mek }
        );
      } catch (e) {
        // Fallback: try as raw media field if library accepts it
        try {
          await robin.sendMessage(from, { video: buffer, mimetype: "video/mp4", caption: item.title }, { quoted: mek });
        } catch (err) {
          console.error("Send file error:", err);
          await robin.sendMessage(from, { text: `❌ Uploaded failed: ${err.message || "send error"}` }, { quoted: mek });
        }
      } finally {
        // Cleanup downloaded file
        try {
          await fs.unlink(downloadedFile);
        } catch (e) {}
      }
    } catch (e) {
      console.error("xnxx reply handler error:", e);
    }
  }
);

module.exports = { xnxxSession };
