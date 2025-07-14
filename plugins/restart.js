const config = require('../config')
const {cmd , commands} = require('../command')
const {sleep} = require('../lib/functions')

cmd({
    pattern: "restart",
    desc: "restart the bot",
    category: "owner",
    filename: __filename
},
async(conn, mek, m,{
    from, quoted, body, isCmd, command, args, q, isGroup, sender, senderNumber, botNumber2, botNumber, pushname, isMe, isOwner, groupMetadata, groupName, participants, groupAdmins, isBotAdmins, isAdmins, reply
}) => {
    try {

         // 🔍 ADD THIS DEBUG HERE TOO:
        console.log('🔧 RESTART PLUGIN DEBUG:');
        console.log('Is Owner in Plugin:', isOwner);
        console.log('Sender Number:', senderNumber);
        console.log('Is Group:', isGroup);
        
        if (!isOwner) {
            return reply("*Only the bot owner can use this command.🕋*");
        }

        // 🔁 Random Emoji
        const emojis = ["🔄","📡","♻️","🔌"];
        const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];

        // 💤 Inform user and restart
        const {exec} = require("child_process")
        reply(`*${randomEmoji} Restarting Bot...*`);
        await sleep(1500)
        exec("pm2 restart all")
    } catch(e) {
        console.log(e)
        reply(`${e}`)
    }
})
