// index.js
// AI Receptionist for Restaurants (English only)

import express from "express";
import twilio from "twilio";
import { config } from "dotenv";
import OpenAI from "openai";
import leven from "leven";
import { initDB, saveOrder } from "./database.js";
import { MENU_ITEMS, HINTS } from "./menu.js";

config();
initDB();

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Use env for BASE_ACTION_URL, fall back to relative /process-order
const BASE_ACTION_URL =
  process.env.BASE_ACTION_URL || "/process-order";

const MENU_DESCRIPTION = MENU_ITEMS.join(", ");

// Map<CallSid, { items, awaitingFinalConfirm, waitingForStillThere, pendingGuess, suggestedSwap, pendingRemove, pendingOrderConfirm, noise, expectingAddMoreYesNo, expectingQuantityFor, confirmingFinalOrder }>
const callOrders = new Map();

// Synonyms: goat/lamb biryani → mutton biryani
const DISH_SYNONYMS = {
  "goat biryani": "mutton biryani",
  "lamb biryani": "mutton biryani",
  "regular biryani": "chicken biryani"
};

function formatItemWithQty(name, qty) {
  if (qty === 1) return `1 ${name}`;
  return `${qty} ${name}${name.endsWith("s") ? "" : "s"}`;
}

function summarizeOrder(orderMap) {
  const entries = Object.entries(orderMap);
  if (!entries.length) return "nothing yet";
  return entries
    .map(([name, qty]) => formatItemWithQty(name, qty))
    .join(", ");
}

function getLastBiryaniInOrder(orderMap) {
  const biryaniItems = Object.keys(orderMap).filter((name) =>
    name.toLowerCase().includes("biryani")
  );
  if (!biryaniItems.length) return null;
  return biryaniItems[biryaniItems.length - 1];
}

// Fuzzy match with synonym awareness
function findClosestMenuItem(userText) {
  let t = userText.toLowerCase().trim();
  if (!t) return null;

  for (const [synonym, canonical] of Object.entries(DISH_SYNONYMS)) {
    if (t.includes(synonym)) {
      return { item: canonical, confidence: "low", reason: "synonym" };
    }
  }

  let bestItem = null;
  let bestScore = 0;

  for (const item of MENU_ITEMS) {
    const itemLower = item.toLowerCase();
    const L = Math.max(t.length, itemLower.length);
    const distance = leven(t, itemLower);
    const similarity = (L - distance) / L;

    if (similarity > bestScore) {
      bestScore = similarity;
      bestItem = item;
    }
  }

  if (bestScore >= 0.85) {
    return { item: bestItem, confidence: "high" };
  } else if (bestScore >= 0.65) {
    return { item: bestItem, confidence: "low" };
  }
  return null;
}

function findItemMentionedInSpeech(rawSpeech) {
  const lower = rawSpeech.toLowerCase();
  let bestItem = null;
  let bestScore = 0;

  for (const item of MENU_ITEMS) {
    const itemLower = item.toLowerCase();
    if (lower.includes(itemLower)) {
      return item;
    }
    const L = Math.max(lower.length, itemLower.length);
    const distance = leven(lower, itemLower);
    const similarity = (L - distance) / L;
    if (similarity > bestScore) {
      bestScore = similarity;
      bestItem = item;
    }
  }

  if (bestScore >= 0.7) return bestItem;
  return null;
}

// Voice settings (Polly voice + prosody).[web:49]
const VOICE_NAME = "Polly.Salli";

const generateTwiml = (
  message = "Hi, thanks for calling Biryani Maxx. What would you like to order today?",
  rate = "105%"
) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input: "speech",
    action: BASE_ACTION_URL,
    method: "POST",
    speechTimeout: "auto",
    hints: HINTS,
    bargeIn: true,
    language: "en-US"
  });

  gather.say(
    `<speak><prosody rate="${rate}" pitch="+2%" volume="-1dB">${message}</prosody></speak>`,
    {
      voice: VOICE_NAME
    }
  );

  return twiml.toString();
};

app.post("/twiml", (req, res) => {
  res.type("text/xml").send(generateTwiml());
});

app.get("/twiml", (req, res) => {
  res.type("text/xml").send(generateTwiml());
});

function isRepeatOrderIntent(text) {
  const t = text.toLowerCase();
  return (
    t.includes("repeat my order") ||
    t.includes("tell me my order") ||
    t.includes("repeat the order") ||
    t.includes("update my order and tell me") ||
    t.includes("repeat order now")
  );
}

function normalizeSpeechToMenu(speechRaw) {
  const lower = speechRaw.toLowerCase();

  const isNegation =
    lower.includes("never") ||
    lower.includes("don't") ||
    lower.includes("dont") ||
    lower.includes("did not") ||
    lower.includes("didn't") ||
    lower.includes("no, i never");

  let fixed = lower
    .replace("pallet paneer", "palak paneer")
    .replace("panel butter masala", "paneer butter masala")
    .replace("paneer tiki", "paneer tikka")
    .replace("china masala", "chana masala")
    .replace("sink biryani", "chicken biryani");

  for (const item of MENU_ITEMS) {
    const words = item.toLowerCase().split(" ");
    if (words.every((w) => fixed.includes(w))) {
      if (isNegation) {
        return `I was talking about ${item}, not ordering it.`;
      }
      return `I would like to order ${item}.`;
    }
  }

  if (fixed.includes("second 65") || fixed.includes("1065")) {
    if (isNegation) {
      return "I was talking about chicken 65, not ordering it.";
    }
    return "I would like to order chicken 65.";
  }

  return speechRaw;
}

function extractQuantity(speechLower) {
  const numberWords = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5
  };
  const digitMatch = speechLower.match(/\b(\d+)\b/);
  if (digitMatch) {
    const n = parseInt(digitMatch[1], 10);
    if (!Number.isNaN(n) && n > 0 && n < 20) return n;
  }
  for (const [w, v] of Object.entries(numberWords)) {
    if (speechLower.includes(` ${w} `)) return v;
  }
  return null;
}

function addItemsToOrder(orderMap, normalizedSpeech) {
  const lowerNorm = normalizedSpeech.toLowerCase();
  if (!lowerNorm.startsWith("i would like to order")) return false;

  const qty = extractQuantity(lowerNorm) || 1;
  let added = false;

  for (const item of MENU_ITEMS) {
    if (lowerNorm.includes(item.toLowerCase())) {
      const currentQty = orderMap[item] || 0;
      orderMap[item] = currentQty + qty;
      added = true;
    }
  }
  return added;
}

function applyNluItemsToOrder(orderItems, nluItems) {
  for (const it of nluItems) {
    if (!it || !it.dish) continue;
    const match = findClosestMenuItem(it.dish);
    if (!match) continue;
    const dishName = match.item;
    const qty =
      it.quantity && Number.isInteger(it.quantity) && it.quantity > 0
        ? it.quantity
        : 1;

    if (it.action === "add") {
      orderItems[dishName] = (orderItems[dishName] || 0) + qty;
    } else if (it.action === "set") {
      orderItems[dishName] = qty;
    } else if (it.action === "remove") {
      if (orderItems[dishName]) delete orderItems[dishName];
    }
  }
}

async function processOrder(req, res) {
  const callSid = req.body.CallSid;
  const speechRaw = req.body.SpeechResult || "";
  const speechText = speechRaw.trim().toLowerCase();

  if (!callOrders.has(callSid)) {
    callOrders.set(callSid, {
      items: {},
      awaitingFinalConfirm: false,
      waitingForStillThere: false,
      pendingGuess: null,
      suggestedSwap: null,
      pendingRemove: null,
      pendingOrderConfirm: null,
      noise: { missesInRow: 0 },
      expectingAddMoreYesNo: false,
      expectingQuantityFor: null,
      confirmingFinalOrder: false
    });
  }

  const orderState = callOrders.get(callSid);

  const twiml = new twilio.twiml.VoiceResponse();
  const orderItems = orderState.items;
  const orderIsEmpty = Object.keys(orderItems).length === 0;

  if (!speechRaw) {
    orderState.noise.missesInRow += 1;
  } else {
    orderState.noise.missesInRow = 0;
  }
  const rate = orderState.noise.missesInRow >= 2 ? "100%" : "105%";

  const sayWithVoice = (vrOrGather, msg, opts = {}) => {
    const effRate = opts.rate || rate;
    vrOrGather.say(
      `<speak><prosody rate="${effRate}" pitch="+2%" volume="-1dB">${msg}</prosody></speak>`,
      { voice: VOICE_NAME }
    );
  };

  // ----- -1) Explicit remove/delete -----
  if (
    !orderIsEmpty &&
    (speechText.startsWith("remove ") ||
      speechText.startsWith("delete "))
  ) {
    const removePhrase = speechText
      .replace(/^remove\s+/, "")
      .replace(/^delete\s+/, "")
      .trim();
    const match = findClosestMenuItem(removePhrase);
    const targetItem = match?.item || findItemMentionedInSpeech(removePhrase);

    if (targetItem && orderItems[targetItem]) {
      orderState.pendingRemove = { item: targetItem };
      const g = twiml.gather({
        input: "speech",
        action: BASE_ACTION_URL,
        method: "POST",
        speechTimeout: "auto",
        hints: "yes,no",
        bargeIn: true,
        language: "en-US"
      });
      const msg =
        `You have ${targetItem} on your order. Should I remove it, yes or no?`;
      sayWithVoice(g, msg);
      return res.type("text/xml").send(twiml.toString());
    }
  }

  // ----- 0) NLU -----
  let nlu = {
    intent: "unknown",
    items: [],
    channel: "phone"
  }; 

  if (process.env.OPENAI_API_KEY && speechRaw) {
    try {
      const nluResp = await openai.chat.completions.create({
        model: "gpt-4.1",
        messages: [
          {
            role: "system",
            content:
              "You are an NLU parser for an English-only restaurant voice bot. " +
              "Recognize phone-quality ASR transcripts with accents, slang, and minor errors. " +
              "Return JSON with: intent, items, and optional booking / complaint details. " +
              "intent ∈ {order, modify, repeat_order, done, booking, complaint, smalltalk, unknown}. " +
              "items: [{ dish, quantity, action }]. " +
              "booking: { date: string|null, time: string|null, party_size: number|null }. " +
              "complaint: { topic: string|null }. " +
              "Keep output minimal for low latency. Return ONLY valid JSON."
          },
          { role: "user", content: speechRaw }
        ],
        max_tokens: 160,
        response_format: { type: "json_object" }
      });

      const content = nluResp.choices[0].message.content || "{}";
      nlu = JSON.parse(content);
      if (!Array.isArray(nlu.items)) nlu.items = [];
    } catch (e) {
      console.error("NLU parse failed, falling back to rules:", e);
      nlu = { intent: "unknown", items: [], channel: "phone" };
    }
  }

  // ----- 0a) empty order, modify/remove -----
  if (
    orderIsEmpty &&
    (nlu.intent === "modify" ||
      (nlu.items && nlu.items.some((it) => it.action === "remove")))
  ) {
    const twEmpty = new twilio.twiml.VoiceResponse();
    const g = twEmpty.gather({
      input: "speech",
      action: BASE_ACTION_URL,
      method: "POST",
      speechTimeout: "auto",
      hints: HINTS,
      bargeIn: true,
      language: "en-US"
    });
    const msg =
      "I don’t see anything on your order yet. What would you like to order?";
    sayWithVoice(g, msg);
    return res.type("text/xml").send(twEmpty.toString());
  }

  // ----- 1) pending remove -----
  if (orderState.pendingRemove) {
    const target = orderState.pendingRemove.item;
    const yes =
      speechText.includes("yes") ||
      speechText.includes("yeah") ||
      speechText.includes("sure");
    const no =
      speechText.includes("no") ||
      speechText.includes("nah") ||
      speechText.includes("nope");

    if (yes && orderItems[target]) {
      delete orderItems[target];
      orderState.pendingRemove = null;

      const g = twiml.gather({
        input: "speech",
        action: BASE_ACTION_URL,
        method: "POST",
        speechTimeout: "auto",
        hints: HINTS,
        bargeIn: true,
        language: "en-US"
      });
      const msg =
        `Okay, I’ve removed ${target}. Anything else you’d like?`;
      sayWithVoice(g, msg);
      return res.type("text/xml").send(twiml.toString());
    }

    if (no) {
      orderState.pendingRemove = null;
      const g = twiml.gather({
        input: "speech",
        action: BASE_ACTION_URL,
        method: "POST",
        speechTimeout: "auto",
        hints: HINTS,
        bargeIn: true,
        language: "en-US"
      });
      const msg =
        "No problem, I’ll keep it. Anything else?";
      sayWithVoice(g, msg);
      return res.type("text/xml").send(twiml.toString());
    }

    const g = twiml.gather({
      input: "speech",
      action: BASE_ACTION_URL,
      method: "POST",
      speechTimeout: "auto",
      hints: "yes,no",
      bargeIn: true,
      language: "en-US"
    });
    const msg =
      `Should I remove ${target}, yes or no?`;
    sayWithVoice(g, msg);
    return res.type("text/xml").send(twiml.toString());
  }

  // ----- 1b) pending order confirmation -----
  if (orderState.pendingOrderConfirm) {
    const yes =
      speechText.includes("yes") ||
      speechText.includes("yeah") ||
      speechText.includes("correct") ||
      speechText.includes("that's right");

    const noDone =
      speechText.includes("no, that's it") ||
      speechText.includes("no thats it") ||
      speechText.includes("no, that is it") ||
      speechText.includes("no, that's all") ||
      speechText.includes("no thats all") ||
      speechText.includes("no, that is all");

    const no =
      speechText.includes("no") ||
      speechText.includes("nah") ||
      speechText.includes("nope");

    if (yes) {
      Object.keys(orderItems).forEach((k) => delete orderItems[k]);
      Object.entries(orderState.pendingOrderConfirm.items).forEach(
        ([name, qty]) => {
          orderItems[name] = qty;
        }
      );
      orderState.pendingOrderConfirm = null;

      const g = twiml.gather({
        input: "speech",
        action: BASE_ACTION_URL,
        method: "POST",
        speechTimeout: "auto",
        hints: HINTS,
        bargeIn: true,
        language: "en-US"
      });
      const msg =
        "Got it. Anything else you’d like to add?";
      sayWithVoice(g, msg);

      orderState.expectingAddMoreYesNo = true;

      return res.type("text/xml").send(twiml.toString());
    }

    if (noDone) {
      orderState.pendingOrderConfirm = null;

      const summaryText =
        Object.keys(orderItems).length > 0
          ? summarizeOrder(orderItems)
          : "nothing yet";

      const g = twiml.gather({
        input: "speech",
        action: BASE_ACTION_URL,
        method: "POST",
        speechTimeout: "auto",
        hints: "yes,no",
        bargeIn: true,
        language: "en-US"
      });
      const msg =
        `Your order is: ${summaryText}. Is that correct, yes or no?`;
      sayWithVoice(g, msg);
      orderState.confirmingFinalOrder = true;
      return res.type("text/xml").send(twiml.toString());
    }

    if (no && !noDone) {
      orderState.pendingOrderConfirm = null;
      const g = twiml.gather({
        input: "speech",
        action: BASE_ACTION_URL,
        method: "POST",
        speechTimeout: "auto",
        hints: HINTS,
        bargeIn: true,
        language: "en-US"
      });
      const msg =
        "No worries, could you say your order again?";
      sayWithVoice(g, msg);
      return res.type("text/xml").send(twiml.toString());
    }
  }

  // ----- 2) suggested swap -----
  if (orderState.suggestedSwap) {
    const yes =
      speechText.includes("yes") ||
      speechText.includes("yeah") ||
      speechText.includes("sure");
    const no =
      speechText.includes("no") ||
      speechText.includes("nah") ||
      speechText.includes("nope");

    const suggestedItem = orderState.suggestedSwap.item;

    if (yes && suggestedItem) {
      const normalized = `I would like to order ${suggestedItem}.`;
      addItemsToOrder(orderItems, normalized);
      orderState.suggestedSwap = null;

      const g = twiml.gather({
        input: "speech",
        action: BASE_ACTION_URL,
        method: "POST",
        speechTimeout: "auto",
        hints: HINTS,
        bargeIn: true,
        language: "en-US"
      });
      const msg =
        `Okay, I’ve added ${suggestedItem}. Anything else?`;
      sayWithVoice(g, msg);
      return res.type("text/xml").send(twiml.toString());
    }

    if (no) {
      orderState.suggestedSwap = null;
      const g = twiml.gather({
        input: "speech",
        action: BASE_ACTION_URL,
        method: "POST",
        speechTimeout: "auto",
        hints: HINTS,
        bargeIn: true,
        language: "en-US"
      });
      const msg = "Alright, what else would you like?";
      sayWithVoice(g, msg);
      return res.type("text/xml").send(twiml.toString());
    }

    orderState.suggestedSwap = null;
  }

  // ----- 3) pending fuzzy guess -----
  if (orderState.pendingGuess) {
    const pendingGuess = orderState.pendingGuess;
    const yes =
      speechText.includes("yes") ||
      speechText.includes("yeah") ||
      speechText.includes("sure");
    const no =
      speechText.includes("no") ||
      speechText.includes("nah") ||
      speechText.includes("nope");

    if (yes) {
      const qty = pendingGuess.qty || 1;
      const normalized = `I would like to order ${
        qty > 1 ? qty + " " : ""
      }${pendingGuess.item}.`;
      addItemsToOrder(orderItems, normalized);
      orderState.pendingGuess = null;

      const g = twiml.gather({
        input: "speech",
        action: BASE_ACTION_URL,
        method: "POST",
        speechTimeout: "auto",
        hints: HINTS,
        bargeIn: true,
        language: "en-US"
      });
      const msg =
        `${formatItemWithQty(pendingGuess.item, qty)} added. Anything else?`;
      sayWithVoice(g, msg);
      return res.type("text/xml").send(twiml.toString());
    }

    if (no) {
      orderState.pendingGuess = null;
      const g = twiml.gather({
        input: "speech",
        action: BASE_ACTION_URL,
        method: "POST",
        speechTimeout: "auto",
        hints: HINTS,
        bargeIn: true,
        language: "en-US"
      });
      const msg =
        "No problem, say the dish name again slowly.";
      sayWithVoice(g, msg);
      return res.type("text/xml").send(twiml.toString());
    }

    orderState.pendingGuess = null;
  }

  // ----- 4) still there? -----
  if (orderState.waitingForStillThere) {
    if (!speechRaw) {
      const msg =
        "I’m not hearing anything, so I’ll hang up now. Please call again when you're ready.";
      sayWithVoice(twiml, msg);
      twiml.hangup();
      callOrders.delete(callSid);
      return res.type("text/xml").send(twiml.toString());
    } else {
      orderState.waitingForStillThere = false;
    }
  }

  const doneIntentByText =
    speechText.includes("that's all") ||
    speechText.includes("that is all") ||
    speechText.includes("thats all") ||
    speechText.includes("that's it") ||
    speechText.includes("that is it") ||
    speechText.includes("thats it") ||
    speechText.includes("no more") ||
    speechText.includes("nothing else") ||
    speechText.includes("i'm done") ||
    speechText.includes("that will be all");

  const doneIntent = nlu.intent === "done" || doneIntentByText;

  if (doneIntent) {
    const quickSummary =
      Object.keys(orderItems).length > 0
        ? summarizeOrder(orderItems)
        : "nothing yet";

    const g = twiml.gather({
      input: "speech",
      action: BASE_ACTION_URL,
      method: "POST",
      speechTimeout: "auto",
      bargeIn: true,
      hints: "yes,no",
      language: "en-US"
    });

    const msg =
      `Your order is: ${quickSummary}. Is that correct, yes or no?`;
    sayWithVoice(g, msg);

    orderState.confirmingFinalOrder = true;

    return res.type("text/xml").send(twiml.toString());
  }

  // ----- 5) apply NLU items -----
  const hadNluItems = nlu.items && nlu.items.length > 0;

  if (hadNluItems) {
    applyNluItemsToOrder(orderItems, nlu.items);
  }

  // ----- 6) final confirmation (add more or not) -----
  if (orderState.awaitingFinalConfirm) {
    const yes =
      speechText.includes("yes") ||
      speechText.includes("yeah") ||
      speechText.includes("sure");

    const explicitDoneText =
      speechText.includes("that's all") ||
      speechText.includes("that is all") ||
      speechText.includes("thats all") ||
      speechText.includes("that's it") ||
      speechText.includes("that is it") ||
      speechText.includes("thats it") ||
      speechText.includes("no more") ||
      speechText.includes("nothing else") ||
      speechText.includes("i'm done") ||
      speechText.includes("that will be all");

    const negativeDone =
      speechText.includes("no, that's it") ||
      speechText.includes("no thats it") ||
      speechText.includes("no, that is it") ||
      speechText.includes("no, that's all") ||
      speechText.includes("no thats all") ||
      speechText.includes("no, that is all");

    const no =
      speechText.includes("no") ||
      speechText.includes("nah") ||
      speechText.includes("nope");

    const explicitDone = explicitDoneText || negativeDone;

    if (no || explicitDone) {
      orderState.awaitingFinalConfirm = false;

      const summaryText =
        Object.keys(orderItems).length > 0
          ? summarizeOrder(orderItems)
          : "nothing yet";

      const g = twiml.gather({
        input: "speech",
        action: BASE_ACTION_URL,
        method: "POST",
        speechTimeout: "auto",
        hints: "yes,no",
        bargeIn: true,
        language: "en-US"
      });
      const msg =
        `Your order is: ${summaryText}. Is that correct, yes or no?`;
      sayWithVoice(g, msg);
      orderState.confirmingFinalOrder = true;
      return res.type("text/xml").send(twiml.toString());
    }

    if (yes) {
      orderState.awaitingFinalConfirm = false;
      const g = twiml.gather({
        input: "speech",
        action: BASE_ACTION_URL,
        method: "POST",
        speechTimeout: "auto",
        hints: HINTS,
        bargeIn: true,
        language: "en-US"
      });
      const msg =
        "Sounds good, what else would you like?";
      sayWithVoice(g, msg);
      return res.type("text/xml").send(twiml.toString());
    }

    const wantsMakeIt =
      speechText.includes("make it") ||
      speechText.includes("make that");
    if (wantsMakeIt) {
      const lastBiryani = getLastBiryaniInOrder(orderItems);
      if (lastBiryani) {
        const qty = extractQuantity(speechText) || 2;
        orderItems[lastBiryani] = qty;
        orderState.awaitingFinalConfirm = false;

        const g = twiml.gather({
          input: "speech",
          action: BASE_ACTION_URL,
          method: "POST",
          speechTimeout: "auto",
          hints: HINTS,
          bargeIn: true,
          language: "en-US"
        });
        const msg =
          `Got it, ${formatItemWithQty(lastBiryani, qty)}. Anything else today?`;
        sayWithVoice(g, msg);
        return res.type("text/xml").send(twiml.toString());
      }
    }

    const mentionsFoodOrQty =
      speechText.includes("biryani") ||
      speechText.includes("naan") ||
      speechText.includes("rice") ||
      speechText.includes("paneer") ||
      speechText.includes("chicken") ||
      speechText.includes("mutton") ||
      speechText.includes("goat") ||
      speechText.includes("lamb") ||
      speechText.includes("soup") ||
      speechText.includes("noodles") ||
      speechText.includes("masala") ||
      speechText.includes("manchurian") ||
      /\b\d+\b/.test(speechText) ||
      speechText.includes("one") ||
      speechText.includes("two") ||
      speechText.includes("three");

    if (mentionsFoodOrQty || hadNluItems) {
      orderState.awaitingFinalConfirm = false;
    } else {
      const g = twiml.gather({
        input: "speech",
        action: BASE_ACTION_URL,
        method: "POST",
        speechTimeout: "auto",
        bargeIn: true,
        hints: "yes,no",
        language: "en-US"
      });
      const msg =
        "Just yes or no, do you want to add more items?";
      sayWithVoice(g, msg);
      return res.type("text/xml").send(twiml.toString());
    }
  }

  // ----- 6a) bare "yes" after 'anything else?' -----
  if (orderState.expectingAddMoreYesNo) {
    orderState.expectingAddMoreYesNo = false;

    const cleaned = speechText.replace(/[.!?]/g, "").trim();
    const pureYes =
      cleaned === "yes" ||
      cleaned === "yeah" ||
      cleaned === "yep" ||
      cleaned === "sure";

    if (pureYes) {
      const summaryText =
        Object.keys(orderItems).length > 0
          ? summarizeOrder(orderItems)
          : "nothing yet";

      const g = twiml.gather({
        input: "speech",
        action: BASE_ACTION_URL,
        method: "POST",
        speechTimeout: "auto",
        hints: "yes,no",
        bargeIn: true,
        language: "en-US"
      });
      const msg =
        `Your order is: ${summaryText}. Is that correct, yes or no?`;
      sayWithVoice(g, msg);
      orderState.confirmingFinalOrder = true;
      return res.type("text/xml").send(twiml.toString());
    }
  }

  // ----- 6c) final order confirmation -----
  if (orderState.confirmingFinalOrder) {
    const cleaned = speechText.replace(/[.!?]/g, "").trim();
    const yes =
      cleaned === "yes" ||
      cleaned === "yeah" ||
      cleaned === "yep" ||
      cleaned === "sure";
    const no =
      cleaned === "no" ||
      cleaned === "nope" ||
      cleaned === "nah";

    if (yes) {
      orderState.confirmingFinalOrder = false;
      const summaryText =
        Object.keys(orderItems).length > 0
          ? summarizeOrder(orderItems)
          : "nothing yet";

      const msg =
        `Great, your order is placed: ${summaryText}. Thanks for calling Biryani Maxx.`;
      sayWithVoice(twiml, msg);
      twiml.hangup();
      callOrders.delete(callSid);
      return res.type("text/xml").send(twiml.toString());
    }

    if (no) {
      orderState.confirmingFinalOrder = false;

      const g = twiml.gather({
        input: "speech",
        action: BASE_ACTION_URL,
        method: "POST",
        speechTimeout: "auto",
        hints: HINTS,
        bargeIn: true,
        language: "en-US"
      });
      const msg = "Okay, what would you like to change or add?";
      sayWithVoice(g, msg);
      return res.type("text/xml").send(twiml.toString());
    }

    const g = twiml.gather({
      input: "speech",
      action: BASE_ACTION_URL,
      method: "POST",
      speechTimeout: "auto",
      hints: "yes,no",
      bargeIn: true,
      language: "en-US"
    });
    const msg = "Please say yes or no, is your order correct?";
    sayWithVoice(g, msg);
    return res.type("text/xml").send(twiml.toString());
  }

  // ----- 6b) expecting a quantity for a specific dish -----
  if (orderState.expectingQuantityFor) {
    const dish = orderState.expectingQuantityFor;
    const qtyFromText = extractQuantity(speechText);
    const parsed = parseInt(speechText, 10);
    const qty =
      qtyFromText || (!Number.isNaN(parsed) ? parsed : null);

    if (qty && qty > 0 && qty < 20) {
      orderState.expectingQuantityFor = null;

      orderItems[dish] = qty;

      const g = twiml.gather({
        input: "speech",
        action: BASE_ACTION_URL,
        method: "POST",
        speechTimeout: "auto",
        hints: HINTS,
        bargeIn: true,
        language: "en-US"
      });

      const msg =
        `Great, I’ll put ${formatItemWithQty(dish, qty)} on your order. Anything else?`;
      sayWithVoice(g, msg);

      return res.type("text/xml").send(twiml.toString());
    } else {
      const g = twiml.gather({
        input: "speech",
        action: BASE_ACTION_URL,
        method: "POST",
        speechTimeout: "auto",
        hints: "one, two, three, four, five, 1, 2, 3, 4, 5",
        bargeIn: true,
        language: "en-US"
      });
      const msg =
        `Sorry, I didn’t catch the number. How many ${dish}s would you like?`;
      sayWithVoice(g, msg);
      return res.type("text/xml").send(twiml.toString());
    }
  }

  // ----- 7) no speech -----
  if (!speechRaw) {
    orderState.waitingForStillThere = true;

    const g = twiml.gather({
      input: "speech",
      action: BASE_ACTION_URL,
      method: "POST",
      speechTimeout: 3,
      bargeIn: true,
      language: "en-US"
    });

    const msg = "Are you still there?";
    sayWithVoice(g, msg);

    return res.type("text/xml").send(twiml.toString());
  }

  // ----- 8) normal ordering / fuzzy -----
  let normalizedSpeech = normalizeSpeechToMenu(speechRaw);
  const normLower = normalizedSpeech.toLowerCase();
  const rawLower = speechRaw.toLowerCase();

  const looksLikeDishRequest =
    rawLower.includes("biryani") ||
    rawLower.includes("biriyani") ||
    rawLower.includes("rice") ||
    rawLower.includes("naan") ||
    rawLower.includes("paneer") ||
    rawLower.includes("chicken") ||
    rawLower.includes("mutton") ||
    rawLower.includes("goat") ||
    rawLower.includes("lamb") ||
    rawLower.includes("soup") ||
    rawLower.includes("noodles") ||
    rawLower.includes("65") ||
    rawLower.includes("masala") ||
    rawLower.includes("manchurian");

  if (
    (!normLower.startsWith("i would like to order") &&
      looksLikeDishRequest &&
      (!nlu.items || nlu.items.length === 0))
  ) {
    let dishCandidate = rawLower;

    dishCandidate = dishCandidate.replace(/^i want\s+/, "");
    dishCandidate = dishCandidate.replace(/^i would like to\s+/, "");
    dishCandidate = dishCandidate.replace(/^i would like\s+/, "");
    dishCandidate = dishCandidate.replace(/^can i get\s+/, "");
    dishCandidate = dishCandidate.replace(/^give me\s+/, "");
    dishCandidate = dishCandidate.replace(/^please give me\s+/, "");
    dishCandidate = dishCandidate.trim();

    const guess = findClosestMenuItem(dishCandidate || speechRaw);
    if (guess) {
      const qty = extractQuantity(rawLower) || 1;
      const candidateWithQty = formatItemWithQty(guess.item, qty);

      if (guess.confidence === "high") {
        if (!extractQuantity(rawLower)) {
          const quantityTwiml = new twilio.twiml.VoiceResponse();
          const g = quantityTwiml.gather({
            input: "speech",
            action: BASE_ACTION_URL,
            method: "POST",
            speechTimeout: "auto",
            hints: "one, two, three, four, five, 1, 2, 3, 4, 5",
            bargeIn: true,
            language: "en-US"
          });
          const tempRate =
            orderState.noise.missesInRow >= 2 ? "100%" : "105%";
          const msg = `How many ${guess.item}s would you like?`;
          g.say(
            `<speak><prosody rate="${tempRate}" pitch="+2%" volume="-1dB">${msg}</prosody></speak>`,
            { voice: VOICE_NAME }
          );

          orderState.expectingQuantityFor = guess.item;

          return res.type("text/xml").send(quantityTwiml.toString());
        }

        normalizedSpeech = `I would like to order ${candidateWithQty}.`;
      } else if (guess.confidence === "low") {
        const confirmTwiml = new twilio.twiml.VoiceResponse();
        const g = confirmTwiml.gather({
          input: "speech",
          action: BASE_ACTION_URL,
          method: "POST",
          speechTimeout: "auto",
          bargeIn: true,
          hints: HINTS,
          language: "en-US"
        });

        const msg =
          `Just to confirm, did you mean ${candidateWithQty}?`;
        sayWithVoice(g, msg);

        orderState.pendingGuess = { item: guess.item, qty };
        return res.type("text/xml").send(confirmTwiml.toString());
      }
    } else {
      const repromptTwiml = new twilio.twiml.VoiceResponse();
      const g = repromptTwiml.gather({
        input: "speech",
        action: BASE_ACTION_URL,
        method: "POST",
        speechTimeout: "auto",
        bargeIn: true,
        hints: HINTS,
        language: "en-US"
      });
      const msg =
        "I might have missed that dish. Could you say it again a bit slower?";
      sayWithVoice(g, msg);
      return res.type("text/xml").send(repromptTwiml.toString());
    }
  }

  // Auto-take “only 1 / just 1” as quantity 1 and respond explicitly
  const rawLowerForClamp = speechRaw.toLowerCase();
  const mentionsOnlyOne =
    rawLowerForClamp.includes("only 1") ||
    rawLowerForClamp.includes("just 1") ||
    rawLowerForClamp.includes("only one") ||
    rawLowerForClamp.includes("just one");

  if (mentionsOnlyOne && rawLowerForClamp.includes("biryani")) {
    normalizedSpeech = "I would like to order 1 chicken biryani.";
    addItemsToOrder(orderItems, normalizedSpeech);

    const g = twiml.gather({
      input: "speech",
      action: BASE_ACTION_URL,
      method: "POST",
      speechTimeout: "auto",
      hints: HINTS,
      bargeIn: true,
      language: "en-US"
    });
    const msg =
      "Okay, I’ll put 1 chicken biryani on your order. Anything else?";
    sayWithVoice(g, msg);
    return res.type("text/xml").send(twiml.toString());
  }

  const normLowerForClamp = normalizedSpeech.toLowerCase();
  if (
    normLowerForClamp.includes("only 1") ||
    normLowerForClamp.includes("just 1")
  ) {
    normalizedSpeech = normalizedSpeech.replace(/\b\d+\b/, "1");
  }

  const isNewOrder = addItemsToOrder(orderItems, normalizedSpeech);

  let effectiveUserText = normalizedSpeech;
  const questionLower = normalizedSpeech.toLowerCase();

  if (nlu.intent === "booking") {
    effectiveUserText =
      "The caller wants a table booking. Confirm date, time, and party size in one short sentence, then ask one follow-up question.";
  } else if (nlu.intent === "complaint") {
    effectiveUserText =
      "The caller has a complaint. Briefly acknowledge it, apologize once, and ask one simple clarifying question.";
  } else if (
    questionLower.includes("what appetizer") ||
    questionLower.includes("what appetizers") ||
    questionLower.includes("what starter") ||
    questionLower.includes("what starters")
  ) {
    effectiveUserText = "List appetizer items from the menu.";
  } else if (
    questionLower.includes("what curry") ||
    questionLower.includes("what curries") ||
    questionLower.includes("what carries")
  ) {
    effectiveUserText = "List curry items from the menu.";
  } else if (
    questionLower.includes("repeat your menu") ||
    questionLower.includes("read your menu") ||
    questionLower.includes("repeat the menu") ||
    questionLower.includes("tell me your menu items")
  ) {
    effectiveUserText = "Summarize the main items on the menu.";
  } else if (isRepeatOrderIntent(normalizedSpeech) || nlu.intent === "repeat_order") {
    effectiveUserText = "Repeat the current order with quantities.";
  } else if (
    rawLower.includes("veg manchuria") ||
    rawLower.includes("vegetable machuria") ||
    rawLower.includes("vegetable manchuria")
  ) {
    orderState.suggestedSwap = { item: "gobi manchurian" };
    effectiveUserText =
      "Tell the customer we don’t have vegetable manchurian and suggest gobi manchurian instead, then ask a yes/no.";
  }

  if (
    hadNluItems &&
    Object.keys(orderItems).length > 0 &&
    !orderState.pendingOrderConfirm &&
    !orderState.awaitingFinalConfirm &&
    !orderState.pendingGuess
  ) {
    const itemsCopy = { ...orderItems };
    orderState.pendingOrderConfirm = { items: itemsCopy };
    const summary = summarizeOrder(itemsCopy);

    const confirmTwiml = new twilio.twiml.VoiceResponse();
    const g = confirmTwiml.gather({
      input: "speech",
      action: BASE_ACTION_URL,
      method: "POST",
      speechTimeout: "auto",
      hints: "yes,no",
      bargeIn: true,
      language: "en-US"
    });
    const msg =
      `I see you’d like ${summary}. Is that correct?`;
    sayWithVoice(g, msg);
    return res.type("text/xml").send(confirmTwiml.toString());
  }

  try {
    let orderText = "Okay. Anything else?";

    if (process.env.OPENAI_API_KEY) {
      const gptResponse = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a calm, efficient phone host for Biryani Maxx, taking food orders over a noisy phone line. " +
              "ASR has already turned the caller’s speech into text; it may contain small errors. " +
              "Respond like real restaurant staff: neutral, clear, and concise. " +
              "Tone: conversational, polite, not salesy, not over-excited. " +
              "Use plain American English. " +
              "Keep responses very short and natural, usually 1 sentence under 12 words. " +
              "Never answer with more than 2 short sentences. " +
              "The restaurant ONLY serves: " +
              MENU_DESCRIPTION +
              ". " +
              "The current order is: " +
              summarizeOrder(orderItems) +
              ". " +
              (isNewOrder || hadNluItems
                ? "They just ordered or changed items; briefly acknowledge that once."
                : "") +
              "If they clearly ordered a single dish with no number (e.g. 'chicken biryani'), ask: 'How many chicken biryanis would you like?'. " +
              "If they ask to repeat their order, clearly list items with quantities in one sentence. " +
              "If they ask for something off-menu, say it’s not available and suggest one similar on-menu option. " +
              "If you didn’t understand, say something like 'I might have missed that, could you say it again?'. " +
              "Avoid more than one question per turn. " +
              "Your replies will be converted to speech, so output plain text only, no lists or formatting."
          },
          { role: "user", content: effectiveUserText }
        ],
        max_tokens: 40
      });

      orderText = gptResponse.choices[0].message.content || orderText;

      try {
        saveOrder({ order: orderText, timestamp: new Date().toISOString() });
      } catch (dbErr) {
        console.error("DB save error:", dbErr);
      }
    }

    const g = twiml.gather({
      input: "speech",
      action: BASE_ACTION_URL,
      method: "POST",
      speechTimeout: "auto",
      hints: HINTS,
      bargeIn: true,
      language: "en-US"
    });

    sayWithVoice(g, orderText);

    return res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("Error in /process-order:", err);

    const errorTwiml = new twilio.twiml.VoiceResponse();
    const g = errorTwiml.gather({
      input: "speech",
      action: BASE_ACTION_URL,
      method: "POST",
      speechTimeout: 3,
      bargeIn: true,
      language: "en-US"
    });
    const msg =
      "Sorry, something glitched on my side. Could you say that again?";
    sayWithVoice(g, msg);
    return res.type("text/xml").send(errorTwiml.toString());
  }
}

app.post("/process-order", (req, res) => {
  processOrder(req, res);
});

app.post("/test-process-order", (req, res) => {
  req.body.CallSid = req.body.CallSid || "TEST_CALL_SID";
  req.body.SpeechResult = req.body.SpeechResult || "";
  return processOrder(req, res);
});

// EC2-friendly: use PORT from env, default 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);
