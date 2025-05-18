import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import express from "express";
import crypto from "crypto";
import { ReclaimProofRequest, verifyProof } from '@reclaimprotocol/js-sdk';

dotenv.config();

const app=express();


const TG_TOKEN=process.env.TELEGRAM_BOT_KEY;
const APP_ID=process.env.APPLICATION_ID;
const APP_SECRET=process.env.APPLICATION_SECRET;
const PROVIDER_ID=process.env.PROVIDER_ID;
const BASE_URL="https://f4d1-2405-201-4020-fc-d09-351d-8216-b82.ngrok-free.app";

app.use(express.json())
app.use(express.text({ type: '*/*', limit: '50mb' }))

if(TG_TOKEN===undefined || APP_ID===undefined || APP_SECRET===undefined || PROVIDER_ID===undefined){
    throw new Error("Unable to get the telegram token")
}

interface publicData{
    username:string;
    created_at:string;
    repoCount:string;
    contributionsLastYear:string;
}

//Creating a verificationToken to prevent unauthorized verification
const verificationTokens = new Map<string, {userId: number, chatId: number, timestamp: number}>();


const telegramBot=new TelegramBot(TG_TOKEN,{
    polling:true
})

telegramBot.getUpdates({
    allowed_updates:["chat_join_request","message"]
})

telegramBot.on('new_chat_members', async (msg) => {
    const chatId = msg.chat.id;
    const newUser = msg.new_chat_members?.[0];
    
    if (!newUser) return;
  
    try {
      await telegramBot.restrictChatMember(chatId, newUser.id, {
        can_send_messages:false,
        can_send_audios:false,
        can_send_documents:false,
        can_send_photos:false
      });

      await telegramBot.sendMessage(msg.chat.id, `Welcome, ${newUser.first_name}! Please verify to participate.`, {
          reply_markup: {
            inline_keyboard: [[
                { text: "✅ Verify",callback_data: `verify_${newUser.id}` }
              ]]
          }
    });

    } catch (err) {
      console.error("Error restricting or sending message:", err);
    }
});


telegramBot.on('callback_query', async (callbackQuery) => {
    try {
      const msg = callbackQuery.message;
      const from = callbackQuery.from;
      const data = callbackQuery.data;
      if (!msg || !data) return;
  
      if (data.startsWith("verify_")) {
        const userId = parseInt(data.split("_")[1]);
        const chatId = msg.chat.id;
         console.log(msg, from, data)
        if (userId !== from.id) {
          telegramBot.answerCallbackQuery(callbackQuery.id, {
            text: "You can't verify for someone else.",
            show_alert: true,
          });
        }

        const token = generateOneTimeToken(userId, chatId);
        const verificationLink = `${BASE_URL}/start-verification?token=${token}`;
        // const reclaimProofRequest = await ReclaimProofRequest.init(APP_ID, APP_SECRET, PROVIDER_ID);
        // reclaimProofRequest.setAppCallbackUrl(`${BASE_URL}/receive-proofs?userId=${userId}&chatId=${chatId}`);
        // const requestURL = await reclaimProofRequest.getRequestUrl();
        await telegramBot.sendMessage(chatId, "Click below to verify:", {
          reply_markup: {
            inline_keyboard: [[{ text: "Click To Begin Verification", login_url:{
                url:verificationLink
            } }]],
          },
        });
      }
    } catch (err) {
      console.log("Error in the callback query:", err);
    }
  });
  
  app.get('/start-verification', async (req, res):Promise<any> => {
    const token = req.query.token as string;
    const result = validateOneTimeToken(token);
    if (!result) return res.status(401).send("Invalid or expired verification link.");

    const { userId, chatId } = result;

    const reclaimProofRequest = await ReclaimProofRequest.init(APP_ID, APP_SECRET, PROVIDER_ID);
    reclaimProofRequest.setAppCallbackUrl(`${BASE_URL}/receive-proofs?token=${token}`);
    const requestURL = await reclaimProofRequest.getRequestUrl();

    // Redirect to Reclaim
    res.redirect(requestURL);
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
        const result = await verifyProof(proof);
        console.log("The proof is ",result)
        const publicData:publicData=proof.publicData;
        const eligibility=checkEligibilityToEnterGroup(publicData);
        console.log("The eligibility is",eligibility)
        if(eligibility){
            await telegramBot.restrictChatMember(chatId, userId, {
                can_send_messages: true,
                can_send_audios: true,
                can_send_documents: true,
                can_send_photos: true,
                can_send_other_messages: true,
                can_add_web_page_previews: true,
            });
        }else{
            
            await telegramBot.sendMessage(chatId, `Error Veriying the user! Please Try again after 5 mins.`, {
                reply_markup: {
                  inline_keyboard: [[
                      { text: "Error"}
                    ]]
                }
          });
        }
    } catch (error) {
        const reclaimProofRequest = await ReclaimProofRequest.init(APP_ID, APP_SECRET, PROVIDER_ID);
        reclaimProofRequest.setAppCallbackUrl(`${BASE_URL}/receive-proofs?userId=${userId}&chatId=${chatId}`);
        const requestURL = await reclaimProofRequest.getRequestUrl();
        console.error("Error verifying proof:", error);
        await telegramBot.sendMessage(chatId, `Error Veriying the user! Please Try again after 5 mins.`, {
            reply_markup: {
              inline_keyboard: [[
                  { text: "Try Again",url:requestURL}
                ]]
            }
      });
    }
})



app.listen(3000, () => {
    console.log(`Server running at http://localhost:${3000}`)
})

const checkEligibilityToEnterGroup=(publicData:publicData)=>{
    try{
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
       const result = Number(publicData.contributionsLastYear) > 300 &&  isOlderThanThreeMonths && Number(publicData.repoCount) > 5;
       return result;
    }catch(err){
        console.log("Error checking eligibility for the user")
        return false;
    }
}

function generateOneTimeToken(userId: number, chatId: number): string {
    const payload = `${userId}:${chatId}:${Date.now()}`;
    const signature = crypto.createHmac('sha256', APP_SECRET!).update(payload).digest('hex');
    return Buffer.from(`${payload}:${signature}`).toString('base64');
}

function validateOneTimeToken(token: string): { userId: number, chatId: number } | null {
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf-8');
        const [userIdStr, chatIdStr, timestampStr, signature] = decoded.split(":");

        const payload = `${userIdStr}:${chatIdStr}:${timestampStr}`;
        const expectedSig = crypto.createHmac('sha256', APP_SECRET!).update(payload).digest('hex');

        if (signature !== expectedSig) return null;

        const timestamp = parseInt(timestampStr);
        if (Date.now() - timestamp > 5 * 60 * 1000) return null; // 5 min expiry

        return {
            userId: parseInt(userIdStr),
            chatId: parseInt(chatIdStr),
        };
    } catch {
        return null;
    }
}
