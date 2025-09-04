/**
 * plugins/unpair.js
 *
 * Command: .unpair
 * - Safely deletes the session folder for the sender (sessions/<phone>).
 * - Use when pairing failed and you want to remove stale credentials before retrying.
 *
 * WARNING: this removes the saved session files. Use only if you want to unlink/reset.
 *
 * Dependencies: none (uses built-ins)
 */
const { cmd } = require("../command");
const path = require("path");
const fs = require("fs-extra");

cmd(
  {
    pattern: "unpair",
    desc: "Remove saved session for your number (use in private chat).",
    category: "owner",
    react: "🧹",
    filename: __filename,
  },
  async (conn, mek, m, { from, sender, reply }) => {
    try {
      if (!sender) return reply("❌ Could not determine your sender ID.");
      const userId = String(sender).split("@")[0];
      const sessionDir = path.join(__dirname, "..", "sessions", userId);

      // Safety: confirm intent (simple two-step to avoid accidental deletion)
      await conn.sendMessage(from, { text: `⚠️ Are you sure you want to remove session files for ${userId}? Reply with "YES" within 20s to confirm.` }, { quoted: mek });

      // wait for confirmation message from the same user in same chat
      const waitForConfirmation = () => new Promise((resolve) => {
        const handler = async (update) => {
          try {
            const message = update?.messages?.[0];
            if (!message) return;
            const key = message.key || {};
            const fromJid = key.remoteJid;
            const participant = key.participant || key.remoteJid;
            const text = (message.message?.conversation || message.message?.extendedTextMessage?.text || "").trim();
            if (!fromJid || fromJid !== from) return;
            if (participant && participant.split && String(participant).split("@")[0] !== userId) return;
            if (text === "YES") {
              conn.ev.off("messages.upsert", handler);
              resolve(true);
            }
          } catch (e) {}
        };
        conn.ev.on("messages.upsert", handler);
        // timeout
        setTimeout(() => {
          try { conn.ev.off("messages.upsert", handler); } catch (e) {}
          resolve(false);
        }, 20000);
      });

      const confirmed = await waitForConfirmation();
      if (!confirmed) return reply("❌ Unpair cancelled (no confirmation).");

      // Delete folder
      if (!(await fs.pathExists(sessionDir))) {
        return reply(`ℹ️ No session found for ${userId} at ${sessionDir}.`);
      }
      await fs.remove(sessionDir);
      return reply(`✅ Session files removed for ${userId}. You can now run .pair to create a fresh session.`);
    } catch (e) {
      console.error("unpair error:", e);
      return reply(`❌ Failed to remove session: ${e?.message || e}`);
    }
  }
);

module.exports = {};