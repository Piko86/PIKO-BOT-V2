const { 
  makeWASocket, 
  useMultiFileAuthState, 
  fetchLatestBaileysVersion 
} = require("@whiskeysockets/baileys");
const P = require("pino");
const fs = require("fs");
const path = require("path");
const { cmd } = require("../command");

// Store running sessions in memory
let userSessions = {};

/**
 * Start bot instance for user
 */
async function startUserBot(userId, reply) {
  const sessionDir = path.join(__dirname, "..", "sessions", userId);

  // Ensure session directory exists
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: P({ level: "silent" }),
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on("creds.update", saveCreds);

  // Generate pairing code if not logged in yet
  if (!sock.authState.creds.registered) {
    const code = await sock.requestPairingCode(userId);
    reply(
      `🔗 *Your WhatsApp Pairing Code:*\n\n` +
      `👉 ${code}\n\n` +
      `Go to *WhatsApp → Linked Devices → Link with phone number* and enter this code.`
    );
  } else {
    reply("✅ You are already paired and logged in!");
  }

  // Example: Echo received messages (you can extend later)
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;
    console.log(`[${userId}] Received:`, msg.message);

    if (msg.message.conversation?.toLowerCase() === "hi") {
      await sock.sendMessage(msg.key.remoteJid, { text: "Hello! 👋 (from your session)" });
    }
  });

  // Store active session
  userSessions[userId] = sock;
  console.log(`✅ Started session for ${userId}`);
}

/**
 * Command: .pair
 */
cmd(
  {
    pattern: "pair",
    desc: "Generate WhatsApp Pairing Code",
    category: "main",
    filename: __filename,
  },
  async (robin, mek, m, { senderNumber, reply }) => {
    try {
      await startUserBot(senderNumber, reply);
    } catch (e) {
      console.error("Pairing Error:", e);
      reply("❌ Error while generating pairing code: " + e.message);
    }
  }
);

module.exports = { userSessions, startUserBot };
