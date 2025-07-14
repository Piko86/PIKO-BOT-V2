const { cmd } = require('../command');

cmd(
  {
    pattern: 'hack',
    desc: "Displays a dynamic and playful 'Hacking' message for fun.",
    category: 'fun',
    react: '💻',
    filename: __filename,
  },
  async (
    client,
    m,
    sock,
    {
      from,
      quoted,
      body,
      isCmd,
      command,
      args,
      q,
      isGroup,
      sender,
      senderNumber,
      botNumber2,
      botNumber,
      pushname,
      isMe,
      isOwner,
      groupMetadata,
      groupName,
      participants,
      groupAdmins,
      isBotAdmins,
      isAdmins,
      reply,
    }
  ) => {
    try {
      const hackMessages = [
        '💻 *HACK STARTING...* 💻',
        '*Initializing hacking tools...* 🛠️',
        '*Connecting to remote servers...* 🌐',
        '```[██] 10%``` ⏳',
        '```[████] 20%``` ⏳',
        '```[██████] 30%``` ⏳',
        '```[████████] 40%``` ⏳',
        '```[██████████] 50%``` ⏳',
        '```[████████████] 60%``` ⏳',
        '```[██████████████] 70%``` ⏳',
        '```[████████████████] 80%``` ⏳',
        '```[██████████████████] 90%``` ⏳',
        '```[████████████████████] 100%``` ✅',
        '🔒 *System Breach: Successful!* 🔓',
        '🚀 *Command Execution: Complete!* 🎯',
        '*📡 Transmitting data...* 📨',
        '_🕵️‍♂️ Ensuring stealth..._ 🤫',
        '*🔧 Finalizing operations...* 🏁',
        '> *ANONYMOUS_PIKOV2-HACKING-COMPLETE ☣*',
      ];

      for (const message of hackMessages) {
        await client.sendMessage(from, { text: message }, { quoted: m });
        await new Promise(resolve => setTimeout(resolve, 2500)); // 1-second delay
      }

    } catch (err) {
      console.error(err);
      reply('❌ *Error:* ' + err.message);
    }
  }
);
