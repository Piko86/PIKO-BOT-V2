const { makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");
const path = require("path");
const fs = require("fs");
const { cmd } = require("../command");

async function startUserBot(userId, sendReply) {
  const sessionDir = path.join(__dirname, "..", "sessions", userId);

  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // pairing only
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection } = update;

    if (connection === "open") {
      console.log(`✅ ${userId} session is ready!`);
      await sendReply(`✅ Your session has been linked successfully!`);
    }

    if (connection === "close") {
      console.log(`❌ ${userId} session closed.`);
    }
  });

  // ✅ request pairing code after small delay to ensure socket starts
  setTimeout(async () => {
    try {
      const code = await sock.requestPairingCode(userId);
      console.log(`📲 Pairing code for ${userId}: ${code}`);
      await sendReply(
        `🔑 *Your WhatsApp Pairing Code:*\n\n\`\`\`${code}\`\`\`\n\n👉 Open *WhatsApp > Linked Devices > Link a Device* and enter this code.`
      );
    } catch (err) {
      console.error("Pairing Error:", err);
      await sendReply(`❌ Pairing failed: ${err.message || err}`);
    }
  }, 2000);
}

cmd(
  {
    pattern: "pair",
    desc: "Pair your WhatsApp number with the bot",
    category: "owner",
    react: "🔗",
    filename: __filename,
  },
  async (conn, mek, m, { from, sender }) => {
    const userId = sender.split("@")[0]; // user’s phone number
    const sendReply = async (text) => {
      await conn.sendMessage(from, { text }, { quoted: mek });
    };

    await sendReply(`🔄 Generating your pairing code, please wait...`);
    await startUserBot(userId, sendReply);
  }
);
