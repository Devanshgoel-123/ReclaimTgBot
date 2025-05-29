import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import express from "express";
import axios from "axios";
import { ReclaimProofRequest, verifyProof } from '@reclaimprotocol/js-sdk';
import QRCode  from "qrcode";

dotenv.config();

const app=express();
const PORT = process.env.PORT || 3000;
const TG_TOKEN = process.env.TELEGRAM_BOT_KEY;
const APP_ID = process.env.APPLICATION_ID;
const APP_SECRET = process.env.APPLICATION_SECRET;
const PROVIDER_ID = process.env.PROVIDER_ID;
const TG_GROUP_URL = process.env.TG_GROUP_URL || "https://t.me/+NopYIC9o-IMxOWRl";
const BASE_URL = process.env.BASE_URL || "http://localhost:3000"; 

if (!TG_TOKEN || !APP_ID || !APP_SECRET || !PROVIDER_ID) {
    console.error("Missing required environment variables");
    process.exit(1);
}

app.use(express.json())
app.use(express.text({ type: '*/*', limit: '50mb' }))


if(TG_TOKEN===undefined || APP_ID===undefined || APP_SECRET===undefined || PROVIDER_ID===undefined){
    throw new Error("Unable to get the telegram token")
}

interface publicData{
    username:string;
    created_at?:string;
    repoCount?:string;
    contributionsLastYear?:number;
}


const msgIdMap = new Map<number,{msgId:number, groupChatId:number}>();

const verificationSession = new Map<number, { chatId: number }>();

const telegramBot=new TelegramBot(TG_TOKEN,{
    polling:true
})

telegramBot.getUpdates({
    allowed_updates:["new_chat_members","message"]
})

telegramBot.on('new_chat_members', async (msg) => {
    const chatId = msg.chat.id;
    const newUser = msg.new_chat_members?.[0];
     console.log("The chat id is",chatId);
    if (!newUser) return;
  
    try {
      await telegramBot.restrictChatMember(chatId, newUser.id, {
        can_send_messages:false,
        can_send_audios:false,
        can_send_documents:false,
        can_send_photos:false,
        can_send_other_messages:false
      });

      const msgId=await telegramBot.sendMessage(chatId, `Hi ${newUser.first_name}, please click below to verify and join the group:`, {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Verify Me', url: `https://t.me/ReclaimBoiBot?start=verifyme_${chatId}`}
          ]]
        }
      });
      msgIdMap.set(newUser.id, {msgId:msgId.message_id, groupChatId:chatId});
    
    } catch (err) {
      console.error("Error restricting or sending message:", err);
    }
});

// 2nd part of the flow, when user is DMed via bot to select the device they are on, currently

telegramBot.onText(/\/start (.+)/, async (msg, match) => {
    const personalChatId = msg.chat.id;
    const userId = msg.from?.id; 
    
    if(!userId || !personalChatId) return;

    verificationSession.set(userId, { chatId: personalChatId });
    telegramBot.sendMessage(personalChatId, 'Are you using Telegram on a mobile device or desktop?', {
      reply_markup: {
        inline_keyboard: [
            [
            { text: "📱 Mobile", callback_data:"device_mobile" }
            ],
            [
            { text: "🖥️ Desktop", callback_data:"device_desktop" }
            ]],
        one_time_keyboard: true,
        resize_keyboard: true,
      },
    });
})



telegramBot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;
    const userId = callbackQuery.from.id;
    const message = callbackQuery.message;
    const groupChatId=msgIdMap.get(userId)?.groupChatId;
    const personalChatId=verificationSession.get(userId)?.chatId;
    if(msgIdMap.get(userId)?.msgId  && groupChatId ){
        await telegramBot.deleteMessage(groupChatId, msgIdMap.get(userId)?.msgId as number);
    }else{
        console.log("Didn't find the message to be deleted!!")
    }
    console.log("THe group chat id is",groupChatId)
    console.log("The personal chat id is",personalChatId)
    if (!data || !data.startsWith("device_")) return;
    if(!userId || !personalChatId || !groupChatId) return; 
    
    console.log("The required chat💬 id is",personalChatId, groupChatId)
    if (isNaN(groupChatId)) {
    return telegramBot.sendMessage(userId, "Could not extract group information from the link.");
    }
    const reclaimProofRequest = await ReclaimProofRequest.init(APP_ID, APP_SECRET, PROVIDER_ID);
    reclaimProofRequest.setRedirectUrl(TG_GROUP_URL);
    reclaimProofRequest.setAppCallbackUrl(`${BASE_URL}/receive-proofs?userId=${userId}&chatId=${groupChatId}`);
    const requestURL = await reclaimProofRequest.getRequestUrl();

    try {
        if(data?.toLowerCase().includes("mobile")){
            await telegramBot.sendMessage(userId, "Click below to verify:", {
                    reply_markup: {
                      inline_keyboard: [[{ text: "Click To Begin Verification", url:requestURL }]],
                    },
            });
            const message=msgIdMap.get(userId);
            if(!message) return;          
    }else{
            const qrBuffer=await QRCode.toBuffer(requestURL)
            console.log(qrBuffer)
            telegramBot.sendPhoto(userId, qrBuffer, {
                    caption: `Scan this QR code from your mobile Device to Verify:\n`,
            });
    }
    console.log("NExt step is deleting messages",msgIdMap, groupChatId, userId)
    
    } catch (err) {
        console.log("THe error is",err);
    }
});




app.post('/receive-proofs', async (req,res):Promise<any>=>{
    const chatId = Number(req.query.chatId);
    const userId = Number(req.query.userId);
    console.log()
    try {
        if (!chatId || !userId) {
            return res.status(400).send("Missing chatId or userId");
        }
        console.log("i am receiving something",chatId,userId)
        const decodedBody = decodeURIComponent(req.body);
        const proof = JSON.parse(decodedBody);
        console.log("The proof is",proof);
        const params=(JSON.parse(proof.claimData.context)).extractedParameters;
        const {URL_PARAMS_1, contributions}=params;
        console.log("THe values are",URL_PARAMS_1, contributions)
        const isValidProof = await verifyProof(proof);
        const response=await axios.get(`https://api.github.com/users/${URL_PARAMS_1}`);
        console.log(response.data)
        const data=response.data;
        const publicData:publicData={
            created_at:data.created_at,
            username:URL_PARAMS_1,
            repoCount:data.public_repos,
            contributionsLastYear:parseInt(contributions.trim(),10)
        }

        console.log("The public data is",publicData)
        const isEligible=checkEligibilityToEnterGroup(publicData);

        if(isEligible && isValidProof){
            await telegramBot.restrictChatMember(chatId, userId, {
                can_send_messages: true,
                can_send_audios: true,
                can_send_documents: true,
                can_send_photos: true,
            });
            await telegramBot.sendMessage(userId, 
                `✅ Verification complete! You've been granted access to the group.`
            );
            await telegramBot.sendMessage(chatId, 
                `Welcome to the group ${data.name}.`
            );
        return res.redirect(TG_GROUP_URL);
        }else{
            console.log(`User ${userId} verification failed`);
            let reason = "";
            if (!isValidProof) reason = "Invalid proof.";
            else reason = "GitHub account does not meet the minimum requirements (3+ months old, 5+ repos, 300+ contributions in last year).";
            
            await telegramBot.sendMessage(userId, 
                `❌ Verification failed: ${reason}\n\nPlease try again after ensuring your GitHub account meets the requirements.`
            )
        }
    } catch (error) {
        await telegramBot.restrictChatMember(chatId, userId, {
            can_send_messages: true,
            can_send_audios: true,
            can_send_documents: true,
            can_send_photos: true,
        });
        const reclaimProofRequest = await ReclaimProofRequest.init(APP_ID, APP_SECRET, PROVIDER_ID);
        reclaimProofRequest.setAppCallbackUrl(`${BASE_URL}/receive-proofs?userId=${userId}&chatId=${chatId}`);
        const requestURL = await reclaimProofRequest.getRequestUrl();
        console.error("Error verifying proof:", error);
        await telegramBot.sendMessage(userId, `Error Veriying the user! Please Try again after 5 mins.`, {
            reply_markup: {
              inline_keyboard: [[
                  { text: "Try Again",url:requestURL}
                ]]
            }
      });
    }
})


const checkEligibilityToEnterGroup=(publicData:publicData)=>{
    try{
        if(!publicData.created_at) return;
        const createdAtUTC = new Date(publicData.created_at);
        const nowUTC = new Date();
        const threeMonthsAgoUTC = new Date(Date.UTC(
            nowUTC.getUTCFullYear(),
            nowUTC.getUTCMonth() - 3,
            nowUTC.getUTCDate(),
            nowUTC.getUTCHours(),
            nowUTC.getUTCMinutes(),
            nowUTC.getUTCSeconds()
        ));
        
        const isOlderThanThreeMonths = createdAtUTC < threeMonthsAgoUTC;
        const contributionsLastYear = Number(publicData.contributionsLastYear) || 0;
        const repoCount = Number(publicData.repoCount) || 0;
        return contributionsLastYear > 300 && isOlderThanThreeMonths && repoCount > 5;
    }catch(err){
        console.log("Error checking eligibility for the user")
        return false;
    }
}



app.get('/health', (_, res) => {
    res.status(200).send('OK');
});


app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Base URL: ${BASE_URL}`);
    console.log(`Telegram group: ${TG_GROUP_URL}`);
});