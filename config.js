const fs = require("fs");
if (fs.existsSync("config.env"))
  require("dotenv").config({ path: "./config.env" });

function convertToBool(text, fault = "true") {
  return text === fault ? true : false;
}
module.exports = {
  SESSION_ID: process.env.SESSION_ID || "GdcFQagQ#cuuMeu9C_DbreGPIXTAp5cO_j6GrvLmBWgV6s3oBvkA",
  OWNER_NUM: process.env.OWNER_NUM || "94726939427",
  OWNER_JID: process.env.OWNER_JID || "75227023323273@lid",
  PREFIX: process.env.PREFIX || ".",
  ALIVE_IMG: process.env.ALIVE_IMG || "https://raw.githubusercontent.com/Manmitha96/BOT-PHOTOS/refs/heads/main/2025051419391432.jpg",
  MAINMENU_IMG: process.env.MAINMENU_IMG || "https://raw.githubusercontent.com/Manmitha96/BOT-PHOTOS/refs/heads/main/BotMenuPhoto/MainBotmenu.jpg",
  ALIVE_MSG: process.env.ALIVE_MSG || "Hello , I am alive now!!\n\n*☯️OWNED BY P_I_K_O☯️*",
  MODE: process.env.MODE || "public",
  AUTO_VOICE: process.env.AUTO_VOICE || "true",
  AUTO_STICKER: process.env.AUTO_STICKER || "true",
  AUTO_REPLY: process.env.AUTO_REPLY || "true",
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "AIzaSyC-fguZ_yf3jQeg-_IP2m5zX9_cnrSAUPY",
  MOVIE_API_KEY: process.env.MOVIE_API_KEY || "sky|a34060751cedcbf1cbe09d78e984eefb8c6acd92",
  
};
