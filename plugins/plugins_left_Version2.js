const { cmd } = require('../command');

cmd({
    pattern: "left",
    alias: ["leave", "exit"],
    react: "👋",
    desc: "Bot leaves the group (if owner uses the command) or removes the user (if not owner).",
    category: "main",
    filename: __filename
},
async (robin, mek, m, { from, sender, isOwner, isGroup, isBotAdmins, reply }) => {
    try {
        // Only works in groups
        if (!isGroup) return reply("⚠️ This command can only be used in a group!");

        // Bot must be admin to remove users
        
        
        if (isOwner) {
            // Owner: Bot leaves group
            await robin.groupLeave(from);

        } else{
            // Not owner: Remove the user who sent the command
        if (!isBotAdmins) return reply("⚠️ Bot Need Admin To Do it!");
            
            await robin.groupParticipantsUpdate(from, [sender], "remove");
        }
    } catch (e) {
        console.error("Left Error:", e);
        reply(`❌ Failed to process the left command. Error: ${e.message}`);
    }
});
