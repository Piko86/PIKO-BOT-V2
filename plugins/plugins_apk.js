/**
 * plugins/apk.js
 *
 * Command: .apk <apk name or apkpure/apkmirror direct url>
 * - Searches APKPure for the given app name, picks the top result (best match),
 *   extracts the app icon and the progressive .apk download link, downloads the APK
 *   (streamed, size-limited) and sends it to the user with the app icon as a photo.
 * - If you pass a direct APKPure (or APKMirror-like) page URL, the plugin will try
 *   to extract from that page directly.
 *
 * Notes & limits:
 * - Default max file size: APK_MAX_FILE_MB (env) or 500 MB.
 * - Minimum acceptable APK size to avoid "stub/previews": APK_MIN_ACCEPT_MB (env) or 1 MB.
 * - This implementation uses scraping heuristics. Some pages may serve HLS or obfuscated
 *   flows; in those cases the plugin will return the page URL to the user.
 *
 * Dependencies:
 *   npm i axios cheerio fs-extra uuid
 *
 * Usage:
 *   .apk whatsapp
 *   .apk https://apkpure.com/facebook-messenger/com.facebook.orca
 *
 */

const { cmd } = require("../command");
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const APK_MAX_FILE_MB = parseFloat(process.env.APK_MAX_FILE_MB || "500");
const APK_MIN_ACCEPT_MB = parseFloat(process.env.APK_MIN_ACCEPT_MB || "1");

const axiosClient = axios.create({
  timeout: 30000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml",
  },
  maxRedirects: 5,
});

function makeSafeName(name) {
  if (!name) return "app";
  return String(name).replace(/[^\w\s.\-()]/g, "").trim().slice(0, 80);
}

async function probeSizeMB(url, referer = "") {
  try {
    const res = await axiosClient.head(url, { headers: { Referer: referer || "https://apkpure.com/" }, timeout: 15000, maxRedirects: 5 });
    const cl = res.headers["content-length"];
    if (cl) return parseInt(cl, 10) / (1024 * 1024);
  } catch (e) {
    // HEAD might be blocked; return null
  }
  return null;
}

async function downloadToFileWithLimit(url, outPath, maxMb = APK_MAX_FILE_MB, referer = "") {
  // Some APK hosts use dynamic streaming or chunked responses; we still stream and enforce limit.
  const writer = fs.createWriteStream(outPath);
  const res = await axios.request({
    url,
    method: "GET",
    responseType: "stream",
    headers: { Referer: referer || "https://apkpure.com/" },
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

// Search APKPure and return list of results [{title, url, icon}]
async function searchApkpure(query, maxResults = 5) {
  const searchUrl = `https://apkpure.com/search?q=${encodeURIComponent(query)}`;
  const res = await axiosClient.get(searchUrl, { headers: { Referer: "https://apkpure.com/" } });
  const $ = cheerio.load(res.data || "");
  const results = [];

  // APKPure search results often contain anchors like /<app-name>/<package>
  $("a[href]").each((i, el) => {
    if (results.length >= maxResults) return false;
    const href = $(el).attr("href") || "";
    if (!/^\/[^\/]+\/[^\/]+$/.test(href)) return; // e.g. /facebook-messenger/com.facebook.orca
    const full = `https://apkpure.com${href}`;
    const title = ($(el).find(".search-title").text() || $(el).attr("title") || $(el).text() || "").trim();
    const icon = $(el).find("img").attr("src") || $(el).find("img").attr("data-src") || null;
    if (!results.find(r => r.url === full)) {
      results.push({ title: title || path.basename(href), url: full, icon });
    }
  });

  // Fallback: specific result containers
  if (results.length === 0) {
    $("div.search-dl, div.search-item").each((i, el) => {
      if (results.length >= maxResults) return false;
      const a = $(el).find("a").first();
      const href = a.attr("href") || "";
      if (!href) return;
      const full = href.startsWith("http") ? href : `https://apkpure.com${href}`;
      const title = a.find(".search-title").text() || a.attr("title") || a.text();
      const icon = $(el).find("img").attr("src") || $(el).find("img").attr("data-src") || null;
      if (!results.find(r => r.url === full)) results.push({ title: title.trim() || path.basename(href), url: full, icon });
    });
  }

  return results.slice(0, maxResults);
}

// Given an APKPure app page, try to extract icon + direct .apk candidate(s)
async function extractFromApkpure(appPageUrl) {
  try {
    const res = await axiosClient.get(appPageUrl, { headers: { Referer: appPageUrl } });
    const html = res.data || "";
    const $ = cheerio.load(html);

    const title = $("h1.title, .title-like h1").first().text().trim() || $("meta[property='og:title']").attr("content") || null;
    const icon = $("meta[property='og:image']").attr("content") || $("img.cover-img").attr("src") || $("div.icon img").attr("src") || null;

    // Look for a download page link first (often /download?from=details)
    let dlHref = null;
    $("a[href]").each((i, el) => {
      const href = $(el).attr("href") || "";
      if (/\/download(\?|\b)/i.test(href) || /\/download\//i.test(href) || /download\.php/i.test(href)) {
        dlHref = href;
        return false;
      }
    });

    // If we found a relative dlHref, build full url
    if (dlHref && !/^https?:\/\//i.test(dlHref)) dlHref = `https://apkpure.com${dlHref}`;

    const candidates = [];

    // If dlHref exists, fetch it and try to locate final .apk link
    if (dlHref) {
      try {
        const dlPage = await axiosClient.get(dlHref, { headers: { Referer: appPageUrl } });
        const $dl = cheerio.load(dlPage.data || "");
        // direct download link often in <a id="download_link" href="...">
        let dlink = $dl("a#download_link").attr("href") || $dl("a.download-link").attr("href") || null;
        if (!dlink) {
          // some pages have meta refresh or scripts with the url
          const txt = dlPage.data || "";
          let m = txt.match(/(https?:\/\/[^\s'"<>]+\.apk[^\s'"<>]*)/i);
          if (m && m[1]) dlink = m[1];
        }
        if (dlink) {
          if (!/^https?:\/\//i.test(dlink)) {
            // relative -> make absolute based on dlHref
            try {
              const base = new URL(dlHref).origin;
              dlink = base + dlink;
            } catch (e) {}
          }
          candidates.push({ quality: "apk", url: dlink });
        }
      } catch (e) {
        // ignore error; we'll try other heuristics
      }
    }

    // Heuristic: scan scripts on the app page for direct .apk urls
    const scripts = [];
    $("script").each((i, s) => {
      const txt = $(s).html();
      if (txt && txt.length < 300000) scripts.push(txt);
    });
    for (const txt of scripts) {
      const m = txt.match(/https?:\/\/[^\s"']+\.apk[^\s"']*/i);
      if (m && m[0]) {
        candidates.push({ quality: "apk", url: m[0] });
      }
    }

    // Body fallback: any .apk link in HTML
    const bodyMatches = html.match(/https?:\/\/[^\s"'<>]+\.apk[^\s"'<>]*/ig);
    if (bodyMatches && bodyMatches.length) {
      for (const u of bodyMatches) candidates.push({ quality: "apk", url: u });
    }

    return {
      title: title || path.basename(appPageUrl),
      icon,
      candidates: candidates.length ? dedupeCandidates(candidates) : null,
      page: appPageUrl,
    };
  } catch (e) {
    return null;
  }
}

function dedupeCandidates(list) {
  const seen = new Map();
  for (const it of list) {
    if (!it || !it.url) continue;
    const key = it.url.split("?")[0];
    if (!seen.has(key)) seen.set(key, it);
  }
  return Array.from(seen.values());
}

// Try multiple candidates and prefer one that meets min size and is under max.
async function pickAndDownload(candidates, outPathBase, maxMb = APK_MAX_FILE_MB, minAcceptMb = APK_MIN_ACCEPT_MB, referer = "") {
  if (!candidates || candidates.length === 0) throw new Error("No APK candidates found.");

  // Probe sizes
  const enriched = [];
  for (const c of candidates) {
    const sizeMb = await probeSizeMB(c.url, referer).catch(() => null);
    enriched.push({ ...c, sizeMb });
  }

  // Prefer candidates with known size >= minAccept and <= max
  const acceptable = enriched.filter(c => c.sizeMb && c.sizeMb >= minAcceptMb && c.sizeMb <= maxMb);
  const unknownButLikely = enriched.filter(c => !c.sizeMb);

  const tryList = [...acceptable, ...unknownButLikely, ...enriched.filter(c => c.sizeMb && c.sizeMb < minAcceptMb)];

  for (const cand of tryList) {
    try {
      if (cand.sizeMb && cand.sizeMb > maxMb) continue;
      if (cand.sizeMb && cand.sizeMb < minAcceptMb) continue;

      const uid = uuidv4();
      const ext = path.extname(new URL(cand.url).pathname).split("?")[0] || ".apk";
      const outPath = `${outPathBase}-${uid}${ext}`;

      await downloadToFileWithLimit(cand.url, outPath, maxMb, referer);

      const stat = await fs.stat(outPath);
      const sizeMb = stat.size / (1024 * 1024);
      if (sizeMb < minAcceptMb) {
        try { await fs.remove(outPath); } catch (e) {}
        continue;
      }

      return { path: outPath, candidate: cand };
    } catch (e) {
      // try next candidate
      continue;
    }
  }

  throw new Error("All candidate APK downloads failed or produced too-small files.");
}

// Top-level command
cmd(
  {
    pattern: "apk",
    react: "📦",
    desc: "Search and download an APK by name or direct APK page URL (.apk <name|url>)",
    category: "download",
    filename: __filename,
  },
  async (robin, mek, m, { from, q, reply }) => {
    try {
      if (!q) return reply("Usage: .apk <app name>  OR  .apk <apkpure app page url>");
      const arg = q.trim();

      await robin.sendMessage(from, { text: `🔎 Searching for APK: ${arg}\nPlease wait...` }, { quoted: mek });

      let appPage = null;
      let searchTitle = arg;
      let iconUrl = null;
      let candidates = null;
      let referer = "";

      // If the user provided a direct apkpure-like URL, try extracting directly
      if (/^https?:\/\//i.test(arg) && /apkpure\.com/i.test(arg)) {
        appPage = arg;
        const extracted = await extractFromApkpure(appPage);
        if (!extracted || !extracted.candidates) {
          return reply(`❌ Couldn't extract an APK download link from that page. Open page in browser: ${arg}`);
        }
        searchTitle = extracted.title || searchTitle;
        iconUrl = extracted.icon || null;
        candidates = extracted.candidates;
        referer = extracted.page;
      } else {
        // Search flow (APKPure)
        const results = await searchApkpure(arg, 6);
        if (!results || results.length === 0) {
          return reply(`❌ No APK results found for "${arg}" on APKPure.`);
        }
        // Pick top result as "best"
        const best = results[0];
        appPage = best.url;
        searchTitle = best.title || arg;
        iconUrl = best.icon || null;
        // extract from its page
        const extracted = await extractFromApkpure(appPage);
        if (!extracted || !extracted.candidates) {
          return reply(`❌ Couldn't extract an APK link from top result (${best.url}). Try another keyword or provide a direct APKPure page URL.`);
        }
        candidates = extracted.candidates;
        referer = extracted.page;
      }

      // Notify user about chosen app
      let caption = `📦 ${searchTitle}\nSource: ${appPage}\n`;
      caption += `Found ${candidates.length} candidate link(s). Attempting to download the best one (size checks applied).`;

      // Send icon/photo first (if available)
      if (iconUrl && /^https?:\/\//i.test(iconUrl)) {
        try {
          await robin.sendMessage(from, { image: { url: iconUrl }, caption }, { quoted: mek });
        } catch (e) {
          // fallback to text
          await robin.sendMessage(from, { text: caption }, { quoted: mek });
        }
      } else {
        await robin.sendMessage(from, { text: caption }, { quoted: mek });
      }

      // Prepare tmp dir and download
      const tmpDir = path.join(os.tmpdir(), "piko_apk");
      if (!(await fs.pathExists(tmpDir))) await fs.ensureDir(tmpDir);
      const outBase = path.join(tmpDir, "apk");

      let result;
      try {
        result = await pickAndDownload(candidates, outBase, APK_MAX_FILE_MB, APK_MIN_ACCEPT_MB, referer);
      } catch (e) {
        return reply(`❌ Failed to download APK: ${e.message || "download/extraction issue"}\nYou can open the page manually: ${appPage}`);
      }

      const { path: apkPath, candidate } = result;
      const buf = await fs.readFile(apkPath);
      const safeName = `${makeSafeName(searchTitle)}.apk`;

      // Send APK as document
      try {
        await robin.sendMessage(from, { document: buf, mimetype: "application/vnd.android.package-archive", fileName: safeName, caption: `🎁 ${searchTitle} — ${Math.round((fs.statSync(apkPath).size / (1024 * 1024)))} MB` }, { quoted: mek });
      } catch (e) {
        // fallback: send direct link and note error
        await robin.sendMessage(from, { text: `❌ Sending APK failed: ${e.message || "error"}\nDirect download link: ${candidate.url}` }, { quoted: mek });
      } finally {
        try { await fs.remove(apkPath); } catch (e) {}
      }
    } catch (e) {
      console.error("apk command error:", e);
      reply(`❌ Error while processing APK request: ${e.message || "Unknown error"}`);
    }
  }
);

module.exports = { };