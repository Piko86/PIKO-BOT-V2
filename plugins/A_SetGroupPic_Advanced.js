const { cmd } = require('../command');
const { downloadMediaMessage } = require('../lib/msg');
const fs = require('fs');
const path = require('path');



// Command to get current group picture
cmd({
    pattern: "getgpp",
    alias: ["groupdp", "gdp"],
    react: "📷",
    desc: "Get current group profile picture",
    category: "group",
    filename: __filename
},
async (robin, mek, m, { from, isGroup, reply, groupName }) => {
    try {
        if (!isGroup) {
            return reply("⚠️ *This command only works in groups!*");
        }

        await reply("📷 *Fetching group profile picture...*");

        try {
            const ppUrl = await robin.profilePictureUrl(from, 'image');
            
            if (ppUrl) {
                await robin.sendMessage(from, {
                    image: { url: ppUrl },
                    caption: `📷 *Current Group Profile Picture*\n\n🏷️ *Group:* ${groupName || 'Unknown'}\n📅 *Retrieved:* ${new Date().toLocaleString()}\n\n*Downloaded by PIKO Bot* 💜`
                }, { quoted: mek });
            } else {
                return reply("❌ *This group doesn't have a profile picture set.*");
            }
        } catch (error) {
            if (error.output?.statusCode === 404) {
                return reply("❌ *This group doesn't have a profile picture set.*");
            } else {
                throw error;
            }
        }

    } catch (error) {
        console.error("Get Group PP Error:", error);
        return reply(`❌ *Failed to get group profile picture*\n\n*Error:* ${error.message}`);
    }
});

// Command to remove group picture (admin only)
cmd({
    pattern: "removegpp",
    alias: ["deletegpp", "cleargpp"],
    react: "🗑️",
    desc: "Remove group profile picture",
    category: "group",
    filename: __filename
},
async (robin, mek, m, { from, isGroup, isAdmins, isBotAdmins, reply, pushname }) => {
    try {
        if (!isGroup) return reply("⚠️ *Group command only!*");
        if (!isAdmins) return reply("⚠️ *Admins only!*");
        if (!isBotAdmins) return reply("⚠️ *Bot needs admin rights!*");

        await reply("🗑️ *Removing group profile picture...*");

        try {
            // Remove profile picture by setting it to null/empty
            await robin.removeProfilePicture(from);
            
            return reply(`✅ *Group profile picture removed successfully!*\n\n👤 *Removed by:* ${pushname}\n⏰ *Time:* ${new Date().toLocaleString()}`);
            
        } catch (error) {
            if (error.message.includes('not-authorized')) {
                return reply("❌ *Permission denied!* Bot needs proper admin rights.");
            } else {
                throw error;
            }
        }

    } catch (error) {
        console.error("Remove GPP Error:", error);
        return reply(`❌ *Failed to remove group picture*\n\n*Error:* ${error.message}`);
    }
});
