/**
 * Safer pairing command for Baileys.
 *
 * Improvements:
 * - Do not call logout() or destroy socket while pairing handshake is in flight.
 * - Wait for a stable 'open' connection event (me present) before confirming pairing.
 * - Persist creds via saveCreds and only recreate socket after a short controlled delay.
 * - Better logging of lastDisconnect details for debugging 401/Intentional Logout.
 * - Fewer restarts during pairing; if unrecoverable 401 occurs we stop and ask user to retry.
 *
 * Usage: .pair  (run in a private chat)
 *
 * Notes:
 * - If you run this in Codespaces and pairing repeatedly fails with "Connection Failure" or 401,
 *   try from a local machine or VPS (Codespaces sometimes has unstable websocket connections).
 * - Inspect sessions/<phone> contents after pairing to confirm saved creds.
 */
const { makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");
const path = require("path");
const fs = require("fs");
const { cmd } = require("../command");

const activeSessions = new Map(); // userId -> { sock, timeoutHandle, stateSaved }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function ensureDir(dir) {
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    return true;
  } catch (e) {
    return false;
  }
}

async function listSessionFiles(sessionDir) {
  try {
    const files = await fs.promises.readdir(sessionDir);
    return files;
  } catch (e) {
    return [];
  }
}

async function startUserBot(userId, sendReply) {
  if (!userId) throw new Error("Missing userId");
  if (activeSessions.has(userId)) {
    await sendReply("⚠️ There is already an active pairing session for you. Wait for it to finish or use .unpair first.");
    return;
  }

  const sessionDir = path.join(__dirname, "..", "sessions", userId);
  if (!(await ensureDir(sessionDir))) {
    await sendReply("❌ Failed to create session storage (check permissions).");
    return;
  }

  // initialize auth state
  let authState;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    authState = { state, saveCreds };
  } catch (err) {
    console.error("useMultiFileAuthState error:", err);
    await sendReply(`❌ Failed to initialize auth storage: ${err?.message || err}`);
    return;
  }

  // create socket
  let sock;
  let finalized = false; // set to true when we decide pairing succeeded or irrecoverable
  let restartAttempts = 0;

  const createSocket = () => {
    const s = makeWASocket({
      auth: authState.state,
      printQRInTerminal: false,
    });
    if (typeof authState.saveCreds === "function") s.ev.on("creds.update", authState.saveCreds);
    s.ev.on("connection.update", async (update) => {
      try {
        const { connection, lastDisconnect, me, qr } = update;
        console.log("connection.update:", { connection, me: me?.id, lastDisconnect: lastDisconnect ? {
          statusCode: lastDisconnect.statusCode,
          message: lastDisconnect.error?.message || lastDisconnect.error || null,
          output: lastDisconnect.error?.output || null
        } : null });

        // If socket becomes open => pairing + login succeeded
        if (connection === "open" && me?.id) {
          // confirm saved files exist (best-effort)
          const files = await listSessionFiles(sessionDir);
          await sendReply(`✅ Pairing succeeded. Session ready for ${me.id}.\nSaved session files: ${files.join(", ") || "(none)"}\nYou can close this window on your phone now if you want.`);
          finalized = true;
          // keep socket running (do not logout); the session is active.
          // Register sock in activeSessions so it won't create duplicates.
          activeSessions.set(userId, { sock: s, timeoutHandle: null, stateSaved: true });
          return;
        }

        if (connection === "close") {
          // Log lastDisconnect details for debugging
          const last = lastDisconnect || {};
          const errObj = last.error || last;
          const code = last.statusCode || (errObj && errObj.output && errObj.output.payload && errObj.output.payload.statusCode) || null;
          const msg = errObj?.message || (errObj?.output && JSON.stringify(errObj.output.payload)) || String(errObj);
          console.warn(`Connection closed for ${userId} - code: ${code} - msg: ${msg}`);

          // If 401 Intentional Logout or other authorization failures -> stop and ask user to retry
          if (code === 401 || (msg && /Intentional Logout|Unauthorized/i.test(msg))) {
            await sendReply(`❌ Pairing failed: Unauthorized/Intentional Logout (${msg}). This is usually caused by conflicting sessions or invalid credentials.\nPlease:\n• Ensure you did not link the same number elsewhere\n• Remove any existing session files for this phone under sessions/${userId} and run .pair again\n• Prefer running pairing from a local machine instead of Codespaces if problem persists.`);
            finalized = true;
            try { await s.logout().catch(()=>{}); } catch {}
            activeSessions.delete(userId);
            return;
          }

          // For transient issues (timeouts / stream errors) try a small number of restarts,
          // but avoid tight loops during the pairing handshake. We only attempt restart if we haven't finalized.
          if (!finalized) {
            restartAttempts += 1;
            const MAX_RESTARTS = 3;
            if (restartAttempts > MAX_RESTARTS) {
              await sendReply(`❌ Pairing retried ${MAX_RESTARTS} times and failed. Please try again later or run pairing from a different network.`);
              finalized = true;
              activeSessions.delete(userId);
              try { await s.logout().catch(()=>{}); } catch {}
              return;
            }
            const backoff = Math.min(10000, 2000 * restartAttempts);
            await sendReply(`⚠️ Connection closed (${msg || code}). Retrying in ${Math.round(backoff/1000)}s...`);
            // remove previous sock listeners and create new sock after delay
            try { s.ev.removeAllListeners(); } catch {}
            await sleep(backoff);
            if (finalized) return;
            // create new socket and rebind
            sock = createSocket();
            activeSessions.set(userId, { sock, timeoutHandle: null, stateSaved: false });
            return;
          }
        }
      } catch (e) {
        console.error("Error in connection.update handler:", e);
      }
    });
    return s;
  };

  // Put initial socket in activeSessions while pairing is in progress
  sock = createSocket();
  activeSessions.set(userId, { sock, timeoutHandle: null, stateSaved: false });

  // Request pairing code (some bailey versions use different method names)
  try {
    await sendReply("🔐 Generating pairing code — make sure you run this command in a private chat (not a group).");
    let code;
    if (typeof sock.requestPairingCode === "function") {
      code = await sock.requestPairingCode(userId);
    } else if (typeof sock.generatePairingCode === "function") {
      code = await sock.generatePairingCode(userId);
    } else if (typeof sock.generatePairingCodeForDevice === "function") {
      code = await sock.generatePairingCodeForDevice(userId);
    } else {
      await sendReply("❌ Your Baileys version does not expose a pairing method. Update Baileys or adapt the pairing function names.");
      finalized = true;
      activeSessions.delete(userId);
      try { await sock.logout().catch(()=>{}); } catch {}
      return;
    }

    if (!code) {
      await sendReply("❌ No pairing code returned by Baileys.");
      finalized = true;
      activeSessions.delete(userId);
      try { await sock.logout().catch(()=>{}); } catch {}
      return;
    }

    await sendReply(`🔑 *Your Pairing Code:*\n\`\`\`${code}\`\`\`\nOpen WhatsApp -> Linked Devices -> Link a Device and enter the code. Pairing will complete on successful entry.`);

    // Set expiry for pairing attempt (user has X minutes to scan/link)
    const EXPIRE_MIN = parseInt(process.env.PAIRING_SESSION_EXPIRE_MINUTES || "10", 10);
    const timeoutHandle = setTimeout(async () => {
      if (finalized) return;
      await sendReply(`⌛ Pairing session expired after ${EXPIRE_MIN} minutes. Run .pair again if needed.`);
      finalized = true;
      try { await sock.logout().catch(()=>{}); } catch {}
      activeSessions.delete(userId);
    }, EXPIRE_MIN * 60 * 1000);

    // store timeout handle so future code can clear it if pairing finalizes
    const st = activeSessions.get(userId) || {};
    st.timeoutHandle = timeoutHandle;
    activeSessions.set(userId, st);
  } catch (err) {
    console.error("Pairing request error:", err);
    await sendReply(`❌ Pairing request failed: ${err?.message || err}`);
    finalized = true;
    try { await sock.logout().catch(()=>{}); } catch {}
    activeSessions.delete(userId);
    return;
  }
}

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
      if (!sender) return await conn.sendMessage(from, { text: "❌ Could not determine sender ID." }, { quoted: mek });
      const userId = String(sender).split("@")[0];
      const sendReply = async (text) => {
        try { await conn.sendMessage(from, { text }, { quoted: mek }); } catch (e) { console.error("sendReply error:", e); }
      };
      await sendReply("🔄 Preparing pairing. Please wait...");
      await startUserBot(userId, sendReply);
    } catch (e) {
      console.error("pair command error:", e);
      try { await conn.sendMessage(from, { text: `❌ Error: ${e?.message || e}` }, { quoted: mek }); } catch {}
    }
  }
);

module.exports = { startUserBot, activeSessions };
