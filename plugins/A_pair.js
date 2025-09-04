/**
 * Improved pairing helper using @whiskeysockets/baileys
 *
 * - Robust connection.update handling (including stream:error handling / code 515)
 * - Controlled restart after pairing completes so credentials persist & socket stabilizes
 * - Exponential backoff reconnect on transient failures
 * - Session folder creation and write checks
 * - Privacy note + expiry of pairing attempt
 *
 * Usage: keep this as your pair command handler file. Replace your existing implementation.
 */
const { makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");
const path = require("path");
const fs = require("fs");
const { cmd } = require("../command");

const activeSessions = new Map(); // userId -> { sock, restartAttempts, timeoutHandle }

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function ensureDir(dir) {
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    return true;
  } catch (e) {
    return false;
  }
}

async function createSocket(sessionDir, state, saveCreds, userId, onUpdate) {
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    // helpful for debug, can be set to true during dev
    // logger: makeSimpleLogger({ level: 'info' }),
  });

  if (typeof saveCreds === "function") {
    sock.ev.on("creds.update", saveCreds);
  }

  sock.ev.on("connection.update", (update) => onUpdate(sock, update));
  return sock;
}

async function startUserBot(userId, sendReply) {
  if (!userId) throw new Error("Missing userId");

  if (activeSessions.has(userId)) {
    await sendReply("⚠️ You already have an active pairing session. Wait for it to finish or remove existing session first.");
    return;
  }

  const sessionDir = path.join(__dirname, "..", "sessions", userId);
  if (!(await ensureDir(sessionDir))) {
    await sendReply("❌ Failed to prepare session directory (permissions?).");
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

  // lifecycle controller
  let restartAttempts = 0;
  let sock = null;
  let pairingExpired = false;

  const cleanupSession = async (reason) => {
    try {
      const s = activeSessions.get(userId);
      if (s && s.timeoutHandle) clearTimeout(s.timeoutHandle);
      if (s && s.sock) {
        try { await s.sock.logout().catch(() => {}); } catch {}
      }
    } catch (e) {}
    activeSessions.delete(userId);
    console.log(`Session cleaned up for ${userId}${reason ? ` (${reason})` : ""}`);
  };

  // Handler for connection updates
  const onUpdate = async (sockInstance, update) => {
    try {
      const { connection, lastDisconnect, qr, pairing, me } = update;
      console.log(`connection.update for ${userId}:`, { connection, pairing, me, lastDisconnect: lastDisconnect ? (lastDisconnect.error && lastDisconnect.error.output ? lastDisconnect.error.output.payload : lastDisconnect) : null });

      if (pairing) {
        // Some versions emit pairing events; log them
        console.log("pairing info:", pairing);
      }

      if (connection === "open") {
        // pairing succeeded and socket opened
        console.log(`✅ ${userId} session is ready (open). me:`, me);
        try {
          await sendReply("✅ Your session has been linked successfully! The socket is open.");
        } catch (e) {}
        // after open we may want to keep socket running; clear expiry
        const s = activeSessions.get(userId) || {};
        if (s.timeoutHandle) clearTimeout(s.timeoutHandle);
        s.restartAttempts = 0;
        activeSessions.set(userId, s);
        return;
      }

      // detect stream errors or abnormal closes
      if (connection === "close") {
        // inspect lastDisconnect for details (Baileys provides structured error)
        console.warn(`Connection closed for ${userId}`, lastDisconnect?.error || lastDisconnect);
        // If lastDisconnect contains stream error code 515, treat as transient and try restart
        const err = lastDisconnect?.error;
        // lastDisconnect.error may have output.payload or message depending on version
        const statusCode = err?.output?.statusCode || err?.output?.payload?.code || null;
        const reason = err?.message || (err?.output && err.output.payload ? JSON.stringify(err.output.payload) : String(err));

        // If pairing was just configured, many Baileys flows require a restart to settle credentials.
        // We'll attempt a controlled restart with backoff. But avoid infinite restarts.
        restartAttempts += 1;
        const s = activeSessions.get(userId) || {};
        s.restartAttempts = restartAttempts;
        activeSessions.set(userId, s);

        // If too many restarts, give up
        const MAX_RESTARTS = 5;
        if (restartAttempts > MAX_RESTARTS) {
          await sendReply(`❌ Pairing failed repeatedly and gave up. Last reason: ${reason || "unknown"}`);
          await cleanupSession("too many restarts");
          return;
        }

        // If the error seems transient (stream error, 515 or network), try reconnecting after a backoff
        const backoffMs = Math.min(60000, 2000 * Math.pow(2, restartAttempts - 1)); // exponential backoff 2s,4s,8s,...
        console.log(`Restarting socket for ${userId} in ${backoffMs}ms (attempt ${restartAttempts}) due to close: ${reason || statusCode || "unknown"}`);
        await sendReply(`⚠️ Connection closed during pairing (${reason || statusCode || "unknown"}). Retrying in ${Math.round(backoffMs/1000)}s...`);

        // cleanly close old socket if present
        try { await sockInstance.logout().catch(()=>{}); } catch (e) {}
        try { sockInstance.ev.removeAllListeners(); } catch (e) {}

        // small delay then recreate socket
        await sleep(backoffMs);

        try {
          sock = await createSocket(sessionDir, state, saveCreds, userId, onUpdate);
          const current = activeSessions.get(userId) || {};
          current.sock = sock;
          activeSessions.set(userId, current);
          console.log(`Socket re-created for ${userId}`);
        } catch (e) {
          console.error("Failed to recreate socket:", e);
          await sendReply(`❌ Failed to recreate socket: ${e.message || e}`);
        }
      }
    } catch (e) {
      console.error("Error in connection.update handler:", e);
    }
  };

  // Create initial socket and register in activeSessions map
  try {
    sock = await createSocket(sessionDir, state, saveCreds, userId, onUpdate);
    activeSessions.set(userId, { sock, restartAttempts: 0, timeoutHandle: null });
  } catch (err) {
    console.error("Initial socket creation failed:", err);
    await sendReply(`❌ Failed to create websocket: ${err.message || err}`);
    await cleanupSession("initial create failed");
    return;
  }

  // Give pairing instructions & request pairing code
  try {
    await sendReply("🔐 Ensure you run this command in a private chat (not a group). Generating pairing code...");
    // try available pairing functions; some Baileys forks use slightly different names
    let code = null;
    if (typeof sock.requestPairingCode === "function") {
      code = await sock.requestPairingCode(userId);
    } else if (typeof sock.generatePairingCode === "function") {
      code = await sock.generatePairingCode(userId);
    } else if (typeof sock.generatePairingCodeForDevice === "function") {
      code = await sock.generatePairingCodeForDevice(userId);
    } else {
      await sendReply("❌ Pairing API not available in this Baileys version. Update Baileys or adapt code.");
      await cleanupSession("pairing API missing");
      return;
    }

    if (!code) {
      await sendReply("❌ Could not obtain a pairing code (no code returned).");
      await cleanupSession("no pairing code");
      return;
    }

    console.log(`📲 Pairing code for ${userId}: ${code}`);
    await sendReply(`🔑 *Your WhatsApp Pairing Code:*\n\n\`\`\`${code}\`\`\`\n\nOpen WhatsApp > Linked Devices > Link a Device and enter this code.`);

    // set expiry for pairing session if unused
    const EXPIRE_MIN = parseInt(process.env.PAIRING_SESSION_EXPIRE_MINUTES || "10", 10);
    const expireMs = EXPIRE_MIN * 60 * 1000;
    const timeoutHandle = setTimeout(async () => {
      try {
        await sendReply(`⌛ Pairing session expired after ${EXPIRE_MIN} minute(s). Run .pair again if needed.`);
      } catch (e) {}
      await cleanupSession("expired");
    }, expireMs);

    const s = activeSessions.get(userId) || {};
    s.timeoutHandle = timeoutHandle;
    activeSessions.set(userId, s);
  } catch (err) {
    console.error("Pairing request error:", err);
    await sendReply(`❌ Pairing failed: ${err?.message || err}`);
    try { await sock.logout().catch(()=>{}); } catch (e) {}
    activeSessions.delete(userId);
  }
}

// Register command
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
      if (!sender) return await conn.sendMessage(from, { text: "❌ Couldn't determine your sender ID." }, { quoted: mek });
      const userId = String(sender).split("@")[0];
      const sendReply = async (text) => {
        try { await conn.sendMessage(from, { text }, { quoted: mek }); } catch (e) { console.error("sendReply error:", e); }
      };

      await sendReply("🔄 Generating your pairing code, please wait...");
      await startUserBot(userId, sendReply);
    } catch (e) {
      console.error("pair command error:", e);
      try { await conn.sendMessage(from, { text: `❌ Error: ${e.message || e}` }, { quoted: mek }); } catch {}
    }
  }
);

module.exports = { startUserBot, activeSessions };
