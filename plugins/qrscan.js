const { cmd } = require("../command");
const Jimp = require("jimp");
const QrCode = require("qrcode-reader");
const axios = require("axios");

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
 * - If the QR contains a vCard or URL, the decoded text is returned plainly and vCard is detected.
 *
 * Dependencies:
 *   npm i jimp qrcode-reader axios
 *
 * Notes:
 * - This implementation tries several common ways to obtain the image buffer depending on
 *   how your WhatsApp library exposes incoming media. It expects the bot client (robin)
 *   to expose a media download helper named `downloadMediaMessage` (common in many Baileys
 *   wrappers). If your client uses a different helper (eg. `downloadAndSaveMediaMessage`
 *   or `download`), either adapt the call or tell me and I can adjust the plugin.
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
      // 3) Image sent with this message (messsage itself)
      async function getImageBuffer() {
        // 1) If argument is a URL, fetch it
        if (q && /^https?:\/\//i.test(q.trim())) {
          const url = q.trim();
          const res = await axios.get(url, { responseType: "arraybuffer", timeout: 20000 });
          return Buffer.from(res.data);
        }

        // 2) If user replied to a message (quoted)
        if (quoted) {
          // Many libraries expose the quoted message structure. Try to extract the media object.
          const quotedMsg = quoted.message || quoted; // quoted may already be the message object
          // If the library provides a download helper on the client:
          if (typeof robin.downloadMediaMessage === "function") {
            try {
              // Some wrappers accept the whole quoted object, others expect the quoted.message
              let candidate = quoted;
              // Try multiple shapes
              if (quotedMsg && quotedMsg.imageMessage) candidate = quotedMsg;
              const buffer = await robin.downloadMediaMessage(candidate).catch(() => null);
              if (buffer && Buffer.isBuffer(buffer)) return buffer;
              // Some implementations return stream or { data } shape:
              if (buffer && buffer.data) return Buffer.from(buffer.data);
            } catch (e) {
              // ignore and continue to next attempts
            }
          }

          // Fallback: some quoted message shapes include a direct URL or binary in `quotedMsg.imageMessage` fields
          try {
            // Try common field patterns
            const imgInfo = quotedMsg.imageMessage || quotedMsg.message?.imageMessage || quotedMsg;
            // Example: some libs include `url` or `mimetype`/`binary` fields
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

      // Load image with Jimp and decode QR
      const jimage = await Jimp.read(imageBuffer);
      const qr = new QrCode();

      const scanResult = await new Promise((resolve, reject) => {
        qr.callback = (err, value) => {
          if (err) return reject(err);
          resolve(value);
        };
        // qrcode-reader expects the bitmap object
        try {
          qr.decode(jimage.bitmap);
        } catch (err) {
          reject(err);
        }
      });

      if (!scanResult || !scanResult.result) {
        return reply("❌ No QR code detected in the image. Try a clearer or larger image with the QR centered.");
      }

      const decoded = scanResult.result.trim();

      // Try to detect some common QR content types (URL, vCard)
      let extra = "";
      if (/^https?:\/\//i.test(decoded)) {
        extra = `🔗 Detected URL: ${decoded}`;
      } else if (/BEGIN:VCARD/i.test(decoded)) {
        // Try to parse a simple FN and TEL out of vCard for nicer display
        const fnMatch = decoded.match(/FN:(.+)/i);
        const telMatch = decoded.match(/TEL[^:]*:(.+)/i);
        const fn = fnMatch ? fnMatch[1].trim() : null;
        const tel = telMatch ? telMatch[1].trim() : null;
        extra = `📇 Detected vCard${fn ? `\n• Name: ${fn}` : ""}${tel ? `\n• Phone: ${tel}` : ""}`;
      } else {
        // show first 300 chars if it's long
        extra = `💬 Decoded text (${decoded.length} chars):\n${decoded.length > 300 ? decoded.slice(0, 300) + "..." : decoded}`;
      }

      // Send the decoded result and include the raw decoded text in a code block-like reply
      await robin.sendMessage(from, { text: `✅ QR code scanned successfully!\n\n${extra}` }, { quoted: mek });

      // Also send a plain text message with full decoded content so user can copy easily
      await robin.sendMessage(from, { text: `Full decoded content:\n${decoded}` }, { quoted: mek });
    } catch (e) {
      console.error("qrscan error:", e);
      reply(`❌ Error while scanning QR: ${e.message || "Unknown error"}`);
    }
  }
);