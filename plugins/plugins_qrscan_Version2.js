/**
 * QR Scanner Plugin — no sharp/jsqr/jimp, uses "qrcode" npm package.
 *
 * Usage:
 *  - .qrscan <image_url>
 *  - Reply to image with .qrscan
 *  - Send image with .qrscan as caption
 *
 * Requirements:
 *    npm i qrcode axios
 */

const { cmd } = require("../command");

// --- Dependency check ---
let QRCode, axios;
const missing = [];
try { QRCode = require("qrcode"); } catch (e) { missing.push("qrcode"); }
try { axios = require("axios"); } catch (e) { missing.push("axios"); }

cmd(
  {
    pattern: "qrscan",
    react: "🔎",
    desc: "Scan QR code from an image (reply to image, send with caption .qrscan, or .qrscan <url>)",
    category: "utility",
    filename: __filename,
  },
  async (robin, mek, m, { from, q, reply, quoted }) => {
    // Check for missing dependencies
    if (missing.length > 0) {
      return reply(
        `❌ This feature requires the following npm packages:\n` +
        missing.map((n) => `• ${n}`).join("\n") +
        `\nPlease install with:\n\nnpm i ${missing.join(" ")}`
      );
    }

    await robin.sendMessage(from, { text: "⏳ Scanning image for QR code, please wait..." }, { quoted: mek });

    // Helper: get image buffer from URL, quoted, or self
    async function getImageBuffer() {
      if (q && /^https?:\/\//i.test(q.trim())) {
        const url = q.trim();
        const res = await axios.get(url, { responseType: "arraybuffer", timeout: 20000 });
        return Buffer.from(res.data);
      }
      async function tryClientDownload(msgObj) {
        if (!msgObj) return null;
        try {
          if (typeof robin.downloadMediaMessage === "function") {
            const buff = await robin.downloadMediaMessage(msgObj).catch(() => null);
            if (buff && Buffer.isBuffer(buff)) return buff;
            if (buff && buff.data) return Buffer.from(buff.data);
          }
        } catch { }
        return null;
      }
      if (quoted) {
        const buff = await tryClientDownload(quoted);
        if (buff) return buff;
        try {
          const quotedMsg = quoted.message || quoted;
          const imgInfo = quotedMsg.imageMessage || quotedMsg.message?.imageMessage || quotedMsg;
          const possibleUrl = imgInfo?.url || imgInfo?.murl || imgInfo?.directPath;
          if (possibleUrl && /^https?:\/\//i.test(possibleUrl)) {
            const res = await axios.get(possibleUrl, { responseType: "arraybuffer", timeout: 20000 });
            return Buffer.from(res.data);
          }
        } catch { }
      }
      try {
        const currentMsg = mek?.message || m?.message || {};
        const imgMsg = currentMsg.imageMessage || currentMsg.message?.imageMessage || null;
        if (imgMsg) {
          const buff = await tryClientDownload(mek || m).catch(() => null);
          if (buff) return buff;
          const possibleUrl = imgMsg.url || imgMsg.murl || imgMsg.directPath;
          if (possibleUrl && /^https?:\/\//i.test(possibleUrl)) {
            const res = await axios.get(possibleUrl, { responseType: "arraybuffer", timeout: 20000 });
            return Buffer.from(res.data);
          }
        }
      } catch { }
      return null;
    }

    const imageBuffer = await getImageBuffer();
    if (!imageBuffer) return reply("❌ No image found. Reply to an image, send an image with caption `.qrscan`, or provide an image URL.");

    // The "qrcode" package is designed for encoding, but also can decode with QRCodeReader.decode().
    // Unfortunately, qrcode does not provide direct decode for images in Node.js.
    // Instead, we use a minimal PNG/JPEG parsing package, or fallback to a remote decode API.

    // --- Try using 'qrcode-reader' if available ---
    let QRReader, PNG;
    try {
      QRReader = require("qrcode-reader");
      PNG = require("png-js");
    } catch (err) {}

    if (QRReader && PNG) {
      // Try decoding as PNG (works for WhatsApp/Telegram images)
      try {
        const png = new PNG(imageBuffer);
        png.decode(async function(pixels) {
          try {
            const qr = new QRReader();
            qr.callback = function(err, value) {
              if (err || !value) return reply("❌ No QR code detected or decode failed.");
              const decoded = String(value.result || "").trim();
              if (!decoded) return reply("❌ QR code detected but content is empty.");
              return reply("✅ QR code result:\n" + decoded);
            };
            qr.decode({ data: pixels, width: png.width, height: png.height });
          } catch (e) {
            return reply("❌ Error decoding QR PNG: " + (e.message || e));
          }
        });
        return;
      } catch {}
    }

    // --- As fallback, use remote qrserver.com API ---
    try {
      const formData = new FormData();
      formData.append('file', imageBuffer, { filename: 'qr.png', contentType: 'image/png' });
      const res = await axios.post('https://api.qrserver.com/v1/read-qr-code/', formData, {
        headers: formData.getHeaders ? formData.getHeaders() : { ...formData.headers },
        maxContentLength: 5 * 1024 * 1024,
        timeout: 20000,
      });
      const out = res.data && Array.isArray(res.data) ? res.data[0] : null;
      const qrVal = out && out.symbol && out.symbol[0] && out.symbol[0].data;
      if (qrVal) {
        return reply("✅ QR code result:\n" + qrVal);
      } else {
        return reply("❌ No QR code detected or decode failed (remote API fallback).");
      }
    } catch (e) {
      return reply("❌ QR scan failed (remote API error): " + (e.message || e));
    }
  }
);