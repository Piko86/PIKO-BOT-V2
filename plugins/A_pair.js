const { 
  makeWASocket, 
  useMultiFileAuthState, 
  fetchLatestBaileysVersion 
} = require("@whiskeysockets/baileys");
const P = require("pino");
const fs = require("fs");
const path = require("path");
const { cmd } = require("../command");

// In-memory store of active user sessions
let userSessions = {};

// Ensure base sessions directory exists
const SESSIONS_BASE = path.join(__dirname, "..", "sessions");
if (!fs.existsSync(SESSIONS_BASE)) fs.mkdirSync(SESSIONS_BASE, { recursive: true });

/**
 * Normalize a sender identifier for filesystem (keep digits only).
 * Accepts formats like "1234567890" or "1234567890@s.whatsapp.net"
 */
function normalizeId(id) {
  return String(id || "").replace(/[^0-9]/g, "");
}

/**
 * Start (or resume) a WhatsApp session for a user and generate a pairing code if needed.
 * - userId: sender identifier (phone number or senderNumber)
 * - reply: function to send replies back to the user (string)
 */
async function startUserBot(userId, reply) {
  const normalized = normalizeId(userId);
  if (!normalized) {
    return reply("❌ Could not normalize your number. Please ensure your sender id is correct.");
  }

  // If a session is already running for this user, inform them
  if (userSessions[normalized]) {
    const runningSock = userSessions[normalized];
    // If already registered, inform the user
    const isRegistered = runningSock?.authState?.creds?.registered || false;
    if (isRegistered) return reply("✅ Your session is already active and paired.");
    // if sock exists but not registered, just inform that the pairing code is being awaited
    return reply("ℹ️ Session already started, waiting for pairing. Check WhatsApp > Linked Devices > Link with phone number.");
  }

  const sessionDir = path.join(SESSIONS_BASE, normalized);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: P({ level: "silent" }),
      auth: state,
      printQRInTerminal: false
    });

    // Persist credentials when they update
    sock.ev.on("creds.update", saveCreds);

    // Keep socket reference
    userSessions[normalized] = sock;

    // Listen to connection updates to detect when pairing is ready or when logged in
    sock.ev.on("connection.update", (update) => {
      try {
        const { connection, lastDisconnect } = update;
        if (connection === "open") {
          reply("✅ Paired and logged in successfully!");
          console.log(`✅ [${normalized}] Paired and connected.`);
        }

        // You can examine 'lastDisconnect' to provide more info if desired
        if (connection === "close" && lastDisconnect) {
          const err = lastDisconnect.error || lastDisconnect?.output || lastDisconnect;
          console.log(`⚠️ [${normalized}] Connection closed:`, err);
        }
      } catch (e) {
        console.error("connection.update handler error:", e);
      }
    });

    // If credentials show not registered, request a pairing code (Baileys exposes pair / pairing helpers depending on version).
    // Many Baileys variants expose generatePairing code or requestPairingCode (user sample). We'll try to use requestPairingCode if available.
    const isRegistered = state?.creds?.registered || false;
    if (!isRegistered) {
      try {
        // Some versions implement requestPairingCode on the socket instance
        if (typeof sock.requestPairingCode === "function") {
          const code = await sock.requestPairingCode(normalized);
          reply(
            `🔗 *Your WhatsApp Pairing Code*\n\n` +
            `👉 ${code}\n\n` +
            `Open WhatsApp → Linked Devices → Link with phone number and enter this code.`
          );
          console.log(`🔗 Pairing code generated for ${normalized}: ${code}`);
        } else {
          // Fallback message if the method isn't available in this Baileys version
          reply(
            "🔗 Pairing initialization started.\n" +
            "If your Baileys build doesn't support automatic pairing code generation, please check the bot logs or upgrade @whiskeysockets/baileys.\n" +
            "Open WhatsApp → Linked Devices → Link with phone number and follow the on-screen steps."
          );
          console.log(`ℹ️ [${normalized}] requestPairingCode() not available in this Baileys build.`);
        }
      } catch (pairErr) {
        console.error(`Pairing code error for ${normalized}:`, pairErr);
        reply("❌ Failed to generate pairing code: " + (pairErr?.message || pairErr));
      }
    } else {
      reply("✅ You are already paired and logged in!");
    }

    // Basic example message handler (safe/optional)
    sock.ev.on("messages.upsert", async ({ messages }) => {
      try {
        const msg = messages?.[0];
        if (!msg || !msg.message) return;
        // Simple echo trigger (customize as needed)
        if (msg.message.conversation?.toLowerCase() === "hi") {
          await sock.sendMessage(msg.key.remoteJid, { text: "Hello! 👋 (from your session)" });
        }
      } catch (e) {
        console.error("messages.upsert handler error:", e);
      }
    });

    console.log(`✅ Started session for ${normalized}`);
    return sock;
  } catch (e) {
    console.error("startUserBot error:", e);
    // Clean up any partial state
    if (userSessions[normalized]) {
      try { userSessions[normalized].end(); } catch (_) {}
      delete userSessions[normalized];
    }
    return reply("❌ Error while starting session: " + (e?.message || e));
  }
}

/**
 * Stop and remove a user's session (logout + cleanup files if requested).
 * - userId: sender identifier
 * - reply: reply function
 * - removeFiles: if true, delete the stored auth files for that user
 */
async function stopUserBot(userId, reply, removeFiles = false) {
  const normalized = normalizeId(userId);
  const sock = userSessions[normalized];
  if (!sock) return reply("❌ No active session found for your number.");

  try {
    if (typeof sock.logout === "function") {
      await sock.logout();
    } else if (typeof sock.close === "function") {
      await sock.close();
    }
  } catch (e) {
    console.warn("Error while logging out socket:", e);
  }

  // Remove in-memory reference
  delete userSessions[normalized];

  // Optionally remove session folder (auth files)
  if (removeFiles) {
    const sessionDir = path.join(SESSIONS_BASE, normalized);
    try {
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    } catch (e) {
      console.error("Failed to remove session files:", e);
    }
  }

  reply("✅ Session stopped for your number" + (removeFiles ? " and session files removed." : "."));
}

/**
 * Utility to report session status
 */
async function getUserStatus(userId) {
  const normalized = normalizeId(userId);
  const sock = userSessions[normalized];
  if (!sock) return { active: false };
  const registered = sock?.authState?.creds?.registered || false;
  return { active: true, registered };
}

/**
 * .pair command — generate pairing code / start session
 */
cmd(
  {
    pattern: "pair",
    desc: "Generate WhatsApp Pairing Code and start your personal session",
    category: "main",
    filename: __filename,
  },
  async (robin, mek, m, { senderNumber, reply }) => {
    try {
      await startUserBot(senderNumber, reply);
    } catch (e) {
      console.error("Pairing command error:", e);
      reply("❌ Error while generating pairing code: " + (e?.message || e));
    }
  }
);

/**
 * .unpair command — stop session and optionally remove files
 */
cmd(
  {
    pattern: "unpair",
    desc: "Stop your personal WhatsApp session (use .unpair remove to also delete session files)",
    category: "main",
    filename: __filename,
  },
  async (robin, mek, m, { senderNumber, body, reply }) => {
    try {
      const removeFiles = (body || "").trim().toLowerCase().includes("remove");
      await stopUserBot(senderNumber, reply, removeFiles);
    } catch (e) {
      console.error("Unpair command error:", e);
      reply("❌ Error while stopping session: " + (e?.message || e));
    }
  }
);

/**
 * .pairstatus command — check current session state
 */
cmd(
  {
    pattern: "pairstatus",
    desc: "Show pairing/session status for your number",
    category: "main",
    filename: __filename,
  },
  async (robin, mek, m, { senderNumber, reply }) => {
    try {
      const status = await getUserStatus(senderNumber);
      if (!status.active) return reply("📋 Session Status: Inactive\nType .pair to start your personal session.");
      reply(`📋 Session Status: Active\nPaired: ${status.registered ? "Yes" : "No (awaiting pairing)"}\nUse .unpair to stop the session.`);
    } catch (e) {
      console.error("Pairstatus command error:", e);
      reply("❌ Error while checking status: " + (e?.message || e));
    }
  }
);

module.exports = { userSessions, startUserBot, stopUserBot, getUserStatus };
