/**
 * plugins/pornhub.js
 *
 * Fix: handle cases where extracted URL points to a short preview clip (10s) by probing and
 * trying alternate candidates. Automatically prefers 480p but will skip preview-size files
 * (default threshold PORNHUB_MIN_ACCEPT_MB = 5 MB) and will fall back to the largest candidate.
 *
 * Behavior changes:
 * - When multiple candidate URLs are found, the plugin probes Content-Length for each and
 *   prefers a candidate whose size is above PORNHUB_MIN_ACCEPT_MB (default 5 MB) and within
 *   the configured max (PORNHUB_MAX_FILE_MB, default 500).
 * - If HEAD is unavailable, it will attempt download and reject small files (below threshold),
 *   trying the next candidate.
 * - This prevents selecting tiny preview clips (10s) and should return the full-length video.
 *
 * Usage remains the same.
 *
 * Dependencies:
 *  npm i axios cheerio fs-extra uuid
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

// Axios client (slightly longer timeouts for pages / downloads)
const axiosClient = axios.create({
  timeout: 30000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml",
  },
  maxRedirects: 5,
});

// Helper: create session key
const makeSessionKey = (senderNumber, chatId) => `${senderNumber}|${chatId}`;

// Configurable thresholds via env
const PORNHUB_MAX_FILE_MB = parseFloat(process.env.PORNHUB_MAX_FILE_MB || "500");
const PORNHUB_MIN_ACCEPT_MB = parseFloat(process.env.PORNHUB_MIN_ACCEPT_MB || "5"); // avoid previews below ~5MB

// Search Pornhub: returns up to maxResults (default 20, max 25)
async function searchPornhub(query, maxResults = 20) {
  maxResults = Math.min(25, Math.max(6, maxResults)); // clamp 6..25
  const url = `https://www.pornhub.com/video/search?search=${encodeURIComponent(query)}`;
  const res = await axiosClient.get(url);
  const $ = cheerio.load(res.data);

  const results = [];

  // try several selectors for robustness
  const anchors = $("a");
  for (let i = 0; i < anchors.length && results.length < maxResults; i++) {
    const el = anchors[i];
    const href = $(el).attr("href") || "";
    // porn hub video pages include /view_video.php?viewkey= or /video/
    if (!href.includes("/view_video.php?viewkey=") && !href.includes("/video/")) continue;
    const full = href.startsWith("http") ? href : `https://www.pornhub.com${href}`;
    const title = ($(el).attr("title") || $(el).find("img").attr("alt") || $(el).text() || "").trim();
    const thumb = $(el).find("img").attr("data-src") || $(el).find("img").attr("src") || null;
    if (!results.find((r) => r.url === full)) {
      results.push({
        id: uuidv4(),
        title: title || "Untitled",
        url: full,
        thumb,
      });
    }
  }

  // fallback: inspect specific result containers if anchors were insufficient
  if (results.length < Math.min(6, maxResults)) {
    $("li.pcVideoListItem, div.search-video-result, div.videoBox").each((i, el) => {
      if (results.length >= maxResults) return false;
      const a = $(el).find("a").first();
      const href = a.attr("href") || "";
      if (!href) return;
      const full = href.startsWith("http") ? href : `https://www.pornhub.com${href}`;
      const title = a.attr("title") || $(el).find(".title").text() || "Untitled";
      const thumb = $(el).find("img").attr("data-src") || $(el).find("img").attr("src") || null;
      if (!results.find((r) => r.url === full)) {
        results.push({ id: uuidv4(), title: (title || "Untitled").trim(), url: full, thumb });
      }
    });
  }

  return results.slice(0, maxResults);
}

// Extract direct video URLs and qualities from a page (optimized scanning)
async function extractPornhubVideoQualities(pageUrl) {
  try {
    const res = await axiosClient.get(pageUrl, { headers: { Referer: "https://www.pornhub.com/" } });
    const html = res.data;
    const $ = cheerio.load(html);

    // collect script contents but limit size to avoid huge parsing cost
    const scripts = [];
    $("script").each((i, s) => {
      const txt = $(s).html();
      if (!txt) return;
      // skip extremely large scripts
      if (txt.length > 200000) return;
      scripts.push(txt);
    });

    // attempt parsing common JSON-like blobs
    for (const txt of scripts) {
      // fast checks for common tokens
      if (!/mediaDefinitions|video_url|file|qualities|sources/i.test(txt)) continue;

      // Try to find mediaDefinitions arrays or qualities objects
      let m = txt.match(/var\s+mediaDefinitions\s*=\s*(\[[\s\S]*?\]);/i) || txt.match(/"mediaDefinitions"\s*:\s*(\[[\s\S]*?\])/i);
      if (m && m[1]) {
        try {
          const arr = JSON.parse(m[1]);
          if (Array.isArray(arr)) {
            const mapped = arr
              .map((d) => {
                const url = d.videoUrl || d.url || d.file || d.video_url || d.src || d.file_url;
                const quality = d.quality || d.label || (d.height ? `${d.height}p` : null);
                if (url && typeof url === "string") return { quality: quality || "unknown", url: url };
                return null;
              })
              .filter(Boolean);
            if (mapped.length) return uniqQualities(mapped);
          }
        } catch (e) {
          // ignore parse errors
        }
      }

      // qualities object
      m = txt.match(/"qualities"\s*:\s*(\{[\s\S]*?\})/i);
      if (m && m[1]) {
        try {
          const obj = JSON.parse(m[1]);
          const mapped = [];
          for (const [k, v] of Object.entries(obj)) {
            if (typeof v === "string" && v.startsWith("http")) mapped.push({ quality: k, url: v });
            else if (Array.isArray(v)) for (const e of v) if (e && e.url) mapped.push({ quality: k, url: e.url });
          }
          if (mapped.length) return uniqQualities(mapped);
        } catch (e) {}
      }

      // direct file patterns
      let m2 = txt.match(/"video_url"\s*:\s*"(?<u>https?:\/\/[^"]+\.mp4[^"]*)"/i);
      if (m2 && m2.groups && m2.groups.u) return [{ quality: "unknown", url: m2.groups.u }];
      m2 = txt.match(/"file"\s*:\s*"(?<u>https?:\/\/[^"]+\.mp4[^"]*)"/i);
      if (m2 && m2.groups && m2.groups.u) return [{ quality: "unknown", url: m2.groups.u }];

      // generic mp4 url
      m2 = txt.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);
      if (m2) return [{ quality: "unknown", url: m2[0] }];
    }

    // meta tags fallback
    const ogVideo = $("meta[property='og:video']").attr("content") || $("meta[name='twitter:player']").attr("content");
    if (ogVideo && /^https?:\/\//i.test(ogVideo) && /\.mp4($|\?)/i.test(ogVideo)) {
      return [{ quality: "unknown", url: ogVideo }];
    }

    // search body for mp4
    const htmlMatch = html.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);
    if (htmlMatch) return [{ quality: "unknown", url: htmlMatch[0] }];

    return null;
  } catch (e) {
    console.warn("extractPornhubVideoQualities error:", e?.message || e);
    return null;
  }
}

// De-duplicate and sort by numeric quality where possible
function uniqQualities(list) {
  const seen = new Map();
  for (const item of list) {
    if (!item || !item.url) continue;
    const key = item.url.split("?")[0];
    if (!seen.has(key)) seen.set(key, { quality: item.quality || "unknown", url: item.url });
    else {
      const existing = seen.get(key);
      if ((existing.quality === "unknown" || !existing.quality) && item.quality) seen.set(key, item);
    }
  }
  const arr = Array.from(seen.values());
  arr.sort((a, b) => {
    const qa = parseInt((a.quality || "").replace("p", ""), 10) || 0;
    const qb = parseInt((b.quality || "").replace("p", ""), 10) || 0;
    return qb - qa;
  });
  return arr;
}

// Pick preferred quality (default '480p'), otherwise closest available
function pickPreferredQuality(qualities, preferred = "480p") {
  if (!Array.isArray(qualities) || qualities.length === 0) return null;
  // try exact match
  const exact = qualities.find((q) => String(q.quality).toLowerCase().includes(String(preferred).toLowerCase()));
  if (exact) return exact;
  // try numeric closest: compute difference
  const desired = parseInt(String(preferred).replace(/[^0-9]/g, ""), 10) || 480;
  let best = null;
  let bestDiff = Infinity;
  for (const q of qualities) {
    const val = parseInt(String(q.quality).replace(/[^0-9]/g, ""), 10) || 0;
    const diff = Math.abs(desired - val);
    if (best === null || diff < bestDiff) {
      best = q;
      bestDiff = diff;
    }
  }
  return best;
}

// Probe size MB with HEAD
async function probeSizeMB(url) {
  try {
    const res = await axiosClient.head(url, { maxRedirects: 5, timeout: 15000, headers: { Referer: "https://www.pornhub.com/" } });
    const cl = res.headers["content-length"];
    if (cl) return parseInt(cl, 10) / (1024 * 1024);
  } catch (e) {
    // HEAD may be blocked; return null
  }
  return null;
}

// Download streaming with size limit (MB)
async function downloadToFileWithLimit(url, outPath, maxMb = PORNHUB_MAX_FILE_MB) {
  if (/\.m3u8($|\?)/i.test(url)) throw new Error("HLS stream detected (.m3u8) — direct download not supported.");
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

// Helper: attempt multiple candidates, prefer > MIN_ACCEPT_MB and <= MAX_FILE_MB.
// Returns path to downloaded file or throws.
async function downloadWithCandidates(qualities, preferred, outPathBase, maxMb = PORNHUB_MAX_FILE_MB) {
  if (!qualities || qualities.length === 0) throw new Error("No candidates provided.");

  // Order candidates: prefer preferred quality first, then by numeric quality desc
  const preferredIndex = qualities.findIndex((q) => String(q.quality).toLowerCase().includes(String(preferred).toLowerCase()));
  const ordered = [...qualities];

  if (preferredIndex > -1) {
    const [p] = ordered.splice(preferredIndex, 1);
    ordered.unshift(p);
  }

  ordered.sort((a, b) => {
    const qa = parseInt((a.quality || "").replace(/[^0-9]/g, ""), 10) || 0;
    const qb = parseInt((b.quality || "").replace(/[^0-9]/g, ""), 10) || 0;
    return qb - qa;
  });

  // Try to probe content-length for candidates and pick those above MIN_ACCEPT if possible
  const candidates = [];
  for (const q of ordered) {
    const sizeMb = await probeSizeMB(q.url).catch(() => null);
    candidates.push({ ...q, sizeMb });
  }

  // Prefer candidates with sizeMb >= PORNHUB_MIN_ACCEPT_MB and <= maxMb
  const acceptable = candidates.filter((c) => c.sizeMb && c.sizeMb >= PORNHUB_MIN_ACCEPT_MB && c.sizeMb <= maxMb);
  const fallbackCandidates = candidates.filter((c) => !c.sizeMb || (c.sizeMb > 0 && c.sizeMb <= maxMb)); // unknown sizes allowed

  const tryList = acceptable.length ? acceptable.concat(fallbackCandidates.filter((c) => !acceptable.includes(c))) : fallbackCandidates;

  // As ultimate fallback, include original order
  if (tryList.length === 0) {
    tryList.push(...ordered);
  }

  // Now attempt downloads sequentially until one produces a file >= MIN_ACCEPT_MB
  for (let i = 0; i < tryList.length; i++) {
    const cand = tryList[i];
    try {
      const uid = uuidv4();
      let ext = ".mp4";
      try { ext = path.extname(new URL(cand.url).pathname).split("?")[0] || ".mp4"; } catch (e) {}
      const outPath = `${outPathBase}-${uid}${ext}`;

      // If candidate probed and is larger than maxMb, skip
      if (cand.sizeMb && cand.sizeMb > maxMb) {
        continue;
      }

      // If probed and below MIN_ACCEPT_MB, skip (likely preview)
      if (cand.sizeMb && cand.sizeMb < PORNHUB_MIN_ACCEPT_MB) {
        continue;
      }

      // Attempt download; if HEAD unavailable it may download a small preview and we'll detect and retry
      await downloadToFileWithLimit(cand.url, outPath, maxMb);

      // verify downloaded size
      const stat = await fs.stat(outPath);
      const sizeMb = stat.size / (1024 * 1024);
      if (sizeMb < PORNHUB_MIN_ACCEPT_MB) {
        // too small (preview), delete and continue
        try { await fs.remove(outPath); } catch (e) {}
        continue;
      }

      // success
      return { path: outPath, candidate: cand };
    } catch (e) {
      // log and continue to next candidate
      console.warn("downloadWithCandidates candidate failed, trying next:", cand?.url, e?.message || e);
      continue;
    }
  }

  throw new Error("All candidate downloads failed or produced only preview clips.");
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

// Main command handler: supports search OR direct URL
cmd(
  {
    pattern: "pornhub",
    react: "🔞",
    desc: "Search pornhub or download a provided pornhub link (auto-480p).",
    category: "download",
    filename: __filename,
  },
  async (robin, mek, m, { from, q, reply, senderNumber }) => {
    try {
      if (!q) return reply("*Provide a search term or a pornhub video URL.* Example: .pornhub big tits   OR  .pornhub https://www.pornhub.com/view_video.php?viewkey=...");

      const arg = q.trim();

      // If argument looks like a pornhub url -> direct-extract & download (auto 480p)
      if (/pornhub\.com\/(view_video\.php\?viewkey=|video\/)/i.test(arg)) {
        await robin.sendMessage(from, { text: `🔎 Processing direct URL...\n${arg}\nPlease wait...` }, { quoted: mek });

        // attempt extract
        const qualities = await extractPornhubVideoQualities(arg);
        if (!qualities || qualities.length === 0) {
          return reply(`❌ Couldn't extract direct video URLs. Open page in browser:\n${arg}`);
        }

        // prepare ordered candidate set and download with fallback
        await robin.sendMessage(from, { text: `🔎 Found ${qualities.length} candidate URL(s). Probing and selecting best one...` }, { quoted: mek });

        let result;
        try {
          const tmpDir = path.join(os.tmpdir(), "piko_pornhub");
          if (!(await fs.pathExists(tmpDir))) await fs.ensureDir(tmpDir);
          const outPathBase = path.join(tmpDir, "pornhub");
          result = await downloadWithCandidates(qualities, "480p", outPathBase, PORNHUB_MAX_FILE_MB);
        } catch (e) {
          console.error("direct URL download failed:", e);
          return reply(`❌ Failed to download full video (extraction or candidates issue): ${e.message || e}\nYou can try the page manually: ${arg}`);
        }

        const { path: downloadedFile, candidate } = result;
        const buffer = await fs.readFile(downloadedFile);
        const safeTitle = (candidate?.quality || "pornhub").replace(/[^\w\s.\-()]/g, "").slice(0, 60);
        const safeName = `${safeTitle}-${(candidate.quality || "unknown")}${path.extname(downloadedFile)}`;
        try {
          await robin.sendMessage(
            from,
            { document: buffer, mimetype: "video/mp4", fileName: safeName, caption: `🎬 Download — ${candidate.quality || "unknown"}` },
            { quoted: mek }
          );
        } catch (e) {
          console.error("send error:", e);
          await robin.sendMessage(from, { text: `❌ Sending file failed. Direct link: ${candidate.url}` }, { quoted: mek });
        } finally {
          try { await fs.remove(downloadedFile); } catch (e) {}
        }

        return;
      }

      // Otherwise treat as search query
      await robin.sendMessage(from, { text: `🔎 Searching Pornhub for: ${arg}\nPlease wait...` }, { quoted: mek });

      const results = await searchPornhub(arg, 20); // request 20 results
      if (!results || results.length === 0) return reply("❌ No results found on Pornhub for that query.");

      const sessionKey = makeSessionKey(senderNumber, from);
      pornhubSession.set(sessionKey, {
        stage: "choose_video",
        timestamp: Date.now(),
        results,
        messageId: null,
      });

      // Build list caption (up to 25, we requested 20)
      let listText = `🔞 Pornhub results for: ${arg}\nReply to this message with the number of the video to download (1-${results.length}).\n\n`;
      results.forEach((r, i) => {
        listText += `*${i + 1}.* ${r.title}\n${r.url}\n\n`;
      });
      listText += `⛔ Use responsibly. The bot will auto-select 480p or closest available and will skip preview clips. Max upload: ${PORNHUB_MAX_FILE_MB} MB`;

      // Send thumbnail of first result + caption (so user can reply to it)
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
      console.error("pornhub command error:", e);
      reply(`❌ Error: ${e.message || "Unknown error"}`);
    }
  }
);

// Reply handler: user replies with number -> bot extracts and auto-downloads 480p (or closest)
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

      if (!quoted) return;
      const quotedId =
        quoted?.key?.id ||
        quoted?.id ||
        quoted?.message?.extendedTextMessage?.contextInfo?.stanzaId ||
        quoted?.message?.extendedTextMessage?.contextInfo?.id ||
        null;
      if (!quotedId) return;

      if (session.messageId && quotedId !== session.messageId) return;

      const selected = parseInt((body || "").trim(), 10);
      if (isNaN(selected) || selected < 1 || selected > session.results.length) {
        return reply(`❌ Please reply with a valid number (1-${session.results.length}).`);
      }

      const item = session.results[selected - 1];
      if (!item) return reply("❌ Item not found or expired. Try .pornhub again.");

      // update session timestamp to keep it alive during extraction
      session.timestamp = Date.now();
      pornhubSession.set(sessionKey, session);

      await robin.sendMessage(from, { text: `🔎 Extracting and selecting 480p for:\n${item.title}\n${item.url}\nPlease wait...` }, { quoted: mek });

      const qualities = await extractPornhubVideoQualities(item.url);
      if (!qualities || qualities.length === 0) {
        pornhubSession.delete(sessionKey);
        return reply(`❌ Couldn't extract direct video URLs for that video. Open in your browser:\n${item.url}`);
      }

      // Try to download using candidate logic
      let result;
      try {
        const tmpDir = path.join(os.tmpdir(), "piko_pornhub");
        if (!(await fs.pathExists(tmpDir))) await fs.ensureDir(tmpDir);
        const outPathBase = path.join(tmpDir, "pornhub");
        result = await downloadWithCandidates(qualities, "480p", outPathBase, PORNHUB_MAX_FILE_MB);
      } catch (e) {
        console.error("downloadWithCandidates error:", e);
        pornhubSession.delete(sessionKey);
        return reply(`❌ Failed to download full video (candidates/extraction issue): ${e.message || e}\nDirect page: ${item.url}`);
      }

      const { path: downloadedFile, candidate } = result;
      const buffer = await fs.readFile(downloadedFile);
      const safeTitle = (item.title || "pornhub").replace(/[^\w\s.\-()]/g, "").slice(0, 60);
      const safeName = `${safeTitle}-${(candidate.quality || "unknown")}${path.extname(downloadedFile)}`;
      try {
        await robin.sendMessage(
          from,
          {
            document: buffer,
            mimetype: "video/mp4",
            fileName: safeName,
            caption: `🎬 ${item.title} — ${candidate.quality || "unknown"}`,
          },
          { quoted: mek }
        );
      } catch (e) {
        console.error("send error:", e);
        await robin.sendMessage(from, { text: `❌ Sending file failed. Direct link: ${candidate.url}` }, { quoted: mek });
      } finally {
        try { await fs.remove(downloadedFile); } catch (e) {}
        pornhubSession.delete(sessionKey);
      }
    } catch (e) {
      console.error("pornhub reply handler error:", e);
    }
  }
);

module.exports = { pornhubSession };
