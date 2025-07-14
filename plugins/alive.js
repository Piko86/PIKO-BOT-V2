const { cmd, commands } = require('../command');
const config = require('../config');

cmd({
    pattern: "alive",
    react: "㊗️",
    desc: "Check bot online or no.",
    category: "main",
    filename: __filename
},
async (robin, mek, m, {
    from, quoted, body, isCmd, command, args, q, isGroup, sender, senderNumber,
    botNumber2, botNumber, pushname, isMe, isOwner, groupMetadata, groupName,
    participants, groupAdmins, isBotAdmins, isAdmins, reply
}) => {
    try {
        // Send image with caption
        await robin.sendMessage(from, {
            image: { url: config.ALIVE_IMG },
            caption: config.ALIVE_MSG
        }, { quoted: mek });

        // Update presence to "recording"
        await robin.sendPresenceUpdate('recording', from);

        // Send voice message
        await robin.sendMessage(from, {
            audio: {
                url: "https://github.com/Manmitha96/BOT-PHOTOS/raw/refs/heads/main/BOT-AUDIO/alivevoice.mp3"
            },
            mimetype: 'audio/mpeg',
            ptt: true
        }, { quoted: mek });

    } catch (e) {
        console.log(e);
        reply(`${e}`);
    }
});
