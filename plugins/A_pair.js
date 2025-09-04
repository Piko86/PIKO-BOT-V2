const { cmd } = require("../command");
const config = require("../config");
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

// Store active pairing sessions
let pairingSessions = {};

// Auto cleanup function - runs every 5 minutes
setInterval(() => {
  const now = Date.now();
  Object.keys(pairingSessions).forEach(sessionId => {
    // Remove sessions older than 10 minutes (600,000 ms)
    if (now - pairingSessions[sessionId].timestamp > 600000) {
      console.log(`🧹 Cleaning up pairing session ${sessionId} (expired after 10 minutes)`);
      
      // Clean up session files if they exist
      const sessionPath = path.join(__dirname, `../sessions/pair_${sessionId}`);
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
      }
      
      delete pairingSessions[sessionId];
    }
  });
}, 300000); // Check every 5 minutes

cmd(
  {
    pattern: "pair",
    alias: ["getcode", "qr"],
    react: "📱",
    desc: "Get pairing code to connect your WhatsApp",
    category: "main",
    filename: __filename,
  },
  async (robin, mek, m, { from, senderNumber, pushname, reply }) => {
    try {
      // Generate unique session ID
      const sessionId = `${senderNumber}_${Date.now()}`;
      const sessionPath = path.join(__dirname, `../sessions/pair_${sessionId}`);

      // Create session directory
      if (!fs.existsSync(path.dirname(sessionPath))) {
        fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
      }

      reply(`🔄 *Generating pairing code...*\n\n⏳ Please wait while I create your WhatsApp connection link...`);

      // Create auth state for this session
      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
      const { version } = await fetchLatestBaileysVersion();

      // Create socket for pairing
      const sock = makeWASocket({
        version,
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        auth: state,
        browser: ["PIKO-BOT", "Chrome", "1.0.0"],
      });

      // Store session info
      pairingSessions[sessionId] = {
        socket: sock,
        timestamp: Date.now(),
        userNumber: senderNumber,
        chatId: from,
        sessionPath: sessionPath
      };

      // Handle pairing code generation
      sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          // Generate pairing link
          const pairingLink = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
          
          const pairingMessage = `📱 *WHATSAPP PAIRING CODE*

*╭─「 ᴘᴀɪʀɪɴɢ ɪɴꜱᴛʀᴜᴄᴛɪᴏɴꜱ 」*
*│◈ Session ID:* ${sessionId.substring(0, 8)}...
*│◈ Valid for:* 10 minutes
*│◈ Status:* Waiting for scan
*╰──────────●●►*

*🔗 PAIRING LINK:*
${pairingLink}

*📋 HOW TO PAIR:*
*1.* Open WhatsApp on your phone
*2.* Go to *Settings > Linked Devices*
*3.* Tap *"Link a Device"*
*4.* Click the link above or scan the QR code
*5.* Your device will be connected!

*⚠️ IMPORTANT NOTES:*
• This code expires in 10 minutes
• Only you should scan this code
• Keep this code private and secure
• The bot will notify you when connected

*🔒 Your connection will be secure and encrypted*

*㋛ 𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 𝙿_𝙸_𝙺_𝙾 〽️*`;

          await robin.sendMessage(
            from,
            {
              image: { url: pairingLink },
              caption: pairingMessage,
              contextInfo: {
                mentionedJid: [`${senderNumber}@s.whatsapp.net`]
              }
            },
            { quoted: mek }
          );
        }

        if (connection === "open") {
          // Successfully connected
          const successMessage = `✅ *PAIRING SUCCESSFUL!*

*╭─「 ᴄᴏɴɴᴇᴄᴛɪᴏɴ ꜱᴜᴄᴄᴇꜱꜱ 」*
*│◈ Status:* Connected ✓
*│◈ Session:* ${sessionId.substring(0, 8)}...
*│◈ Device:* WhatsApp Linked
*╰──────────●●►*

*🎉 Your WhatsApp is now connected to PIKO-BOT!*

*📱 You can now use all bot commands directly from your WhatsApp*

*🔧 Available Commands:*
• Type *.menu* to see all commands
• Type *.alive* to check bot status
• Type *.help* for assistance

*🔒 Your session is secure and encrypted*

*㋛ 𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 𝙿_𝙸_𝙺_𝙾 〽️*`;

          await robin.sendMessage(
            from,
            {
              text: successMessage,
              contextInfo: {
                mentionedJid: [`${senderNumber}@s.whatsapp.net`]
              }
            },
            { quoted: mek }
          );

          // Clean up this session after successful pairing
          setTimeout(() => {
            if (pairingSessions[sessionId]) {
              sock.end();
              delete pairingSessions[sessionId];
              console.log(`✅ Pairing session ${sessionId} completed and cleaned up`);
            }
          }, 5000);
        }

        if (connection === "close") {
          const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
          
          if (!shouldReconnect) {
            // Connection failed or was logged out
            await robin.sendMessage(
              from,
              {
                text: `❌ *PAIRING FAILED*\n\n*Session expired or connection lost.*\n\n*💡 Type .pair again to generate a new code*`,
                contextInfo: {
                  mentionedJid: [`${senderNumber}@s.whatsapp.net`]
                }
              },
              { quoted: mek }
            );

            // Clean up failed session
            if (pairingSessions[sessionId]) {
              if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
              }
              delete pairingSessions[sessionId];
            }
          }
        }
      });

      // Handle credential updates
      sock.ev.on("creds.update", saveCreds);

      console.log(`📱 Pairing session ${sessionId} created for ${senderNumber}`);

    } catch (e) {
      console.error("Pairing error:", e);
      reply(`❌ *PAIRING ERROR*\n\n*Failed to generate pairing code.*\n\n*Error:* ${e.message}\n\n*💡 Please try again with .pair*`);
    }
  }
);

// Command to check active pairing sessions (for debugging)
cmd(
  {
    pattern: "pairingstatus",
    desc: "Check active pairing sessions",
    category: "owner",
    filename: __filename,
  },
  async (robin, mek, m, { from, senderNumber, reply }) => {
    try {
      const activeSessions = Object.keys(pairingSessions).length;
      
      if (activeSessions === 0) {
        reply(`📱 *PAIRING STATUS*\n\n*Active Sessions:* 0\n*Status:* No active pairing sessions`);
      } else {
        let sessionList = "";
        Object.keys(pairingSessions).forEach(sessionId => {
          const session = pairingSessions[sessionId];
          const timeLeft = Math.max(0, 600000 - (Date.now() - session.timestamp));
          const minutesLeft = Math.floor(timeLeft / 60000);
          const secondsLeft = Math.floor((timeLeft % 60000) / 1000);
          
          sessionList += `*│* ${sessionId.substring(0, 12)}... - ${minutesLeft}m ${secondsLeft}s left\n`;
        });

        reply(`📱 *PAIRING STATUS*\n\n*Active Sessions:* ${activeSessions}\n\n*Session Details:*\n${sessionList}\n*⏰ Sessions auto-expire after 10 minutes*`);
      }
    } catch (e) {
      console.error(e);
      reply(`Error: ${e.message}`);
    }
  }
);

// Command to manually cleanup pairing sessions (owner only)
cmd(
  {
    pattern: "clearpair",
    desc: "Clear all pairing sessions",
    category: "owner",
    filename: __filename,
  },
  async (robin, mek, m, { from, senderNumber, reply }) => {
    try {
      const sessionCount = Object.keys(pairingSessions).length;
      
      // Clean up all sessions
      Object.keys(pairingSessions).forEach(sessionId => {
        const session = pairingSessions[sessionId];
        
        // Close socket connection
        if (session.socket) {
          session.socket.end();
        }
        
        // Remove session files
        if (fs.existsSync(session.sessionPath)) {
          fs.rmSync(session.sessionPath, { recursive: true, force: true });
        }
      });

      // Clear the sessions object
      pairingSessions = {};

      reply(`🧹 *CLEANUP COMPLETE*\n\n*Cleared Sessions:* ${sessionCount}\n*Status:* All pairing sessions terminated`);
      
      console.log(`🧹 Manual cleanup: ${sessionCount} pairing sessions cleared`);
    } catch (e) {
      console.error(e);
      reply(`Error: ${e.message}`);
    }
  }
);

module.exports = { pairingSessions };
