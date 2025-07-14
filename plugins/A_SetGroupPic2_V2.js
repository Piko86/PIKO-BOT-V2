const { cmd } = require('../command');
const { downloadMediaMessage } = require('../lib/msg');

cmd({
    pattern: "setgrouppic",
    alias: ["setgpp", "setgroupphoto"],
    react: "🖼️",
    desc: "Set group profile picture - Reply to an image",
    category: "group",
    filename: __filename
},
async (robin, mek, m, { from, isGroup, isAdmins, isBotAdmins, reply, quoted, pushname }) => {
    try {
        // Basic validation
        if (!isGroup) {
            return reply("⚠️ *This command only works in groups!*");
        }
        
        if (!isAdmins) {
            return reply("⚠️ *Only group admins can change the group picture!*");
        }
        
        if (!isBotAdmins) {
            return reply("⚠️ *Bot needs admin privileges to change group picture!*");
        }

        // Debug: Log the message structure
        console.log("🔍 DEBUG - Message structure:");
        console.log("mek.message:", JSON.stringify(mek.message, null, 2));
        console.log("quoted:", quoted ? "EXISTS" : "NULL");
        console.log("m.quoted:", m.quoted ? "EXISTS" : "NULL");

        // Multiple ways to detect quoted message
        let quotedMessage = quoted || m.quoted || mek.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        
        // Check if this is a reply to a message
        const isReply = mek.message?.extendedTextMessage?.contextInfo?.quotedMessage ||
                       mek.message?.extendedTextMessage?.contextInfo?.stanzaId ||
                       quoted || m.quoted;

        if (!isReply) {
            return reply(`📸 *Please reply to an image to set as group profile picture!*

*How to use:*
1️⃣ Send or forward an image to the group
2️⃣ Swipe right on the image (or long press and select reply)
3️⃣ Type: \`.setgrouppic\`
4️⃣ Send the message

*Supported formats:* JPG, JPEG, PNG, WEBP
*Maximum size:* 10MB`);
        }

        // Enhanced image detection - check multiple possible locations
        let imageMessage = null;
        
        // Method 1: Direct quoted image
        if (quotedMessage?.imageMessage) {
            imageMessage = quotedMessage.imageMessage;
            console.log("✅ Found image via Method 1: Direct quoted image");
        }
        // Method 2: View once image
        else if (quotedMessage?.viewOnceMessage?.message?.imageMessage) {
            imageMessage = quotedMessage.viewOnceMessage.message.imageMessage;
            console.log("✅ Found image via Method 2: View once image");
        }
        // Method 3: Check context info
        else if (mek.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage) {
            imageMessage = mek.message.extendedTextMessage.contextInfo.quotedMessage.imageMessage;
            console.log("✅ Found image via Method 3: Context info");
        }
        // Method 4: Check if quoted message type indicates image
        else if (quoted && (quoted.mtype === 'imageMessage' || quoted.type === 'imageMessage')) {
            imageMessage = quoted.message || quoted.msg;
            console.log("✅ Found image via Method 4: Message type check");
        }

        if (!imageMessage) {
            return reply(`❌ *No image found in the replied message!*

*Make sure you:*
✅ Reply to an image (not text)
✅ Use a supported format (JPG, PNG, WEBP)
✅ Image is not corrupted

*Try again by replying to an image message.*`);
        }

        // Show processing message
        await reply("🔄 *Processing image...*\n⏳ *Updating group profile picture...*");

        try {
            // Create a temporary quoted object for download
            const tempQuoted = {
                message: { imageMessage: imageMessage },
                mtype: 'imageMessage',
                type: 'imageMessage'
            };

            // Download the image
            let mediaBuffer;
            
            try {
                // Try using the downloadMediaMessage function
                mediaBuffer = await downloadMediaMessage(tempQuoted, 'group-pic');
            } catch (downloadError) {
                console.log("Primary download failed, trying alternative method...");
                
                // Alternative download method
                try {
                    if (quoted && quoted.download) {
                        mediaBuffer = await quoted.download();
                    } else {
                        // Manual download using WhatsApp's download function
                        const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
                        const stream = await downloadContentFromMessage(imageMessage, 'image');
                        const chunks = [];
                        for await (const chunk of stream) {
                            chunks.push(chunk);
                        }
                        mediaBuffer = Buffer.concat(chunks);
                    }
                } catch (altError) {
                    throw new Error(`Download failed: ${altError.message}`);
                }
            }

            // Validate buffer
            if (!mediaBuffer || mediaBuffer.length === 0) {
                throw new Error("Downloaded image is empty or corrupted");
            }

            // Check file size (10MB limit)
            const fileSizeMB = mediaBuffer.length / (1024 * 1024);
            if (fileSizeMB > 10) {
                return reply(`📏 *Image too large!*\n\n*Current size:* ${fileSizeMB.toFixed(2)}MB\n*Maximum allowed:* 10MB\n\n*Please use a smaller image.*`);
            }

            console.log(`📸 Setting group picture - Size: ${fileSizeMB.toFixed(2)}MB`);

            // Update group profile picture
            await robin.updateProfilePicture(from, mediaBuffer);

            // Success message
            const successMsg = `✅ *Group profile picture updated successfully!*

👤 *Updated by:* ${pushname}
📏 *Image size:* ${fileSizeMB.toFixed(2)}MB
⏰ *Updated at:* ${new Date().toLocaleTimeString()}

*Thank you for using PIKO Bot!* 💜`;

            await reply(successMsg);

            console.log(`✅ Group picture updated successfully by ${pushname}`);

        } catch (updateError) {
            console.error("Update Error:", updateError);
            
            // Specific error handling
            if (updateError.message.includes('not-authorized') || updateError.message.includes('forbidden')) {
                return reply("❌ *Permission denied!*\n\n*Possible solutions:*\n• Make sure bot has admin rights\n• Check group settings\n• Try again in a few seconds");
            } else if (updateError.message.includes('too-large')) {
                return reply("❌ *Image is too large!*\n\n*Please use an image smaller than 10MB.*");
            } else {
                return reply(`❌ *Failed to update group picture*\n\n*Error:* ${updateError.message}\n\n*Try:*\n• Using a different image\n• Checking image format (JPG/PNG/WEBP)\n• Ensuring image isn't corrupted`);
            }
        }

    } catch (error) {
        console.error("Set Group Picture Error:", error);
        return reply(`❌ *Unexpected error occurred*\n\n*Error:* ${error.message}\n\n*Please try again or contact support.*`);
    }
});

// Simple alternative command for testing
cmd({
    pattern: "testgpp",
    react: "🧪",
    desc: "Test group picture setting with debug info",
    category: "group",
    filename: __filename
},
async (robin, mek, m, { from, isGroup, isAdmins, isBotAdmins, reply, quoted }) => {
    try {
        if (!isGroup) return reply("⚠️ Group only!");
        if (!isAdmins) return reply("⚠️ Admins only!");
        if (!isBotAdmins) return reply("⚠️ Bot needs admin!");

        // Debug information
        const debugInfo = `🧪 *DEBUG INFO*

*Message Type:* ${mek.message ? Object.keys(mek.message)[0] : 'None'}
*Has Quoted:* ${quoted ? '✅ Yes' : '❌ No'}
*Has m.quoted:* ${m.quoted ? '✅ Yes' : '❌ No'}
*Has Context:* ${mek.message?.extendedTextMessage?.contextInfo ? '✅ Yes' : '❌ No'}
*Is Reply:* ${mek.message?.extendedTextMessage?.contextInfo?.stanzaId ? '✅ Yes' : '❌ No'}

*Quoted Message Type:* ${quoted?.mtype || 'None'}
*Quoted Has Image:* ${quoted?.message?.imageMessage ? '✅ Yes' : '❌ No'}`;

        await reply(debugInfo);

        // If there's an image, try to set it
        if (quoted?.message?.imageMessage) {
            await reply("🔄 *Found image! Attempting to set...*");
            
            const mediaBuffer = await downloadMediaMessage(quoted, 'test-gpp');
            await robin.updateProfilePicture(from, mediaBuffer);
            
            return reply("✅ *Test successful! Group picture updated.*");
        } else {
            return reply("❌ *No image found in reply. Please reply to an image.*");
        }

    } catch (error) {
        console.error("Test GPP Error:", error);
        return reply(`❌ *Test failed:* ${error.message}`);
    }
});

// Quick command that works with any image reply
cmd({
    pattern: "quickgpp",
    react: "⚡",
    desc: "Quick group picture update",
    category: "group", 
    filename: __filename
},
async (robin, mek, m, { from, isGroup, isAdmins, isBotAdmins, reply }) => {
    try {
        if (!isGroup || !isAdmins || !isBotAdmins) {
            return reply("⚠️ *Group admins only + Bot needs admin rights*");
        }

        // Check for any image in the message context
        const contextInfo = mek.message?.extendedTextMessage?.contextInfo;
        const quotedMsg = contextInfo?.quotedMessage;
        
        if (!quotedMsg || !quotedMsg.imageMessage) {
            return reply("❌ *Reply to an image to use quick update*");
        }

        await reply("⚡ *Quick update in progress...*");

        // Direct download and update
        const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
        const stream = await downloadContentFromMessage(quotedMsg.imageMessage, 'image');
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);

        await robin.updateProfilePicture(from, buffer);
        return reply("✅ *Quick update complete!*");

    } catch (error) {
        console.error("Quick GPP Error:", error);
        return reply(`❌ *Quick update failed:* ${error.message}`);
    }
});
