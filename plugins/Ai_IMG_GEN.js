// plugins/pair.js
// Let any user pair their own WhatsApp number to run a personal mini-bot.
// Requires: @whiskeysockets/baileys >= latest, pino, fs-extra
// Docs: requestPairingCode(phone, [customCode]) → Promise<string>

const { cmd } = require("../command");
const P = require("pino");
const fs = require("fs");
const fse = require("fs-extra");
const path = require("path");
const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

// ---- In-memory registry of user sockets ----
const userSockets = new Map(); // key: ownerUserJid (who typed /pair on your main bot), val: { sock, dir }

const SESSIONS_ROOT = path.join(process.cwd(), "sessions-users");

// Minimal per-user command handler (customize or reuse your global handlers)
async function attachMiniHandlers(sock, ownerTag = "") {
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages?.[0];
    if (!m?.key || m.key.fromMe) return;

    const from = m.key.remoteJid;
    const text =
      (m.message?.conversation ||
        m.message?.extendedTextMessage?.text ||
        m.message?.imageMessage?.caption ||
        m.message?.videoMessage?.caption ||
        "").trim();

    // Tiny demo commands running on the user’s number
    if (/^ping$/i.test(text)) {
      await sock.sendMessage(from, { text: `🏓 pong — linked bot ${ownerTag}` });
    } else if (/^help$/i.test(text)) {
      await sock.sendMessage(from, {
        text:
          "🤖 *Linked Mini-Bot*\n" +
          "• ping — test reply\n" +
          "• help — show this menu\n\n" +
          "Tip: You can expand this to reuse your main plugins.",
      });
    }
  });
}

// Create or resume a user socket (one per requesting user)
async function startUserSocket(ownerJid, phoneNumber, sendBack, customPairCode) {
  const sessionDir = path.join(SESSIONS_ROOT, sanitize(ownerJid));
  await fse.ensureDir(sessionDir);

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: P({ level: "silent" }),
    printQRInTerminal: false,
    auth: state,
    // Browser tuple just for fingerprint consistency
    browser: ["Ubuntu", "Chrome", "22.04.4"],
    // You can set 'mobile: false' (default) — code pairing method handles the rest
  });

  sock.ev.on("creds.update", saveCreds);

  // Report connection lifecycle back to the user on the main bot
  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, isNewLogin } = u;

    if (connection === "open") {
      await safeSend(sendBack, "✅ *Pairing successful!* Your number is linked.\n\n• Send *help* to your own chat from your linked number to try the mini-bot.\n• Use */unlink* here anytime to disconnect.");
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.message || "unknown";
      await safeSend(sendBack, `⚠️ Connection closed (${reason}). Attempting to keep session idle. You can */mystatus* to check.`);
    }

    if (isNewLogin) {
      // Just a heads-up; Baileys flags fresh registrations
      await safeSend(sendBack, "ℹ️ New login established for your linked session.");
    }
  });

  // If not registered yet, request a pairing code
  if (!state.creds?.registered) {
    if (!phoneNumber) {
      await safeSend(sendBack, "❌ Please provide a phone number: */pair <countrycode><number>* (no + sign). Example: `/pair 94771234567`");
      return { sock, dir: sessionDir, state };
    }
    // WhatsApp expects E.164 without + e.g., 94771234567
    const code = await sock.requestPairingCode(phoneNumber, customPairCode);
    const pretty = code?.match(/.{1,4}/g)?.join("-") || code;
    await safeSend(
      sendBack,
      [
        "🔑 *Your WhatsApp Pairing Code*",
        `> ${pretty}`,
        "",
        "On your phone:",
        "1) Open WhatsApp → *Linked devices*",
        "2) Tap *Link a device* → *Link with phone number*",
        "3) Enter the code above",
        "",
        "_Code usually expires in ~2 minutes. If it fails, run */pair <number>* again._",
      ].join("\n")
    );
  } else {
    await safeSend(sendBack, "🔗 Session already registered — reconnecting your mini-bot …");
  }

  // Attach tiny handlers (replace with your own plugin system if desired)
  await attachMiniHandlers(sock, `for ${maskJid(ownerJid)}`);

  // Save reference
  userSockets.set(ownerJid, { sock, dir: sessionDir });
  return { sock, dir: sessionDir, state };
}

function sanitize(str = "") {
  return String(str).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function maskJid(jid = "") {
  // simple mask for display
  return String(jid).replace(/(\d{3})\d+(@.*)/, "$1*****$2");
}

async function safeSend(sendBack, text) {
  try {
    await sendBack(text);
  } catch { /* ignore */ }
}

// ---------- Commands exposed to your main bot ----------

// /pair <phone> [custom8]
// Example: /pair 94771234567 1A2B-3C4D  (custom code must be 8 chars A-Z0-9, hyphens ignored)
cmd(
  {
    pattern: "pair",
    react: "🔗",
    desc: "Link your own number via WhatsApp Pairing Code",
    category: "account",
    filename: __filename,
  },
  async (robin, mek, m, { from, q, reply, sender }) => {
    try {
      const args = (q || "").trim().split(/\s+/).filter(Boolean);
      const number = args[0] || "";
      let custom = args[1] || "";

      if (custom) custom = custom.replace(/-/g, "").toUpperCase();
      if (custom && !/^[A-Z0-9]{8}$/.test(custom)) {
        return reply("❌ Custom pairing code must be exactly 8 letters/digits. Example: `AB12CD34`");
      }

      // Your WhatsApp JID on the main bot (owner of the linked session)
      const ownerJid = sender || m?.sender || mek?.key?.participant || from;

      await reply("⏳ Setting up your personal session …");

      const sendBack = async (text) => {
        await robin.sendMessage(from, { text }, { quoted: mek });
      };

      const existing = userSockets.get(ownerJid);
      if (existing?.sock) {
        await sendBack("ℹ️ You already have a linked session. Use */mystatus* or */unlink* to manage it.\nRe-issuing pairing code …");
      }

      await startUserSocket(ownerJid, number, sendBack, custom);
    } catch (e) {
      console.error("PAIR_ERROR", e);
      await reply(`❌ Pair error: ${e?.message || e}`);
    }
  }
);

// /unlink — logout and delete session
cmd(
  {
    pattern: "unlink",
    react: "🗑️",
    desc: "Unlink & delete your personal session",
    category: "account",
    filename: __filename,
  },
  async (robin, mek, m, { from, reply, sender }) => {
    const ownerJid = sender || m?.sender || mek?.key?.participant || from;
    const ref = userSockets.get(ownerJid);
    if (!ref) return reply("ℹ️ No linked session found.");

    try {
      await ref.sock.logout?.();
    } catch {}
    try {
      await fse.remove(ref.dir);
    } catch {}
    userSockets.delete(ownerJid);
    await reply("✅ Unlinked and removed your session.");
  }
);

// /mystatus — show connection state
cmd(
  {
    pattern: "mystatus",
    react: "🧭",
    desc: "Show status of your linked session",
    category: "account",
    filename: __filename,
  },
  async (robin, mek, m, { from, reply, sender }) => {
    const ownerJid = sender || m?.sender || mek?.key?.participant || from;
    const ref = userSockets.get(ownerJid);
    if (!ref) return reply("ℹ️ No linked session. Use */pair <number>* to start.");

    const me = ref.sock.user;
    await reply(
      [
        "🧭 *Linked Session Status*",
        `• Me: ${me?.id || "unknown"}`,
        `• Name: ${me?.name || "unknown"}`,
        `• Session dir: ${path.basename(ref.dir)}`,
        "",
        "Tip: If messages stop, try */unlink* then */pair <number>* again.",
      ].join("\n")
    );
  }
);

// /mybots — list in-memory linked sessions (admin/self view)
cmd(
  {
    pattern: "mybots",
    react: "📃",
    desc: "List your active linked mini-bot",
    category: "account",
    filename: __filename,
  },
  async (robin, mek, m, { from, reply, sender }) => {
    const ownerJid = sender || m?.sender || mek?.key?.participant || from;
    const ref = userSockets.get(ownerJid);
    if (!ref) return reply("ℹ️ You have 0 active linked sessions.");
    await reply(`📃 You have 1 linked session: *${path.basename(ref.dir)}*`);
  }
);

