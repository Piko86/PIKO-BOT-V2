const { cmd } = require("../command");
const axios = require("axios");
const sharp = require("sharp");
const jsQR = require("jsqr");

/**
 * QR Scanner plugin (no Jimp)
 *
 * Replaces Jimp + qrcode-reader with sharp + jsqr:
 * - sharp loads and decodes image to raw RGBA pixels (fast, reliable, maintained)
 * - jsqr scans raw pixel data (works with the RGBA buffer from sharp)
 *
 * Usage:
 *  - Reply to an image with the message ".qrscan"
 *  - Send an image with caption ".qrscan"
 *  - Use ".qrscan <image_url>"
 *
 * Install:
 *  npm i sharp jsqr axios
 *
 * Note: sharp requires native libvips; on many systems npm will install prebuilt binaries.
 */

cmd(
  {
    pattern: "qrscan",
    react: "🔎",
    desc: "Scan QR code from an image (reply to image or send image with caption .qrscan)",
    category: "utility",
    filename: __filename,
  },
  async (robin, mek, m, { from, q, reply, quoted }) => {
    try {
      await robin.sendMessage(from, { text: "⏳ Scanning image for QR code, please wait..." }, { quoted: mek });

      // Get image buffer from URL / quoted message / current message
      async function getImageBuffer() {
        // 1) If argument is a URL, fetch it
        if (q && /^https?:\/\//i.test(q.trim())) {
          const url = q.trim();
          const res = await axios.get(url, { responseType: "arraybuffer", timeout: 20000 });
          return Buffer.from(res.data);
        }

        // Helper to attempt client download helper first (many WhatsApp libs provide it)
        async function tryClientDownload(msgObj) {
          if (!msgObj) return null;
          try {
            if (typeof robin.downloadMediaMessage === "function") {
              // Some wrappers expect the quoted message object or the message.message shape
              const candidate = msgObj;
              const buff = await robin.downloadMediaMessage(candidate).catch(() => null);
              if (buff && Buffer.isBuffer(buff)) return buff;
              if (buff && buff.data) return Buffer.from(buff.data);
            }
          } catch (e) {
            // ignore and continue to other strategies
          }
          return null;
        }

        // 2) If user replied to a message (quoted)
        if (quoted) {
          const quotedMsg = quoted.message || quoted;
          const buff = await tryClientDownload(quoted).catch(() => null);
          if (buff) return buff;

          // Fallback: try to fetch direct URL fields if present
          try {
            const imgInfo = quotedMsg.imageMessage || quotedMsg.message?.imageMessage || quotedMsg;
            const possibleUrl = imgInfo?.url || imgInfo?.murl || imgInfo?.directPath;
            if (possibleUrl && /^https?:\/\//i.test(possibleUrl)) {
              const res = await axios.get(possibleUrl, { responseType: "arraybuffer", timeout: 20000 });
              return Buffer.from(res.data);
            }
          } catch (e) {
            // ignore
          }
        }

        // 3) If the current message itself contains image media (user sent image with caption .qrscan)
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
        } catch (e) {
          // ignore
        }

        return null;
      }

      const imageBuffer = await getImageBuffer();
      if (!imageBuffer) return reply("❌ No image found. Please reply to an image or send an image with the caption `.qrscan`, or provide an image URL.");

      // Use sharp to decode image to raw RGBA; resize to reasonable max to improve speed/accuracy
      // (keeps aspect ratio)
      const MAX_DIMENSION = 1200; // max width or height to process
      let raw;
      try {
        // rotate() respects EXIF orientation
        const pipeline = sharp(imageBuffer).rotate().resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: "inside" }).ensureAlpha();
        const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
        raw = { data, width: info.width, height: info.height };
      } catch (e) {
        console.error("sharp processing failed:", e);
        return reply("❌ Failed to process the image. The image may be corrupted or unsupported.");
      }

      if (!raw || !raw.data || !raw.width || !raw.height) {
        return reply("❌ Unable to decode image pixels for QR scanning.");
      }

      // jsQR expects a Uint8ClampedArray (RGBA buffer is acceptable)
      const imageData = new Uint8ClampedArray(raw.data);

      // Try to decode QR from the image
      const code = jsQR(imageData, raw.width, raw.height, { inversionAttempts: "attemptBoth" });

      if (!code || !code.data) {
        return reply("❌ No QR code detected in the image. Try a clearer/cropped image with the QR centered.");
      }

      const decoded = String(code.data).trim();

      // Attempt to detect vCard / URL / plain text
      let summary = "";
      if (/^https?:\/\//i.test(decoded)) {
        summary = `🔗 Detected URL: ${decoded}`;
      } else if (/BEGIN:VCARD/i.test(decoded)) {
        const fnMatch = decoded.match(/FN:(.+)/i);
        const telMatch = decoded.match(/TEL[^:]*:(.+)/i);
        const fn = fnMatch ? fnMatch[1].trim() : null;
        const tel = telMatch ? telMatch[1].trim() : null;
        summary = `📇 Detected vCard${fn ? `\n• Name: ${fn}` : ""}${tel ? `\n• Phone: ${tel}` : ""}`;
      } else {
        summary = `💬 Decoded text (${decoded.length} chars):\n${decoded.length > 600 ? decoded.slice(0, 600) + "..." : decoded}`;
      }

      await robin.sendMessage(from, { text: `✅ QR code scanned successfully!\n\n${summary}` }, { quoted: mek });

      // Also send full decoded content as plain text for copying
      await robin.sendMessage(from, { text: `Full decoded content:\n${decoded}` }, { quoted: mek });
    } catch (e) {
      console.error("qrscan error:", e);
      reply(`❌ Error while scanning QR: ${e.message || "Unknown error"}`);
    }
  }
);
