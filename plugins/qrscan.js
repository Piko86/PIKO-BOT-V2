const { cmd } = require("../command");
const QrCode = require("qrcode-reader");
const axios = require("axios");

// Robust Jimp import to handle ESM/CJS differences across versions
let JimpModule;
try {
  JimpModule = require("jimp");
} catch (err) {
  JimpModule = null;
}
const Jimp = JimpModule && (JimpModule.default || JimpModule);

if (!Jimp || typeof Jimp.read !== "function") {
  // Do not throw at import time to avoid crashing require; we'll check again at runtime and produce a helpful error
  console.warn(
    "Warning: Jimp.read not found. If qrscan fails, install a compatible Jimp version: `npm i jimp@0.16.1` or adjust import for ESM. Current Jimp export shape:",
    !!JimpModule ? Object.keys(JimpModule).slice(0, 10) : "Jimp not installed"
  );
}

/**
 * QR Scanner plugin for WhatsApp bot
 *
 * Command:
 *   .qrscan           -> send this command as caption of an image
 *   .qrscan (reply)   -> reply to an image with this command
 *   .qrscan <url>     -> give an image URL as argument
 *
 * Behavior:
 * - Accepts an image either by replying to it, sending the command as the image caption,
 *   or by providing a public image URL as the command argument.
 * - Downloads the image, decodes any QR code present, and returns the decoded text.
 *
 * Dependencies:
 *   npm i jimp qrcode-reader axios
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

      // Helper: try to get image buffer from three sources:
      // 1) URL provided as argument
      // 2) Reply to an image (quoted)
      // 3) Image sent with this message (message itself)
      async function getImageBuffer() {
        // 1) If argument is a URL, fetch it
        if (q && /^https?:\/\//i.test(q.trim())) {
          const url = q.trim();
          const res = await axios.get(url, { responseType: "arraybuffer", timeout: 20000 });
          return Buffer.from(res.data);
        }

        // 2) If user replied to a message (quoted)
        if (quoted) {
          const quotedMsg = quoted.message || quoted;
          // Preferred: use the client's download helper if available
          if (typeof robin.downloadMediaMessage === "function") {
            try {
              let candidate = quoted;
              if (quotedMsg && (quotedMsg.imageMessage || quotedMsg.videoMessage || quotedMsg.stickerMessage)) candidate = quotedMsg;
              const buffer = await robin.downloadMediaMessage(candidate).catch(() => null);
              if (buffer && Buffer.isBuffer(buffer)) return buffer;
              if (buffer && buffer.data) return Buffer.from(buffer.data);
            } catch (e) {
              // ignore and continue to other strategies
            }
          }

          // Fallback: try common fields with direct URLs
          try {
            const imgInfo = quotedMsg.imageMessage || quotedMsg.message?.imageMessage || quotedMsg;
            const possibleUrl = imgInfo?.url || imgInfo?.murl || imgInfo?.directPath;
            if (possibleUrl && /^https?:\/\//i.test(possibleUrl)) {
              const res = await axios.get(possibleUrl, { responseType: "arraybuffer", timeout: 20000 });
              return Buffer.from(res.data);
            }
          } catch (e) {
            // ignore and continue
          }
        }

        // 3) If the current message itself contains image media (user sent image with caption .qrscan)
        try {
          const currentMsg = mek?.message || m?.message || {};
          const imageMsg = currentMsg.imageMessage || currentMsg.message?.imageMessage || null;
          if (imageMsg) {
            if (typeof robin.downloadMediaMessage === "function") {
              const buffer = await robin.downloadMediaMessage(currentMsg).catch(() => null);
              if (buffer && Buffer.isBuffer(buffer)) return buffer;
              if (buffer && buffer.data) return Buffer.from(buffer.data);
            }
            const possibleUrl = imageMsg.url || imageMsg.murl || imageMsg.directPath;
            if (possibleUrl && /^https?:\/\//i.test(possibleUrl)) {
              const res = await axios.get(possibleUrl, { responseType: "arraybuffer", timeout: 20000 });
              return Buffer.from(res.data);
            }
          }
        } catch (e) {
          // ignore
        }

        // If nothing found
        return null;
      }

      const imageBuffer = await getImageBuffer();
      if (!imageBuffer) return reply("❌ No image found. Please reply to an image or send an image with the caption `.qrscan`, or provide an image URL.");

      // Ensure Jimp is available and has read
      if (!Jimp || typeof Jimp.read !== "function") {
        return reply(
          "❌ QR scanning failed because the image library (Jimp) is not available in a compatible form.\n" +
            "Fix options:\n" +
            "1) Install a compatible Jimp version: `npm i jimp@0.16.1`\n" +
            "2) If using a newer Jimp (ESM), run node with ESM support or adjust the import to use `.default`.\n\n" +
            "After installing, restart the bot and try again."
        );
      }

      // Load image with Jimp and decode QR
      const jimage = await Jimp.read(imageBuffer);
      const qr = new QrCode();

      const scanResult = await new Promise((resolve, reject) => {
        qr.callback = (err, value) => {
          if (err) return reject(err);
          resolve(value);
        };
        try {
          qr.decode(jimage.bitmap);
        } catch (err) {
          reject(err);
        }
      });

      if (!scanResult || !scanResult.result) {
        return reply("❌ No QR code detected in the image. Try a clearer or larger image with the QR centered.");
      }

      const decoded = (scanResult.result || "").trim();

      // Try to detect some common QR content types (URL, vCard)
      let extra = "";
      if (/^https?:\/\//i.test(decoded)) {
        extra = `🔗 Detected URL: ${decoded}`;
      } else if (/BEGIN:VCARD/i.test(decoded)) {
        const fnMatch = decoded.match(/FN:(.+)/i);
        const telMatch = decoded.match(/TEL[^:]*:(.+)/i);
        const fn = fnMatch ? fnMatch[1].trim() : null;
        const tel = telMatch ? telMatch[1].trim() : null;
        extra = `📇 Detected vCard${fn ? `\n• Name: ${fn}` : ""}${tel ? `\n• Phone: ${tel}` : ""}`;
      } else {
        extra = `💬 Decoded text (${decoded.length} chars):\n${decoded.length > 300 ? decoded.slice(0, 300) + "..." : decoded}`;
      }

      await robin.sendMessage(from, { text: `✅ QR code scanned successfully!\n\n${extra}` }, { quoted: mek });

      // Full decoded content for copy/paste
      await robin.sendMessage(from, { text: `Full decoded content:\n${decoded}` }, { quoted: mek });
    } catch (e) {
      console.error("qrscan error:", e);
      reply(`❌ Error while scanning QR: ${e.message || "Unknown error"}`);
    }
  }
);
