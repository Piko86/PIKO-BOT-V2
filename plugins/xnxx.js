/**
 * plugins/xnxx.js (no child_process)
 *
 * .xnxx <query>        -> Search xnxx for videos and return a numbered list (reply-to-list required)
 * (reply to list) 1..6 -> Bot tries to extract the direct video file URL from the xnxx page,
 *                         downloads the file via HTTP (no child_process/yt-dlp), and sends it as document.
 *
 * IMPORTANT:
 *  - This version does NOT use child_process or yt-dlp.
 *  - Instead it scrapes the xnxx video page for direct video file URLs and downloads them with axios streams.
 *  - Not all xnxx pages expose a simple MP4 URL (some use HLS .m3u8 or obfuscated players). If extraction fails
 *    the bot will return the page URL and ask the user to download externally.
 *
 * Dependencies:
 *  npm i axios cheerio uuid fs-extra
 *
 * Behavior / Limitations:
 *  - Attempts multiple heuristics to find a direct MP4 URL on the video page (video > source, JS patterns, meta tags).
 *  - If found and Content-Length is available and <= XNXX_MAX_FILE_MB (env, default 40 MB), the bot downloads and sends it.
 *  - If Content-Length is missing, the bot streams and enforces the same limit by aborting if exceeded.
 *  - If the found URL is HLS (.m3u8) or otherwise unsupported, the bot will not try to convert and will provide the source page URL instead.
 *  - Sessions expire after 8 minutes.
 *
 * Security & Legal:
 *  - This plugin touches adult content. Use responsibly and ensure your deployment allows such content.
 *  - Scraping site structure can break if xnxx changes their HTML/JS. Heuristics may need updates over time.
 */

const { cmd } = require("../command");
const axios = require("axios");
const cheerio = require("cheerio");
const { v4: uuidv4 } = require("uuid");
const os = require("os");
const path = require("path");
const fs = require("fs-extra");

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

// Axios client with UA
const axiosClient = axios.create({
  timeout: 20000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml",
  },
  maxRedirects: 5,
});

// Search xnxx and return top N results (same heuristics as before)
async function searchXnxx(query, maxResults = 6) {
  const url = `https://www.xnxx.com/?k=${encodeURIComponent(query)}`;
  const res = await axiosClient.get(url);
  const $ = cheerio.load(res.data);

  const results = [];
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

  // Fallback selectors
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

// Try to extract a direct video URL from the xnxx video page.
// Returns the first candidate direct URL (likely mp4) or null.
async function extractDirectVideoUrl(pageUrl) {
  try {
    const res = await axiosClient.get(pageUrl, { headers: { Referer: "https://www.xnxx.com/" } });
    const html = res.data;
    const $ = cheerio.load(html);

    // 1) Look for <video><source src="..."></video>
    const sourceEl = $("video source[src]").first();
    if (sourceEl && sourceEl.attr("src")) {
      const u = sourceEl.attr("src");
      if (u && /^https?:\/\//i.test(u)) return u;
    }

    // 2) Look for meta tags (og:video)
    const ogVideo = $("meta[property='og:video']").attr("content") || $("meta[name='twitter:player']").attr("content");
    if (ogVideo && /^https?:\/\//i.test(ogVideo)) return ogVideo;

    // 3) Heuristic: search script tags for common patterns
    const scripts = [];
    $("script").each((i, s) => {
      const txt = $(s).html();
      if (txt && txt.length < 20000) scripts.push(txt);
    });

    // Common patterns seen on video sites:
    // setVideoUrlHigh('https://...mp4')
    // setVideoUrlLow('...')
    // "video_url":"https://....mp4"
    // file: "https://...mp4"
    // sources: [{"file":"https://...mp4",...}]
    const patterns = [
      /setVideoUrlHigh\(['"](?<u>https?:\/\/[^'"]+)['"]\)/i,
      /setVideoUrlLow\(['"](?<u>https?:\/\/[^'"]+)['"]\)/i,
      /"video_url"\s*:\s*"(?<u>https?:\/\/[^"]+)"/i,
      /file\s*:\s*["'](?<u>https?:\/\/[^"']+)["']/i,
      /sources\s*:\s*\[.*?\{.*?file\s*:\s*["'](?<u>https?:[^"']+)["'].*?\}.*?\]/is,
      /"file"\s*:\s*"(?<u>https?:\/\/[^"]+)"/i,
      /"url"\s*:\s*"(?<u>https?:\/\/[^"]+)"/i,
    ];

    for (const scriptText of scripts) {
      for (const pat of patterns) {
        const m = scriptText.match(pat);
        if (m && m.groups && m.groups.u) {
          const found = m.groups.u.replace(/\\\//g, "/");
          if (found && /^https?:\/\//i.test(found)) return found;
        }
      }
    }

    // 4) Search the HTML body for direct urls (cheap fallback)
    const urlMatch = html.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);
    if (urlMatch) return urlMatch[0];

    // 5) Sometimes video is provided in JSON inside a data-setup or data- attribute
    const dataSetup = $('[data-setup]').attr('data-setup');
    if (dataSetup) {
      try {
        const j = JSON.parse(dataSetup);
        if (j && typeof j === "object") {
          // common keys
          const candidates = [j.file, j.sources?.[0]?.file, j.sources?.[0]?.url, j.url].filter(Boolean);
          if (candidates.length > 0) return candidates[0];
        }
      } catch (e) {}
    }

    // If nothing found, return null
    return null;
  } catch (e) {
    console.warn("extractDirectVideoUrl error:", e?.message || e);
    return null;
  }
}

// Download a URL to a file path with size limit (MB). Returns path on success or throws.
async function downloadToFile(url, outPath, maxMb = 40) {
  // Disallow HLS playlists (.m3u8)
  if (/\.m3u8($|\?)/i.test(url)) {
    throw new Error("HLS stream detected (.m3u8) — direct download not supported by this plugin.");
  }

  const writer = fs.createWriteStream(outPath);
  const res = await axios.request({
    url,
    method: "GET",
    responseType: "stream",
    headers: { Referer: "https://www.xnxx.com/" },
    timeout: 60000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  const contentLength = res.headers["content-length"] ? parseInt(res.headers["content-length"], 10) : null;
  if (contentLength && contentLength / (1024 * 1024) > maxMb) {
    // close stream
    res.data.destroy();
    throw new Error(`Remote file is too large (${Math.round(contentLength / (1024 * 1024))} MB).`);
  }

  return new Promise((resolve, reject) => {
    let downloaded = 0;
    const limitBytes = maxMb * 1024 * 1024;

    res.data.on("data", (chunk) => {
      downloaded += chunk.length;
      if (downloaded > limitBytes) {
        // abort
        res.data.destroy();
        writer.destroy();
        // remove file
        try { fs.removeSync(outPath); } catch (e) {}
        reject(new Error(`Download aborted: exceeded ${maxMb} MB limit.`));
      } else {
        // continue
      }
    });

    res.data.pipe(writer);

    writer.on("finish", async () => {
      // verify size
      try {
        const stat = await fs.stat(outPath);
        if (stat.size > limitBytes) {
          await fs.remove(outPath);
          return reject(new Error(`Downloaded file exceeds ${maxMb} MB limit.`));
        }
        resolve(outPath);
      } catch (e) {
        reject(e);
      }
    });

    writer.on("error", (err) => {
      try { fs.removeSync(outPath); } catch (e) {}
      reject(err);
    });

    res.data.on("error", (err) => {
      try { writer.destroy(); fs.removeSync(outPath); } catch (e) {}
      reject(err);
    });
  });
}

// Utility to get file size in MB (sync)
function fileSizeMB(filePath) {
  try {
    const stats = fs.statSync(filePath);
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
    desc: "Search xnxx and download a chosen video (attempts direct download without child_process)",
    category: "download",
    filename: __filename,
  },
  async (robin, mek, m, { from, q, reply, senderNumber }) => {
    try {
      if (!q) return reply("*Provide a search term.* Example: .xnxx big tits");

      await robin.sendMessage(from, { text: `🔎 Searching xnxx for: ${q}\nPlease wait...` }, { quoted: mek });

      const results = await searchXnxx(q, 6);
      if (!results || results.length === 0) return reply("❌ No results found on xnxx for that query.");

      // Save session
      const sessionKey = makeSessionKey(senderNumber, from);
      xnxxSession.set(sessionKey, {
        timestamp: Date.now(),
        results,
        messageId: null,
      });

      // Build numbered list caption
      let listText = `🔞 Search results for: ${q}\nReply to this message with the number of the video to download (1-${results.length}).\n\n`;
      results.forEach((r, i) => {
        listText += `*${i + 1}.* ${r.title}\n${r.url}\n\n`;
      });
      listText += "⛔ Use responsibly. Downloads may be large and may fail if the site hides video URLs.";

      // Send thumbnail of first result + caption list
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
      if (session.messageId && quotedId !== session.messageId) return;

      // parse number
      const selected = parseInt((body || "").trim(), 10);
      if (isNaN(selected) || selected < 1 || selected > session.results.length) {
        return reply(`❌ Please reply with a valid number (1-${session.results.length}).`);
      }

      const item = session.results[selected - 1];
      if (!item) return reply("❌ Selected item not found (expired?). Try .xnxx again.");

      // Update timestamp
      session.timestamp = Date.now();
      xnxxSession.set(sessionKey, session);

      await robin.sendMessage(from, { text: `⏬ Attempting to extract and download: ${item.title}\nThis may take a while.` }, { quoted: mek });

      // Try to extract direct video URL
      const directUrl = await extractDirectVideoUrl(item.url);
      if (!directUrl) {
        // couldn't extract: return the page URL to user
        return reply(`❌ Couldn't extract a direct video URL for that item. Please open in your browser:\n${item.url}`);
      }

      // If url is HLS (.m3u8) or not mp4, don't attempt raw download
      if (/\.m3u8($|\?)/i.test(directUrl) || !/\.mp4($|\?)/i.test(directUrl)) {
        return reply(`⚠️ Extracted video URL is a stream or not a direct MP4, download via yt-dlp or a player:\n${directUrl}\n(Automatic download not supported for HLS/stream URLs).`);
      }

      // Prepare tmp dir and download
      const tmpDir = path.join(os.tmpdir(), "piko_xnxx");
      if (!(await fs.pathExists(tmpDir))) await fs.ensureDir(tmpDir);

      const uid = uuidv4();
      const ext = path.extname(new URL(directUrl).pathname).split("?")[0] || ".mp4";
      const outPath = path.join(tmpDir, `${uid}${ext}`);

      const MAX_FILE_MB = parseFloat(process.env.XNXX_MAX_FILE_MB || "40");

      let downloadedFile;
      try {
        downloadedFile = await downloadToFile(directUrl, outPath, MAX_FILE_MB);
      } catch (e) {
        console.error("downloadToFile error:", e);
        // If download aborted due to size or other error, inform user and provide direct link
        return reply(`❌ Failed to download the extracted video: ${e.message || "download error"}\nYou can try the direct link:\n${directUrl}`);
      }

      if (!downloadedFile || !(await fs.pathExists(downloadedFile))) {
        return reply("❌ Download finished but file not found.");
      }

      const sizeMb = fileSizeMB(downloadedFile);
      if (sizeMb > MAX_FILE_MB) {
        // Too big, send direct URL instead
        try { await fs.remove(downloadedFile); } catch (e) {}
        return reply(`⚠️ Downloaded file is ${Math.round(sizeMb)} MB which exceeds the limit of ${MAX_FILE_MB} MB.\nYou can download directly: ${directUrl}`);
      }

      // Read file buffer and send as document
      const buffer = await fs.readFile(downloadedFile);
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
        console.error("Send file error:", e);
        // fallback: send direct link
        await robin.sendMessage(from, { text: `❌ Sending file failed. You can download directly: ${directUrl}` }, { quoted: mek });
      } finally {
        // cleanup
        try { await fs.remove(downloadedFile); } catch (e) {}
      }
    } catch (e) {
      console.error("xnxx reply handler error:", e);
    }
  }
);

module.exports = { xnxxSession };
