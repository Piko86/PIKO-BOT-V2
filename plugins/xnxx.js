/**
 * plugins/pornhub.js
 *
 * Multi-step Pornhub search + download plugin (no child_process)
 *
 * Usage:
 *  - .pornhub <query>
 *      -> bot searches pornhub and sends a numbered list of results (1..N). Reply-to-that-list message with a number to select a video.
 *  - (reply to list) 1..N
 *      -> bot extracts available quality URLs for that video and sends a numbered quality list (1..M). Reply-to-that-quality-list with a number to pick quality.
 *  - (reply to quality list) 1..M
 *      -> bot downloads the selected quality and sends it as a document (up to PORNHUB_MAX_FILE_MB, default 500 MB).
 *
 * Notes & limits:
 *  - This implementation scrapes pornhub pages and uses heuristics to extract direct MP4 URLs (mediaDefinitions, script JSON, mp4 links).
 *  - Not every pornhub page exposes simple MP4 URLs. If extraction fails or the URL is HLS (.m3u8), the bot will return the page URL for manual download.
 *  - No child_process or yt-dlp is used. Download is performed via HTTP stream with an enforced size limit.
 *  - Default max upload size: 500 MB. Configure via environment variable PORNHUB_MAX_FILE_MB.
 *
 * Dependencies:
 *  npm i axios cheerio fs-extra uuid
 *
 * Export:
 *  module.exports = { pornhubSession };
 */

const { cmd } = require("../command");
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

// Sessions keyed per user+chat: `${senderNumber}|${chatId}`
const pornhubSession = new Map();
const SESSION_TTL = 8 * 60 * 1000; // 8 minutes

// Auto-cleanup sessions
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of pornhubSession) {
    if (!s || !s.timestamp || now - s.timestamp > SESSION_TTL) {
      pornhubSession.delete(k);
      console.log(`🧹 Cleaned pornhub session ${k}`);
    }
  }
}, 60 * 1000);

// Axios client
const axiosClient = axios.create({
  timeout: 20000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml",
  },
  maxRedirects: 5,
});

// Helper: create session key
const makeSessionKey = (senderNumber, chatId) => `${senderNumber}|${chatId}`;

// Pornhub search: returns top N results with { title, url, thumb }
async function searchPornhub(query, maxResults = 6) {
  const url = `https://www.pornhub.com/video/search?search=${encodeURIComponent(query)}`;
  const res = await axiosClient.get(url);
  const $ = cheerio.load(res.data);

  const results = [];

  // Cards often appear as li.pcVideoListItem or div.search-video-result
  // We'll search for anchors to /view_video.php?viewkey=...
  $("a").each((i, el) => {
    if (results.length >= maxResults) return false;
    const href = $(el).attr("href") || "";
    if (!href.includes("/view_video.php?viewkey=") && !href.includes("/video/")) return;
    let full = href.startsWith("http") ? href : `https://www.pornhub.com${href}`;
    // title
    const title = ($(el).attr("title") || $(el).find("img").attr("alt") || $(el).text() || "").trim();
    // thumb
    const thumb = $(el).find("img").attr("data-src") || $(el).find("img").attr("src") || null;

    // avoid duplicates
    if (!results.find((r) => r.url === full)) {
      results.push({
        id: uuidv4(),
        title: title || "Untitled",
        url: full,
        thumb,
      });
    }
  });

  // Fallback: look for .phimage or .js-mxp and anchors inside result containers
  if (results.length === 0) {
    $("li.pcVideoListItem, div.search-video-result").each((i, el) => {
      if (results.length >= maxResults) return false;
      const a = $(el).find("a").first();
      const href = a.attr("href") || "";
      if (!href) return;
      const full = href.startsWith("http") ? href : `https://www.pornhub.com${href}`;
      const title = a.attr("title") || $(el).find(".title").text() || "Untitled";
      const thumb = $(el).find("img").attr("data-src") || $(el).find("img").attr("src") || null;
      if (!results.find((r) => r.url === full)) {
        results.push({ id: uuidv4(), title: title.trim(), url: full, thumb });
      }
    });
  }

  return results.slice(0, maxResults);
}

// Extract direct video URLs and qualities from a pornhub video page
// Returns array of { quality: '1080p', url: 'https://...mp4' } or null if none found
async function extractPornhubVideoQualities(pageUrl) {
  try {
    const res = await axiosClient.get(pageUrl, { headers: { Referer: "https://www.pornhub.com/" } });
    const html = res.data;
    const $ = cheerio.load(html);

    // 1) Try to find "mediaDefinitions" JSON variable
    // Patterns to look for:
    // - var mediaDefinitions = [...]
    // - "mediaDefinitions": [...]
    // - "video_url" or "videoUrl" or "sources": [...]
    const scripts = [];
    $("script").each((i, s) => {
      const txt = $(s).html();
      if (txt && txt.length < 200000) scripts.push(txt);
    });

    // Try to parse JSON arrays from scripts
    for (const txt of scripts) {
      // mediaDefinitions variable
      let m = txt.match(/var\s+mediaDefinitions\s*=\s*(\[[\s\S]*?\]);/i);
      if (!m) m = txt.match(/"mediaDefinitions"\s*:\s*(\[[\s\S]*?\])/i);
      if (m && m[1]) {
        try {
          const arrText = m[1];
          const obj = JSON.parse(arrText);
          if (Array.isArray(obj)) {
            const mapped = obj
              .map((d) => {
                // objects can have keys: quality, videoUrl, url, hdUrl, video_url, file
                const url = d.videoUrl || d.url || d.file || d.video_url || d.src || d.video;
                const quality = d.quality || d.label || (d.height ? `${d.height}p` : null);
                if (url && typeof url === "string") return { quality: quality || "unknown", url: url };
                return null;
              })
              .filter(Boolean);
            if (mapped.length > 0) return uniqQualities(mapped);
          }
        } catch (e) {
          // ignore parse error
        }
      }

      // look for JSON-like 'mediaDefinitions' somewhere else
      m = txt.match(/mediaDefinitions\s*:\s*(\[[\s\S]*?\])/i);
      if (m && m[1]) {
        try {
          const arrText = m[1];
          const obj = JSON.parse(arrText);
          if (Array.isArray(obj)) {
            const mapped = obj
              .map((d) => {
                const url = d.videoUrl || d.url || d.file || d.video_url || d.src || d.file_url;
                const quality = d.quality || d.label || (d.height ? `${d.height}p` : null);
                if (url && typeof url === "string") return { quality: quality || "unknown", url: url };
                return null;
              })
              .filter(Boolean);
            if (mapped.length > 0) return uniqQualities(mapped);
          }
        } catch (e) {}
      }

      // direct JSON with "qualities" or "sources"
      m = txt.match(/"qualities"\s*:\s*(\{[\s\S]*?\})/i);
      if (m && m[1]) {
        try {
          const qualitiesObj = JSON.parse(m[1]);
          // qualitiesObj may be { "360p": "...", "480p": "..." }
          const mapped = [];
          for (const [k, v] of Object.entries(qualitiesObj)) {
            if (typeof v === "string" && v.startsWith("http")) mapped.push({ quality: k, url: v });
            else if (Array.isArray(v)) {
              for (const entry of v) if (entry && entry.url) mapped.push({ quality: k, url: entry.url });
            }
          }
          if (mapped.length > 0) return uniqQualities(mapped);
        } catch (e) {}
      }

      // match patterns like "video_url":"https://...mp4"
      let m2 = txt.match(/"video_url"\s*:\s*"(?<u>https?:\/\/[^"]+\.mp4[^"]*)"/i);
      if (m2 && m2.groups && m2.groups.u) {
        return [{ quality: "unknown", url: m2.groups.u }];
      }

      // look for "file":"https://...mp4"
      m2 = txt.match(/"file"\s*:\s*"(?<u>https?:\/\/[^"]+\.mp4[^"]*)"/i);
      if (m2 && m2.groups && m2.groups.u) return [{ quality: "unknown", url: m2.groups.u }];

      // generic mp4 url in script
      m2 = txt.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);
      if (m2) return [{ quality: "unknown", url: m2[0] }];
    }

    // 2) Try meta tags (og:video)
    const ogVideo = $("meta[property='og:video']").attr("content") || $("meta[name='twitter:player']").attr("content");
    if (ogVideo && /^https?:\/\//i.test(ogVideo)) {
      // ogVideo may be an embed or player, not direct mp4. If it's mp4, return it.
      if (/\.mp4($|\?)/i.test(ogVideo)) return [{ quality: "unknown", url: ogVideo }];
    }

    // 3) Search HTML for direct mp4 links
    const htmlMatch = html.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);
    if (htmlMatch) return [{ quality: "unknown", url: htmlMatch[0] }];

    // nothing found
    return null;
  } catch (e) {
    console.warn("extractPornhubVideoQualities error:", e?.message || e);
    return null;
  }
}

// Remove duplicates by URL, prefer better quality label if available
function uniqQualities(list) {
  const seen = new Map();
  for (const item of list) {
    if (!item || !item.url) continue;
    const key = item.url.split("?")[0];
    if (!seen.has(key)) {
      seen.set(key, { quality: item.quality || "unknown", url: item.url });
    } else {
      // prefer one with a more descriptive quality label
      const existing = seen.get(key);
      if (existing.quality === "unknown" && item.quality && item.quality !== "unknown") {
        seen.set(key, item);
      }
    }
  }
  // Sort by quality numeric if possible (1080p > 720p ...)
  const arr = Array.from(seen.values());
  arr.sort((a, b) => {
    const qa = parseInt((a.quality || "").replace("p", ""), 10) || 0;
    const qb = parseInt((b.quality || "").replace("p", ""), 10) || 0;
    return qb - qa;
  });
  return arr;
}

// Try to get content-length (MB) via HEAD; returns MB or null if unknown
async function probeSizeMB(url) {
  try {
    const res = await axiosClient.head(url, { maxRedirects: 5, timeout: 15000, headers: { Referer: "https://www.pornhub.com/" } });
    const cl = res.headers["content-length"];
    if (cl) return parseInt(cl, 10) / (1024 * 1024);
  } catch (e) {
    // HEAD might be blocked; return null
  }
  return null;
}

// Download with streaming and size limit (MB)
async function downloadToFileWithLimit(url, outPath, maxMb = 500) {
  if (/\.m3u8($|\?)/i.test(url)) {
    throw new Error("HLS stream detected (.m3u8) — direct download not supported.");
  }

  const writer = fs.createWriteStream(outPath);
  const res = await axios.request({
    url,
    method: "GET",
    responseType: "stream",
    headers: { Referer: "https://www.pornhub.com/" },
    timeout: 60000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  const contentLength = res.headers["content-length"] ? parseInt(res.headers["content-length"], 10) : null;
  const limitBytes = maxMb * 1024 * 1024;
  if (contentLength && contentLength > limitBytes) {
    res.data.destroy();
    throw new Error(`Remote file is too large (${Math.round(contentLength / (1024 * 1024))} MB).`);
  }

  return new Promise((resolve, reject) => {
    let downloaded = 0;
    res.data.on("data", (chunk) => {
      downloaded += chunk.length;
      if (downloaded > limitBytes) {
        res.data.destroy();
        writer.destroy();
        try { fs.removeSync(outPath); } catch (e) {}
        return reject(new Error(`Download aborted: exceeded ${maxMb} MB limit.`));
      }
    });

    res.data.pipe(writer);

    writer.on("finish", async () => {
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

// Main command: .pornhub <query>
cmd(
  {
    pattern: "pornhub",
    react: "🔞",
    desc: "Search pornhub and download a chosen video (multi-step: choose video -> choose quality)",
    category: "download",
    filename: __filename,
  },
  async (robin, mek, m, { from, q, reply, senderNumber }) => {
    try {
      if (!q) return reply("*Provide a search term.* Example: .pornhub big tits");

      await robin.sendMessage(from, { text: `🔎 Searching Pornhub for: ${q}\nPlease wait...` }, { quoted: mek });

      const results = await searchPornhub(q, 8);
      if (!results || results.length === 0) return reply("❌ No results found on Pornhub for that query.");

      const sessionKey = makeSessionKey(senderNumber, from);
      pornhubSession.set(sessionKey, {
        stage: "choose_video",
        timestamp: Date.now(),
        results,
        messageId: null,
      });

      // Build list caption
      let listText = `🔞 Pornhub results for: ${q}\nReply to this message with the number of the video to inspect/download (1-${results.length}).\n\n`;
      results.forEach((r, i) => {
        listText += `*${i + 1}.* ${r.title}\n${r.url}\n\n`;
      });
      listText += `⛔ Use responsibly. After selecting a video you'll be asked to pick a quality.`;

      // Send thumbnail and caption
      const firstThumb = results[0].thumb;
      let sent;
      try {
        if (firstThumb && /^https?:\/\//i.test(firstThumb)) {
          sent = await robin.sendMessage(from, { image: { url: firstThumb }, caption: listText }, { quoted: mek });
        } else {
          sent = await robin.sendMessage(from, { text: listText }, { quoted: mek });
        }
      } catch (e) {
        sent = await robin.sendMessage(from, { text: listText }, { quoted: mek });
      }

      const msgId = sent?.key?.id || sent?.id || null;
      const s = pornhubSession.get(sessionKey);
      if (s) {
        s.messageId = msgId;
        s.timestamp = Date.now();
        pornhubSession.set(sessionKey, s);
      }
    } catch (e) {
      console.error("pornhub search error:", e);
      reply(`❌ Error searching Pornhub: ${e.message || "Unknown error"}`);
    }
  }
);

// Reply handler: handles both video selection and quality selection
cmd(
  {
    on: "body",
    fromMe: false,
  },
  async (robin, mek, m, { from, senderNumber, body, quoted, reply }) => {
    try {
      const sessionKey = makeSessionKey(senderNumber, from);
      const session = pornhubSession.get(sessionKey);
      if (!session) return;

      // must be a reply
      if (!quoted) return;
      const quotedId =
        quoted?.key?.id ||
        quoted?.id ||
        quoted?.message?.extendedTextMessage?.contextInfo?.stanzaId ||
        quoted?.message?.extendedTextMessage?.contextInfo?.id ||
        null;
      if (!quotedId) return;

      if (session.messageId && quotedId !== session.messageId) {
        // Not replying to our session message
        return;
      }

      // parse number
      const selected = parseInt((body || "").trim(), 10);
      if (isNaN(selected)) return;

      // Stage: choose_video
      if (session.stage === "choose_video") {
        if (selected < 1 || selected > session.results.length) {
          return reply(`❌ Please reply with a valid number (1-${session.results.length}).`);
        }

        const item = session.results[selected - 1];
        if (!item) return reply("❌ Item not found (maybe expired). Try .pornhub again.");

        // move to next stage
        session.stage = "choose_quality";
        session.selectedIndex = selected - 1;
        session.qualities = null;
        session.timestamp = Date.now();
        pornhubSession.set(sessionKey, session);

        await robin.sendMessage(from, { text: `🔎 Extracting available qualities for:\n${item.title}\n${item.url}\nPlease wait...` }, { quoted: mek });

        // extract qualities
        const qualities = await extractPornhubVideoQualities(item.url);
        if (!qualities || qualities.length === 0) {
          // cannot extract
          session.stage = "finished";
          pornhubSession.set(sessionKey, session);
          return reply(`❌ Couldn't extract direct video URLs for that video. Open in your browser:\n${item.url}`);
        }

        // probe sizes (optional) and attach size info
        const maxProbe = Math.min(qualities.length, 6);
        const qWithSize = await Promise.all(
          qualities.map(async (qItem) => {
            let sizeMb = await probeSizeMB(qItem.url);
            if (sizeMb === null) sizeMb = null;
            return { quality: qItem.quality || "unknown", url: qItem.url, sizeMb };
          })
        );

        session.qualities = qWithSize;
        session.timestamp = Date.now();
        pornhubSession.set(sessionKey, session);

        // Build quality list text
        let qText = `🎚️ Available qualities for: ${item.title}\nReply to this message with the number to choose (1-${qWithSize.length}).\n\n`;
        qWithSize.forEach((qI, idx) => {
          qText += `*${idx + 1}.* ${qI.quality} ${qI.sizeMb ? `- ${Math.round(qI.sizeMb)} MB` : ""}\n${qI.url}\n\n`;
        });
        qText += `\nMax upload limit: ${process.env.PORNHUB_MAX_FILE_MB || 500} MB. If the file is larger you'll receive the direct link instead.`;

        const firstThumb = item.thumb;
        let sent;
        try {
          if (firstThumb && /^https?:\/\//i.test(firstThumb)) {
            sent = await robin.sendMessage(from, { image: { url: firstThumb }, caption: qText }, { quoted: mek });
          } else {
            sent = await robin.sendMessage(from, { text: qText }, { quoted: mek });
          }
        } catch (e) {
          sent = await robin.sendMessage(from, { text: qText }, { quoted: mek });
        }

        // update messageId to the new message so next reply must reference it
        try {
          const msgId = sent?.key?.id || sent?.id || null;
          session.messageId = msgId;
          session.timestamp = Date.now();
          pornhubSession.set(sessionKey, session);
        } catch (e) {}
        return;
      }

      // Stage: choose_quality
      if (session.stage === "choose_quality") {
        const qualities = session.qualities || [];
        if (selected < 1 || selected > qualities.length) {
          return reply(`❌ Please reply with a valid number (1-${qualities.length}).`);
        }

        const qItem = qualities[selected - 1];
        if (!qItem) return reply("❌ Selected quality not found. Try again.");

        // ready to download
        session.stage = "downloading";
        session.timestamp = Date.now();
        pornhubSession.set(sessionKey, session);

        const item = session.results[session.selectedIndex];

        await robin.sendMessage(from, { text: `⏬ Downloading (${qItem.quality}) for:\n${item.title}\nPlease wait...` }, { quoted: mek });

        // Prepare tmp dir
        const tmpDir = path.join(os.tmpdir(), "piko_pornhub");
        if (!(await fs.pathExists(tmpDir))) await fs.ensureDir(tmpDir);

        const uid = uuidv4();
        // Try to derive extension from URL
        let ext = ".mp4";
        try {
          const parsed = new URL(qItem.url);
          ext = path.extname(parsed.pathname).split("?")[0] || ".mp4";
        } catch (e) {}

        const outPath = path.join(tmpDir, `${uid}${ext}`);

        // Max file size (MB) default 500
        const MAX_FILE_MB = parseFloat(process.env.PORNHUB_MAX_FILE_MB || "500");

        // First probe
        const probed = await probeSizeMB(qItem.url);
        if (probed && probed > MAX_FILE_MB) {
          // too big, return direct URL
          return reply(`⚠️ Selected quality appears to be ${Math.round(probed)} MB which exceeds the limit of ${MAX_FILE_MB} MB.\nDirect link:\n${qItem.url}`);
        }

        // Download with streaming & limit
        let downloadedFile;
        try {
          downloadedFile = await downloadToFileWithLimit(qItem.url, outPath, MAX_FILE_MB);
        } catch (e) {
          console.error("pornhub download error:", e);
          // give direct link as fallback
          try { await fs.remove(outPath); } catch (err) {}
          return reply(`❌ Failed to download video: ${e.message || "download error"}\nDirect link:\n${qItem.url}`);
        }

        if (!downloadedFile || !(await fs.pathExists(downloadedFile))) {
          return reply("❌ Download finished but file not found.");
        }

        // Send file as document
        const buffer = await fs.readFile(downloadedFile);
        const safeName = `${item.title.replace(/[^\w\s.\-()]/g, "").slice(0, 60)}-${qItem.quality}${ext}`;
        try {
          await robin.sendMessage(
            from,
            {
              document: buffer,
              mimetype: "video/mp4",
              fileName: safeName,
              caption: `🎬 ${item.title} — ${qItem.quality}`,
            },
            { quoted: mek }
          );
        } catch (e) {
          console.error("pornhub send error:", e);
          // fallback: send direct link
          await robin.sendMessage(from, { text: `❌ Sending file failed. You can download directly: ${qItem.url}` }, { quoted: mek });
        } finally {
          try { await fs.remove(downloadedFile); } catch (e) {}
        }

        // mark session finished
        pornhubSession.delete(sessionKey);
        return;
      }
    } catch (e) {
      console.error("pornhub handler error:", e);
    }
  }
);

module.exports = { pornhubSession };
