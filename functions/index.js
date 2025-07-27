const express = require("express");
const fetch = require("node-fetch");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const serviceAccount = require("./config/serviceAccountKey.json");
const { google } = require('googleapis');
const authorize = require('./auth');

const app = express();
const oAuth2Client = authorize();

const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });

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
    // userId,
    selectedRoom,
    activity,
    date,
    startTime,
    endTime,
    booker,
    phone,
    attendees,
    specialRequests
  } = req.body;


  if (!selectedRoom || !activity || !date || !startTime || !endTime || !booker) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const status = "pending"; // สถานะเริ่มต้น

  try {
    // 1️⃣ บันทึกข้อมูลลง Firestore
    const docRef = await db.collection("bookingData").add({
      selectedRoom: selectedRoom.name,
      activity,
      date,
      startTime,
      endTime,
      booker,
      phone,
      attendees,
      specialRequests,
      status: status, // สถานะเริ่มต้น
    });

    console.log("📄 Booking data saved with ID:", docRef.id);


    // 2️⃣ ส่งข้อความไปยัง LINE
    const lineMessage = {
      to: "U2698869fcd7379f81181c2fdc0b961eb",
      "messages": [
        {
          "type": "flex",
          "altText": "การจองห้องประชุมสำเร็จ",
          "contents": {
            "type": "bubble",
            "header": {
              "type": "box",
              "layout": "vertical",
              "contents": [
                {
                  "type": "text",
                  "text": "✅ จองห้องประชุมสำเร็จ",
                  "weight": "bold",
                  "size": "lg",
                  "color": "#1DB446"
                }
              ]
            },
            "hero": {
              "type": "image",
              "url": `${selectedRoom.picture}`,
              "size": "full",
              "aspectRatio": "16:9",
              "aspectMode": "cover"
            },
            "body": {
              "type": "box",
              "layout": "vertical",
              "spacing": "md",
              "contents": [
                {
                  "type": "text",
                  "text": `ห้อง: ${selectedRoom.name}`,
                  "weight": "bold",
                  "size": "md"
                },
                {
                  "type": "box",
                  "layout": "baseline",
                  "contents": [
                    {
                      "type": "text",
                      "text": "วันที่:",
                      "weight": "bold",
                      "size": "sm",
                      "flex": 1
                    },
                    {
                      "type": "text",
                      "text": `${date}`,
                      "size": "sm",
                      "flex": 3
                    }
                  ]
                },
                {
                  "type": "text",
                  "text": `ผู้จอง: ${booker} (${phone})`,
                  "size": "sm",
                  "wrap": true
                },
                {
                  "type": "text",
                  "text": `กิจกรรม: ${activity}`,
                  "size": "sm",
                  "wrap": true
                },
                {
                  "type": "text",
                  "text": `จำนวนผู้เข้าร่วม: ${attendees}`,
                  "size": "sm"
                },
                {
                  "type": "text",
                  "text": `คำขอพิเศษ: ${specialRequests}`,
                  "size": "sm",
                  "wrap": true
                },
                {
                  "type": "text",
                  "text": `สถานะ: ${status}`,
                  "size": "sm",
                  "color": "#888888"
                }
              ]
            },
            "footer": {
              "type": "box",
              "layout": "horizontal",
              "contents": [
                {
                  "type": "button",
                  "action": {
                    "type": "uri",
                    "label": "ยกเลิกการจอง",
                    "uri": `http://10.32.204.20:5001/booking-room-backend/us-central1/app/updateState/${docRef.id}?status=rejected`
                  },
                  "style": "primary"
                }
              ]
            }
          }
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
});

app.get("/getMoreBooking/:page", async (req, res) => {
  const limit = 5;
  const page = parseInt(req.params.page) || 1;
  const start = (page - 1) * limit;

  const status = req.query.status; // รับ query param: ?status=pending

  try {
    let query = db.collection("bookingData");

    // ถ้ามีการส่ง status มาใน query, ให้ filter
    if (status) {
      query = query.where("status", "==", status);
    }

    const snapshot = await query.get();
    const allData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    const totalItems = allData.length;
    const totalPages = Math.ceil(totalItems / limit);

    const paginatedData = allData.slice(start, start + limit);

    res.status(200).json({
      currentPage: page,
      totalPages,
      totalItems,
      data: paginatedData
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/getStatusNumber", async (req, res) => {
  try {
    const snapshot = await db.collection("bookingData").get();
    const allData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    const statusCount = allData.reduce((acc, booking) => {
      acc[booking.status] = (acc[booking.status] || 0) + 1;
      return acc;
    }, {});

    // แปลง object เป็น array format ที่ต้องการ
    const formattedResult = Object.entries(statusCount).map(([status, count]) => ({
      status,
      count
    }));

    res.status(200).json(formattedResult);
  }
  catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/updateState/:docId", async (req, res) => {
  const docId = req.params.docId;
  const status = req.query.status; // รับ query param: ?status=approved หรือ ?status=rejected

  try {
    // อัปเดตสถานะ
    await db.collection("bookingData").doc(docId).update({ status });

    if (status === "approved") {
      // ดึงข้อมูลจาก Firestore
      const doc = await db.collection("bookingData").doc(docId).get();
      if (!doc.exists) {
        return res.status(404).json({ error: "Document not found" });
      }
      const booking = doc.data();
      // สร้าง Event ใน Google Calendar
      const event = await createCalendarEventFromBooking(booking);
      res.status(200).json({
        success: true,
        calendarEventLink: event.htmlLink,
        calendarEventId: event.id,
      });
    }

    else if (status === "rejected") {
      console.log(`Booking with ID ${docId} has been rejected.`);
      
      res.redirect(`http://localhost:5173/success`);
    }

  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ error: error.message });
  }
});

async function createCalendarEventFromBooking(booking) {
  const event = {
    summary: booking.activity,
    description: booking.booker,
    start: {
      dateTime: `${booking.date}T${booking.startTime}:00`,
      timeZone: 'Asia/Bangkok', // เปลี่ยนเป็นเวลาประเทศไทย
    },
    end: {
      dateTime: `${booking.date}T${booking.endTime}:00`,
      timeZone: 'Asia/Bangkok',
    },
  };

  console.log('📅 Creating calendar event:', event);

  return new Promise((resolve, reject) => {
    calendar.events.insert(
      {
        calendarId: 'primary',
        resource: event,
      },
      (err, event) => {
        if (err) {
          return reject(err);
        }
        resolve(event.data);
      }
    );
  });
}

exports.app = onRequest(
  { cors: true },
  app
);
