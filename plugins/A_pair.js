Skip to content
Chat history

You said:
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
    const code = await sock.requestPairingCode(userId.toString());
    reply(
      🔗 *Your WhatsApp Pairing Code:*\n\n +
      👉 ${code}\n\n +
      Go to *WhatsApp → Linked Devices → Link with phone number* and enter this code.
    );
  } else {
    reply("✅ You are already paired and logged in!");
  }

  // Example: Echo received messages (you can extend later)
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;
    console.log([${userId}] Received:, msg.message);

    if (msg.message.conversation?.toLowerCase() === "hi") {
      await sock.sendMessage(msg.key.remoteJid, { text: "Hello! 👋 (from your session)" });
    }
  });

  // Store active session
  userSessions[userId] = sock;
  console.log(✅ Started session for ${userId});
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

module.exports = { userSessions, startUserBot };                                                                                                         not linking to whatsapp 
ChatGPT said:
Got it 👍.
I see your code is setting up multi-session WhatsApp bots with Baileys and pairing codes.

The problem is:
👉 sock.requestPairingCode(userId) is wrong.

requestPairingCode() does not accept a WhatsApp user ID (JID or number). Instead, it needs the phone number you want to link with WhatsApp (including country code, without +). Example: "9477xxxxxxx".

✅ Fix
Change this line:

const code = await sock.requestPairingCode(userId);
to:

// Make sure `userId` is the phone number in international format (e.g., 9477xxxxxxx)
const code = await sock.requestPairingCode(userId.toString());
⚠️ Important Notes
Phone number format
Must be a string like "94771234567".
Not "user@s.whatsapp.net" or internal IDs.

Pairing flow

Open WhatsApp on phone → Linked devices → Link with phone number.

Enter the pairing code your bot prints.

Baileys version
Make sure you’re using @whiskeysockets/baileys >= 6.7.5. Pairing codes are not available in older versions.

Multi-user sessions
You’re saving sessions under /sessions/<userId>. That’s fine, but make sure you call startUserBot("9477xxxxxxx", reply) with the correct number, not just the WhatsApp JID.

👉 Do you want me to adjust your .pair command so the bot asks the user for their number, then generates the correct code? That way you won’t need to hardcode userId.




No file chosenNo file chosen
ChatGPT can make mistakes. Check important info.
