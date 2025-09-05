/**
 * plugins/site-downloader.js
 *
 * Unified downloader for direct video links from:
 *  - .pornhub <url>
 *  - .xhamster <url>
 *  - .xvideos <url>
 *
 * Behavior:
 *  - User sends a command with a direct video page URL (e.g. .pornhub <link>).
 *  - Plugin scrapes the page (no child_process, no yt-dlp), extracts candidate MP4 URLs (or HLS).
 *  - Probes candidates and prefers non-preview progressive MP4s (~>= MIN_ACCEPT_MB).
 *  - Downloads via streaming into tmp and enforces a max size limit (default 500 MB).
 *  - Sends the downloaded file as a document to the user. If no acceptable progressive MP4 is found,
 *    the plugin returns the best direct link or the page URL for manual download.
 *
 * Notes & limitations:
 *  - This approach works when pages expose direct mp4 URLs in script blobs, meta tags, or source elements.
 *  - Many sites sometimes use HLS (.m3u8) or obfuscate the real progressive file URL — in those cases
 *    the plugin returns the extracted URL or page URL for the user to download via yt-dlp or browser.
 *  - This plugin intentionally avoids child_process and native binaries.
 *
 * Environment variables:
 *  - SITE_DL_MAX_FILE_MB  (default 500)  : maximum file size to download/send (MB)
 *  - SITE_DL_MIN_ACCEPT_MB(default 5)    : minimum filesize to consider a candidate a full video (MB)
 *
 * Dependencies:
 *   npm i axios cheerio fs-extra uuid
 *
 * Example usage:
 *   .pornhub https://www.pornhub.com/view_video.php?viewkey=ph5...
 *   .xvideos https://www.xvideos.com/video12345/...
 *   .xhamster https://xhamster.com/videos/...
 *
 */

const { cmd } = require("../command");
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const SITE_DL_MAX_FILE_MB = parseFloat(process.env.SITE_DL_MAX_FILE_MB || "500");
const SITE_DL_MIN_ACCEPT_MB = parseFloat(process.env.SITE_DL_MIN_ACCEPT_MB || "5");

// axios client
const axiosClient = axios.create({
  timeout: 30000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml",
  },
  maxRedirects: 5,
});

// Utility: probe Content-Length in MB via HEAD (returns null if unavailable)
async function probeSizeMB(url) {
  try {
    const res = await axiosClient.head(url, { maxRedirects: 5, timeout: 15000, headers: { Referer: "https://www.google.com/" } });
    const cl = res.headers["content-length"];
    if (cl) return parseInt(cl, 10) / (1024 * 1024);
  } catch (e) {
    // ignore
  }
  return null;
}

// Download stream to file with size limit enforcement
async function downloadToFileWithLimit(url, outPath, maxMb = SITE_DL_MAX_FILE_MB) {
  if (/\.m3u8($|\?)/i.test(url)) throw new Error("HLS stream (.m3u8) detected — direct progressive download not supported.");
  const writer = fs.createWriteStream(outPath);
  const res = await axios.request({
    url,
    method: "GET",
    responseType: "stream",
    headers: { Referer: "https://www.google.com/" },
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

// Given a list of candidate { quality, url }, try them in order (preferring preferredQuality) and return { path, candidate }
async function downloadWithCandidates(qualities, preferredQuality = "480p", outPathBase, maxMb = SITE_DL_MAX_FILE_MB) {
  if (!qualities || qualities.length === 0) throw new Error("No candidate URLs found.");

  // Order candidates: move preferred to front if present, then sort numeric desc
  const ordered = [...qualities];
  const prefIndex = ordered.findIndex((q) => String(q.quality || "").toLowerCase().includes(String(preferredQuality).toLowerCase()));
  if (prefIndex > -1) {
    const [p] = ordered.splice(prefIndex, 1);
    ordered.unshift(p);
  }
  ordered.sort((a, b) => {
    const qa = parseInt(String(a.quality || "").replace(/[^0-9]/g, ""), 10) || 0;
    const qb = parseInt(String(b.quality || "").replace(/[^0-9]/g, ""), 10) || 0;
    return qb - qa;
  });

  // Probe sizes if possible
  const candidates = [];
  for (const q of ordered) {
    const sizeMb = await probeSizeMB(q.url).catch(() => null);
    candidates.push({ ...q, sizeMb });
  }

  // Build try list: prefer those >= MIN_ACCEPT and <= maxMb, then unknown sizes <= maxMb, then rest
  const acceptable = candidates.filter((c) => c.sizeMb && c.sizeMb >= SITE_DL_MIN_ACCEPT_MB && c.sizeMb <= maxMb);
  const unknownOk = candidates.filter((c) => (!c.sizeMb) && (!c.sizeMb || c.sizeMb <= maxMb));
  const smallButUnderMax = candidates.filter((c) => c.sizeMb && c.sizeMb < SITE_DL_MIN_ACCEPT_MB && c.sizeMb <= maxMb);

  const tryList = [...acceptable, ...unknownOk.filter(c => !acceptable.includes(c)), ...smallButUnderMax.filter(c => !acceptable.includes(c) && !unknownOk.includes(c))];

  if (tryList.length === 0) {
    // fallback to ordered
    tryList.push(...ordered);
  }

  for (const cand of tryList) {
    try {
      const uid = uuidv4();
      let ext = ".mp4";
      try { ext = path.extname(new URL(cand.url).pathname).split("?")[0] || ".mp4"; } catch (e) {}
      const outPath = `${outPathBase}-${uid}${ext}`;

      // skip if probed too big
      if (cand.sizeMb && cand.sizeMb > maxMb) continue;
      // skip if probed tiny preview
      if (cand.sizeMb && cand.sizeMb < SITE_DL_MIN_ACCEPT_MB) continue;

      await downloadToFileWithLimit(cand.url, outPath, maxMb);

      const stat = await fs.stat(outPath);
      const sizeMb = stat.size / (1024 * 1024);
      if (sizeMb < SITE_DL_MIN_ACCEPT_MB) {
        await fs.remove(outPath).catch(() => {});
        continue; // likely preview
      }

      return { path: outPath, candidate: cand };
    } catch (e) {
      // try next candidate
      continue;
    }
  }

  throw new Error("All candidate downloads failed or produced only preview clips.");
}

// Generic extractor: tries to find progressive mp4 urls and qualities by scanning page HTML & scripts
async function extractGenericVideoCandidates(pageUrl) {
  try {
    const res = await axiosClient.get(pageUrl, { headers: { Referer: pageUrl } });
    const html = res.data || "";
    const $ = cheerio.load(html);

    // 1) <video><source src=...>
    const sourceEl = $("video source[src]").first();
    if (sourceEl && sourceEl.attr("src")) {
      const u = sourceEl.attr("src");
      if (u && /^https?:\/\//i.test(u)) return [{ quality: "unknown", url: u }];
    }

    // 2) meta og:video
    const og = $("meta[property='og:video']").attr("content") || $("meta[name='twitter:player']").attr("content");
    if (og && /^https?:\/\//i.test(og)) {
      if (/\.mp4($|\?)/i.test(og)) return [{ quality: "unknown", url: og }];
      // if embed/player, continue scanning
    }

    // 3) Scan script tags for common patterns (mediaDefinitions, video_url, file, setVideoUrlHigh, setVideoUrlLow)
    const scripts = [];
    $("script").each((i, s) => {
      const t = $(s).html();
      if (t && t.length < 300000) scripts.push(t);
    });

    const candidates = [];

    for (const txt of scripts) {
      if (!/mediaDefinitions|video_url|file|setVideoUrlHigh|setVideoUrlLow|qualities|sources|file_url/i.test(txt)) continue;

      // mediaDefinitions JSON array
      let m = txt.match(/var\s+mediaDefinitions\s*=\s*(\[[\s\S]*?\]);/i) || txt.match(/"mediaDefinitions"\s*:\s*(\[[\s\S]*?\])/i);
      if (m && m[1]) {
        try {
          const arr = JSON.parse(m[1]);
          if (Array.isArray(arr)) {
            for (const d of arr) {
              const url = d.videoUrl || d.url || d.file || d.video_url || d.src || d.file_url;
              const quality = d.quality || d.label || (d.height ? `${d.height}p` : null);
              if (url && /^https?:\/\//i.test(url)) candidates.push({ quality: quality || "unknown", url });
            }
            if (candidates.length) return uniqCandidates(candidates);
          }
        } catch (e) {}
      }

      // qualities object
      m = txt.match(/"qualities"\s*:\s*(\{[\s\S]*?\})/i);
      if (m && m[1]) {
        try {
          const obj = JSON.parse(m[1]);
          for (const [k, v] of Object.entries(obj)) {
            if (typeof v === "string" && /^https?:\/\//i.test(v)) candidates.push({ quality: k, url: v });
            else if (Array.isArray(v)) for (const e of v) if (e && e.url) candidates.push({ quality: k, url: e.url });
          }
          if (candidates.length) return uniqCandidates(candidates);
        } catch (e) {}
      }

      // setVideoUrlHigh/Low pattern
      let m2 = txt.match(/setVideoUrlHigh\(['"](?<u>https?:\/\/[^'"]+)['"]\)/i) || txt.match(/setVideoUrlLow\(['"](?<u>https?:\/\/[^'"]+)['"]\)/i);
      if (m2 && m2.groups && m2.groups.u) candidates.push({ quality: "unknown", url: m2.groups.u });

      // "video_url":"https://...mp4"
      m2 = txt.match(/"video_url"\s*:\s*"(?<u>https?:\/\/[^"]+\.mp4[^"]*)"/i);
      if (m2 && m2.groups && m2.groups.u) candidates.push({ quality: "unknown", url: m2.groups.u });

      // file: "https://...mp4"
      m2 = txt.match(/file\s*:\s*['"](?<u>https?:\/\/[^'"]+\.mp4[^'"]*)['"]/i);
      if (m2 && m2.groups && m2.groups.u) candidates.push({ quality: "unknown", url: m2.groups.u });

      // generic mp4 URLs in scripts
      m2 = txt.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/ig);
      if (m2 && m2.length) {
        for (const found of m2) candidates.push({ quality: "unknown", url: found });
      }
    }

    // 4) Body fallback - find first mp4 link
    const bodyMatch = html.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/ig);
    if (bodyMatch && bodyMatch.length) {
      for (const u of bodyMatch) candidates.push({ quality: "unknown", url: u });
    }

    // 5) If none, return null
    return candidates.length ? uniqCandidates(candidates) : null;
  } catch (e) {
    return null;
  }
}

// Site-specific extractors: small tweaks, but most pages covered by generic extractor
async function extractPornhub(pageUrl) {
  // porn hub tends to have mediaDefinitions or qualities; generic works well
  return await extractGenericVideoCandidates(pageUrl);
}

async function extractXvideos(pageUrl) {
  // xvideos sometimes uses html5player.setVideoUrlHigh/Low or "video_url"
  return await extractGenericVideoCandidates(pageUrl);
}

async function extractXhamster(pageUrl) {
  // xhamster often includes "mediaDefinitions" or direct mp4s in scripts
  return await extractGenericVideoCandidates(pageUrl);
}

// De-duplicate list of candidates and normalize
function uniqCandidates(list) {
  const seen = new Map();
  for (const it of list) {
    if (!it || !it.url) continue;
    const key = it.url.split("?")[0];
    if (!seen.has(key)) seen.set(key, { quality: it.quality || "unknown", url: it.url });
  }
  const arr = Array.from(seen.values());
  // sort by numeric quality if present (desc)
  arr.sort((a, b) => {
    const qa = parseInt(String(a.quality || "").replace(/[^0-9]/g, ""), 10) || 0;
    const qb = parseInt(String(b.quality || "").replace(/[^0-9]/g, ""), 10) || 0;
    return qb - qa;
  });
  return arr;
}

// Sanitize filename safely
function sanitizeFilename(name) {
  if (!name) return "video";
  return String(name).replace(/[^\w\s.\-()]/g, "").trim().slice(0, 80);
}

// Send downloaded file buffer as document (robustly)
async function sendFileBuffer(robin, to, buffer, originalTitle, candidateUrl, mek) {
  const ext = ".mp4";
  const safeTitle = sanitizeFilename(originalTitle || "video");
  const fileName = `${safeTitle}${ext}`;
  try {
    await robin.sendMessage(to, { document: buffer, mimetype: "video/mp4", fileName, caption: `🎬 ${originalTitle || "video"}` }, { quoted: mek });
  } catch (e) {
    // fallback: send direct link
    await robin.sendMessage(to, { text: `❌ Sending file failed: ${e.message || "error"}\nDirect link: ${candidateUrl}` }, { quoted: mek });
  }
}

/*
 * Main command registrations
 * - Patterns: pornhub, xvideos, xhamster
 * - Each expects a single URL after the command.
 */
const sites = [
  { cmdName: "xvideos", hostPattern: /xvideos\.com/i,extractor: extractXvideos },
];

for (const site of sites) {
  cmd(
    {
      pattern: site.cmdName,
      react: "⏬",
      desc: `Download video from ${site.cmdName} (provide a page URL).`,
      category: "download",
      filename: __filename,
    },
    async (robin, mek, m, { from, q, reply, senderNumber }) => {
      try {
        if (!q) return reply(`Provide a ${site.cmdName} video URL. Example: .${site.cmdName} <url>`);
        const url = q.trim();
        if (!/^https?:\/\//i.test(url)) return reply("Provide a valid http/https URL.");
        if (!site.hostPattern.test(url)) return reply(`That URL does not look like a ${site.cmdName} page.`);

        await robin.sendMessage(from, { text: `🔎 Processing ${site.cmdName} URL...\n${url}\nPlease wait...` }, { quoted: mek });

        const qualities = await site.extractor(url);
        if (!qualities || qualities.length === 0) {
          return reply(`❌ Couldn't extract progressive MP4 URLs from that page. Open the page in your browser or use yt-dlp.\n${url}`);
        }

        // Try to download candidates
        let result;
        try {
          const tmpDir = path.join(os.tmpdir(), "site_downloader");
          if (!(await fs.pathExists(tmpDir))) await fs.ensureDir(tmpDir);
          const outPathBase = path.join(tmpDir, "video");
          result = await downloadWithCandidates(qualities, "480p", outPathBase, SITE_DL_MAX_FILE_MB);
        } catch (e) {
          return reply(`❌ Failed to download full video: ${e.message || e}\nYou can try the page manually: ${url}`);
        }

        const { path: downloadedFile, candidate } = result;
        const buf = await fs.readFile(downloadedFile);
        await sendFileBuffer(robin, from, buf, candidate.title || path.basename(url), candidate.url, mek);
        try { await fs.remove(downloadedFile); } catch (e) {}
      } catch (e) {
        console.error(`${site.cmdName} handler error:`, e);
        reply(`❌ Error processing your request: ${e.message || "Unknown error"}`);
      }
    }
  );
}

module.exports = { };
