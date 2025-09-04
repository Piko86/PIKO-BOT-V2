const { makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");
const path = require("path");
const fs = require("fs");
const { cmd } = require("../command");

/**
 * Improved pairing command implementation
 *
 * Improvements:
 * - Robust try/catch around auth state and socket creation
 * - Prevent duplicate sessions for the same user (activeSessions map)
 * - Detect available pairing API on the Baileys socket and handle gracefully
 * - Keep socket reference in-memory to allow cleanup and avoid leaks
 * - Send privacy reminder and clearer error messages
 * - Cleanup on connection close and on errors
 * - Timeouts and more explicit logging
 *
 * Notes:
 * - Run the .pair command in a private/DM chat to avoid exposing the pairing code.
 * - If your Baileys version exposes a different pairing API, you may need to adapt the detect/request logic.
 */

const activeSessions = new Map(); // userId -> { sock, sessionDir, timeoutHandle }

async function startUserBot(userId, sendReply) {
  if (!userId) throw new Error("Missing userId");

  // Prevent duplicate sessions
  if (activeSessions.has(userId)) {
    await sendReply("⚠️ You already have an active pairing session. If you need a new code, first stop the existing session or wait for it to expire.");
    return;
  }

  const sessionDir = path.join(__dirname, "..", "sessions", userId);
  try {
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }
  } catch (err) {
    console.error("Failed to create session directory:", err);
    await sendReply(`❌ Failed to prepare session storage: ${err.message || err}`);
    return;
  }

  // Acquire persisted auth state
  let state, saveCreds;
  try {
    const auth = await useMultiFileAuthState(sessionDir);
    state = auth.state;
    saveCreds = auth.saveCreds;
  } catch (err) {
    console.error("useMultiFileAuthState error:", err);
    await sendReply(`❌ Failed to initialize auth state: ${err.message || err}`);
    return;
  }

  // Create socket
  let sock;
  try {
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false, // we will request pairing code programmatically
    });
  } catch (err) {
    console.error("makeWASocket error:", err);
    await sendReply(`❌ Failed to create WhatsApp socket: ${err.message || err}`);
    return;
  }

  // persist creds updates
  if (typeof saveCreds === "function") {
    sock.ev.on("creds.update", saveCreds);
  }

  // store session so we can avoid duplicates and close later
  activeSessions.set(userId, { sock, sessionDir });

  // Setup cleanup on connection close / error
  const cleanup = async (reason) => {
    try {
      const session = activeSessions.get(userId);
      if (session && session.timeoutHandle) clearTimeout(session.timeoutHandle);
      if (session && session.sock) {
        try {
          await session.sock.logout().catch(() => {});
        } catch {}
      }
    } catch (e) {
      // ignore
    } finally {
      activeSessions.delete(userId);
      console.log(`Session for ${userId} cleaned up${reason ? ` (${reason})` : ""}`);
    }
  };

  sock.ev.on("connection.update", async (update) => {
    try {
      const { connection, lastDisconnect } = update;
      console.log(`Connection update for ${userId}:`, connection);
      if (connection === "open") {
        await sendReply("✅ Your session is linked. You can now use your linked device.");
      } else if (connection === "close") {
        console.warn(`Connection closed for ${userId}`, lastDisconnect || "");
        await cleanup("connection closed");
      }
    } catch (e) {
      console.error("Error handling connection.update:", e);
    }
  });

  sock.ev.on("creds.update", () => {
    // creds are persisted by saveCreds above; event retained for logging
    console.log(`Credentials updated for ${userId}`);
  });

  // Request pairing code. Baileys versions may expose different APIs; detect available method.
  // We will try sock.requestPairingCode or sock.generatePairingCode (some forks expose different names).
  setTimeout(async () => {
    try {
      if (!sock || sock.state === "closed") {
        await sendReply("❌ Socket is not available for pairing.");
        await cleanup("socket not available");
        return;
      }

      // Privacy note — pairing codes should not be posted publicly
      await sendReply("🔐 Please ensure you run this command in a private chat (not a group). The pairing code will be shown below.");

      // detect method
      let code;
      if (typeof sock.requestPairingCode === "function") {
        code = await sock.requestPairingCode(userId).catch((err) => { throw err; });
      } else if (typeof sock.generatePairingCode === "function") {
        code = await sock.generatePairingCode(userId).catch((err) => { throw err; });
      } else if (typeof sock.generatePairingCodeForDevice === "function") {
        // hypothetical API name on some forks
        code = await sock.generatePairingCodeForDevice(userId).catch((err) => { throw err; });
      } else {
        throw new Error("Pairing API not available in this Baileys version. Update Baileys or adapt the code.");
      }

      if (!code) {
        throw new Error("No pairing code returned by Baileys API.");
      }

      console.log(`Pairing code for ${userId}:`, code);

      await sendReply(
        `🔑 *Your WhatsApp Pairing Code:*\n\n\`\`\`${code}\`\`\`\n\n👉 Open *WhatsApp > Linked Devices > Link a Device* and enter this code.`
      );

      // Set an inactivity expiry: clean the session if not used within X minutes
      const EXPIRY_MS = (process.env.PAIRING_SESSION_EXPIRE_MINUTES ? parseInt(process.env.PAIRING_SESSION_EXPIRE_MINUTES, 10) : 10) * 60 * 1000;
      const timeoutHandle = setTimeout(async () => {
        try {
          await sendReply(`⌛ Pairing session expired after ${Math.round(EXPIRY_MS / 60000)} minute(s). Run .pair again if needed.`);
        } catch (e) {}
        await cleanup("pairing timeout");
      }, EXPIRY_MS);

      const session = activeSessions.get(userId) || {};
      session.timeoutHandle = timeoutHandle;
      activeSessions.set(userId, session);
    } catch (err) {
      console.error("Pairing Error:", err);
      try {
        await sendReply(`❌ Pairing failed: ${err.message || err}`);
      } catch (e) {}
      // cleanup on failure
      await cleanup("pairing error");
    }
  }, 1000);
}

// Command registration
cmd(
  {
    pattern: "pair",
    desc: "Pair your WhatsApp number with the bot (use in private chat)",
    category: "owner",
    react: "🔗",
    filename: __filename,
  },
  async (conn, mek, m, { from, sender }) => {
    try {
      // Validation
      if (!sender) return await conn.sendMessage(from, { text: "❌ Unable to determine sender ID." }, { quoted: mek });

      const userId = String(sender).split("@")[0];
      if (!/^\d+$/.test(userId)) {
        // If the extracted userId is not numeric, warn but continue (some JID formats differ)
        await conn.sendMessage(from, { text: `⚠️ Detected user id: ${userId}. If pairing fails, try using your phone number (e.g. 1234567890).` }, { quoted: mek });
      }

      // sendReply helper
      const sendReply = async (text) => {
        try {
          // Always send the pairing code to the chat where the command was executed.
          // If you want to deliver it privately, replace `from` below with the user's direct JID.
          await conn.sendMessage(from, { text }, { quoted: mek });
        } catch (e) {
          console.error("sendReply error:", e);
        }
      };

      await sendReply("🔄 Generating your pairing code, please wait...");
      await startUserBot(userId, sendReply);
    } catch (e) {
      console.error("pair command error:", e);
      try {
        await conn.sendMessage(from, { text: `❌ Error: ${e.message || "Unknown error"}` }, { quoted: mek });
      } catch {}
    }
  }
);

module.exports = { startUserBot, activeSessions };
