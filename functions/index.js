const express = require("express");
const fetch = require("node-fetch");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const serviceAccount = require("./config/serviceAccountKey.json");

const app = express();

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const LINE_ACCESS_TOKEN =
  "iaUWWFTPuHzRdvuyRO0IgsaQIuEs9+49VdeDXBjr71JpSRDLfFVheotMRz8CkVuEH6k4VQwA5qevSlto8y03XiN+uEOP9l7D9Cc8n2LLTzcaQQ8LyM9do6uwX2ypOz109Jcc9A3yXbhI3cA/YU/tGAdB04t89/1O/w1cDnyilFU=";

app.get("/", (req, res) => {
  res.send("Booking Room Backend is running!");
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// ✅ Route สำหรับส่งข้อความไปยัง LINE
app.post("/send-line-message", async (req, res) => {
  const {
    userId,
    activity,
    date,
    startTime,
    endTime,
    booker,
    phone,
    attendees,
    specialRequests
  } = req.body;

  if (!userId || !activity || !date || !startTime || !endTime || !booker) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    // 1️⃣ บันทึกข้อมูลลง Firestore
    const docRef = await db.collection("bookings").add({
      activity,
      date,
      startTime,
      endTime,
      booker,
      phone,
      attendees,
      specialRequests,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log("Booking saved with ID:", docRef.id);

    // 2️⃣ ส่งข้อความไปยัง LINE
    const lineMessage = {
      to: userId,
      messages: [
        {
          type: "text",
          text:
            `📅 รายละเอียดการจอง:\n` +
            `กิจกรรม: ${activity}\n` +
            `วันที่: ${date}\n` +
            `เวลา: ${startTime} - ${endTime}\n` +
            `ผู้จอง: ${booker}\n` +
            `โทร: ${phone}\n` +
            `จำนวนผู้เข้าร่วม: ${attendees}\n` +
            `คำขอพิเศษ: ${specialRequests || "-"}`
        }
      ]
    };

    const response = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LINE_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(lineMessage),
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.error("LINE API error:", responseText);
      return res.status(500).json({ error: responseText });
    }

    return res.status(200).json({ success: true, docId: docRef.id });
  } catch (err) {
    console.error("Error:", err);
    return res.status(500).json({ error: err.message });
  }
});


app.get("/getRooms", async (req, res) => {
  try {
    const snapshot = await db.collection("rooms").get();
    const rooms = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(rooms);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }

  // res.status(200).json(rooms);
});

// ✅ Firebase export (V1 style – ใช้กับ firebase-functions@6)
exports.app = onRequest(
  { cors: true },
  app
);
