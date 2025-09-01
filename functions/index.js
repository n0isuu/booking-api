const express = require("express");
const fetch = require("node-fetch");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const serviceAccount = require("./config/serviceAccountKey.json");
const { google } = require("googleapis");
const authorize = require("./auth");
const { FieldValue } = require("firebase-admin/firestore");
const { text } = require("body-parser");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const functions = require("firebase-functions");

const app = express();
const oAuth2Client = authorize();

const calendar = google.calendar({ version: "v3", auth: oAuth2Client });

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

// ✅ ฟังก์ชันดึงรายชื่อ Admin จาก Firestore
async function getAdminUsers() {
  try {
    const adminSnapshot = await db
      .collection("users")
      .where("role", "==", "admin")
      .get();

    const adminUsers = [];
    adminSnapshot.forEach((doc) => {
      const adminData = doc.data();
      if (adminData.lineUserId) {
        // ตรวจสอบว่ามี LINE User ID
        adminUsers.push({
          id: doc.id,
          lineUserId: adminData.lineUserId,
          name: adminData.name || "Admin",
          isActive: adminData.isActive !== false, // default เป็น active
        });
      }
    });

    return adminUsers.filter((admin) => admin.isActive); // ส่งเฉพาะ admin ที่ active
  } catch (error) {
    console.error("❌ Error fetching admin users:", error);
    return [];
  }
}

// ✅ ส่งข้อความไปหาทุก Admin
async function notifyAllAdmins(message) {
  const admins = await getAdminUsers();

  if (admins.length === 0) {
    console.warn("⚠️ No active admin users found!");
    return false;
  }

  const sendPromises = admins.map(async (admin) => {
    try {
      await sendLineMessage(admin.lineUserId, message);
      console.log(`📤 Notified admin: ${admin.name} (${admin.lineUserId})`);
      return { success: true, admin: admin.name };
    } catch (error) {
      console.error(`❌ Failed to notify admin ${admin.name}:`, error);
      return { success: false, admin: admin.name, error: error.message };
    }
  });

  const results = await Promise.all(sendPromises);
  const successCount = results.filter((r) => r.success).length;

  console.log(
    `📊 Admin notification results: ${successCount}/${admins.length} successful`
  );
  return successCount > 0;
}

function formatThaiDate(dateStr) {
  const months = [
    "ม.ค.",
    "ก.พ.",
    "มี.ค.",
    "เม.ย.",
    "พ.ค.",
    "มิ.ย.",
    "ก.ค.",
    "ส.ค.",
    "ก.ย.",
    "ต.ค.",
    "พ.ย.",
    "ธ.ค.",
  ];

  const [year, month, day] = dateStr.split("-");
  const buddhistYear = parseInt(year, 10) + 543;

  return `${parseInt(day, 10)} ${
    months[parseInt(month, 10) - 1]
  } ${buddhistYear}`;
}

// ✅ ฟังก์ชันแปลงวันที่เป็นภาษาไทย
function formatThaiDate(dateString) {
  const date = new Date(dateString);
  return date.toLocaleDateString("th-TH", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// ✅ Route สำหรับส่งข้อความไปยัง LINE
app.post("/send-line-message", async (req, res) => {
  const {
    userId,
    selectedRoom,
    activity,
    date,
    startTime,
    endTime,
    booker,
    phone,
    attendees,
    specialRequests,
    userProfile,
  } = req.body;

  if (
    !selectedRoom ||
    !activity ||
    !date ||
    !startTime ||
    !endTime ||
    !booker
  ) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const status = "pending"; // สถานะเริ่มต้น

  try {
    // 1️⃣ บันทึกข้อมูลลง Firestore
    const docRef = await db.collection("bookingData").add({
      userId: userId, // เก็บ User ID ผู้จอง
      userProfile: userProfile, // เก็บ profile ผู้จอง
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
      timestamp: FieldValue.serverTimestamp(),
      adminNotified: false, // Flag สำหรับแจ้ง admin
    });

    console.log("📄 Booking data saved with ID:", docRef.id);

    // 2️⃣ ส่งข้อความยืนยันไปยังผู้จอง
    const userConfirmMessage = createUserConfirmMessage(
      selectedRoom,
      {
        activity,
        date,
        startTime,
        endTime,
        booker,
        phone,
        attendees,
        specialRequests,
      },
      docRef.id
    );

    await sendLineMessage(userId, userConfirmMessage);

    // 3️⃣ ส่งข้อความแจ้งเตือนทุก Admin แทนที่จะเป็นคนเดียว
    const adminNotificationMessage = createAdminNotificationMessage(
      selectedRoom,
      {
        activity,
        date,
        startTime,
        endTime,
        booker,
        phone,
        attendees,
        specialRequests,
        userProfile,
      },
      docRef.id
    );

    // ✅ ส่งหาทุก Admin แทนที่จะส่งหาคนเดียว
    const adminNotifySuccess = await notifyAllAdmins(adminNotificationMessage);

    if (adminNotifySuccess) {
      // อัพเดท flag แจ้ง admin แล้ว
      await db.collection("bookingData").doc(docRef.id).update({
        adminNotified: true,
        adminNotifiedAt: FieldValue.serverTimestamp(),
      });
    } else {
      console.warn("⚠️ Failed to notify any admin users");
    }

    return res.status(200).json({
      success: true,
      docId: docRef.id,
      message: "Booking request sent successfully",
      adminNotified: adminNotifySuccess,
    });
  } catch (err) {
    console.error("Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// สร้าง Flex Message สำหรับผู้จอง (ยืนยันการจอง)
function createUserConfirmMessage(selectedRoom, bookingData, docId) {
  return {
    type: "flex",
    altText: "✓ ส่งคำขอจองห้องประชุมสำเร็จ",
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "horizontal",
        backgroundColor: "#E8F5E8",
        paddingAll: "lg",
        contents: [
          {
            type: "text",
            text: "✓ ส่งคำขอจองห้องประชุมสำเร็จ",
            size: "sm",
            color: "#2E7D32",
            weight: "bold",
            flex: 1,
          },
        ],
      },
      hero: selectedRoom.picture
        ? {
            type: "image",
            url: selectedRoom.picture,
            size: "full",
            aspectRatio: "16:9",
            aspectMode: "cover",
          }
        : undefined,
      body: {
        type: "box",
        layout: "vertical",
        spacing: "lg",
        paddingAll: "lg",
        contents: [
          {
            type: "text",
            text: selectedRoom.name,
            weight: "bold",
            size: "lg",
            color: "#333333",
          },
          {
            type: "box",
            layout: "vertical",
            spacing: "md",
            contents: [
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  {
                    type: "text",
                    text: "🗓️",
                    size: "sm",
                    flex: 0,
                  },
                  {
                    type: "box",
                    layout: "vertical",
                    flex: 1,
                    margin: "sm",
                    contents: [
                      {
                        type: "text",
                        text: "วันที่",
                        size: "xs",
                        color: "#888888",
                      },
                      {
                        type: "text",
                        text: formatThaiDate(bookingData.date),
                        size: "sm",
                        weight: "bold",
                        color: "#333333",
                      },
                    ],
                  },
                ],
              },
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  {
                    type: "text",
                    text: "🕰️",
                    size: "sm",
                    flex: 0,
                  },
                  {
                    type: "box",
                    layout: "vertical",
                    flex: 1,
                    margin: "sm",
                    contents: [
                      {
                        type: "text",
                        text: "เวลา",
                        size: "xs",
                        color: "#888888",
                      },
                      {
                        type: "text",
                        text: `${bookingData.startTime} - ${bookingData.endTime} น.`,
                        size: "sm",
                        weight: "bold",
                        color: "#333333",
                      },
                    ],
                  },
                ],
              },
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  {
                    type: "text",
                    text: "📋",
                    size: "sm",
                    flex: 0,
                  },
                  {
                    type: "box",
                    layout: "vertical",
                    flex: 1,
                    margin: "sm",
                    contents: [
                      {
                        type: "text",
                        text: "กิจกรรม",
                        size: "xs",
                        color: "#888888",
                      },
                      {
                        type: "text",
                        text: bookingData.activity,
                        size: "sm",
                        weight: "bold",
                        color: "#333333",
                        wrap: true,
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            type: "separator",
            margin: "lg",
          },
          {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents: [
              {
                type: "text",
                text: "📝 สถานะการจอง",
                weight: "bold",
                size: "md",
                color: "#333333",
              },
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  {
                    type: "box",
                    layout: "vertical",
                    contents: [
                      {
                        type: "filler",
                      },
                      {
                        type: "box",
                        layout: "vertical",
                        contents: [],
                        width: "12px",
                        height: "12px",
                        backgroundColor: "#FFC107",
                        cornerRadius: "6px",
                      },
                      {
                        type: "filler",
                      },
                    ],
                    flex: 0,
                  },
                  {
                    type: "box",
                    layout: "vertical",
                    contents: [
                      {
                        type: "text",
                        text: "รอการอนุมัติ",
                        size: "sm",
                        weight: "bold",
                        color: "#F57C00",
                      },
                      {
                        type: "text",
                        text: "ระบบได้ส่งคำขอไปยังผู้ดูแลแล้ว",
                        size: "xs",
                        color: "#666666",
                        wrap: true,
                      },
                    ],
                    margin: "sm",
                  },
                ],
              },
            ],
          },
        ],
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "sm",
        paddingAll: "lg",
        contents: [
          {
            type: "button",
            action: {
              type: "uri",
              label: "ยกเลิกการจอง",
              uri: `https://us-central1-booking-room-backend.cloudfunctions.net/app/cancelBooking/${docId}`,
            },
            style: "secondary",
            color: "#666666",
          },
        ],
      },
    },
  };
}

// สร้าง Flex Message สำหรับ Admin (แจ้งเตือนมีการจองใหม่)
function createAdminNotificationMessage(selectedRoom, bookingData, docId) {
  return {
    type: "flex",
    altText: "🔔 มีคำขอจองห้องประชุมใหม่",
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "horizontal",
        backgroundColor: "#FF5722",
        paddingAll: "lg",
        contents: [
          {
            type: "text",
            text: "🔔 มีคำขอจองห้องประชุมใหม่",
            size: "sm",
            color: "#FFFFFF",
            weight: "bold",
            flex: 1,
          },
        ],
      },
      hero: selectedRoom.picture
        ? {
            type: "image",
            url: selectedRoom.picture,
            size: "full",
            aspectRatio: "16:9",
            aspectMode: "cover",
          }
        : undefined,
      body: {
        type: "box",
        layout: "vertical",
        spacing: "lg",
        paddingAll: "lg",
        contents: [
          {
            type: "text",
            text: selectedRoom.name,
            weight: "bold",
            size: "lg",
            color: "#333333",
          },
          {
            type: "box",
            layout: "vertical",
            spacing: "md",
            contents: [
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  {
                    type: "text",
                    text: "👤",
                    size: "sm",
                    flex: 0,
                  },
                  {
                    type: "box",
                    layout: "vertical",
                    flex: 1,
                    margin: "sm",
                    contents: [
                      {
                        type: "text",
                        text: "ผู้จอง",
                        size: "xs",
                        color: "#888888",
                      },
                      {
                        type: "text",
                        text: bookingData.booker,
                        size: "sm",
                        weight: "bold",
                        color: "#333333",
                      },
                    ],
                  },
                ],
              },
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  {
                    type: "text",
                    text: "📞",
                    size: "sm",
                    flex: 0,
                  },
                  {
                    type: "box",
                    layout: "vertical",
                    flex: 1,
                    margin: "sm",
                    contents: [
                      {
                        type: "text",
                        text: "เบอร์โทร",
                        size: "xs",
                        color: "#888888",
                      },
                      {
                        type: "text",
                        text: bookingData.phone,
                        size: "sm",
                        weight: "bold",
                        color: "#333333",
                      },
                    ],
                  },
                ],
              },
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  {
                    type: "text",
                    text: "🗓️",
                    size: "sm",
                    flex: 0,
                  },
                  {
                    type: "box",
                    layout: "vertical",
                    flex: 1,
                    margin: "sm",
                    contents: [
                      {
                        type: "text",
                        text: "วันที่ - เวลา",
                        size: "xs",
                        color: "#888888",
                      },
                      {
                        type: "text",
                        text: `${formatThaiDate(bookingData.date)} \n${
                          bookingData.startTime
                        }-${bookingData.endTime} น.`,
                        size: "sm",
                        weight: "bold",
                        color: "#333333",
                        wrap: true,
                      },
                    ],
                  },
                ],
              },
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  {
                    type: "text",
                    text: "📋",
                    size: "sm",
                    flex: 0,
                  },
                  {
                    type: "box",
                    layout: "vertical",
                    flex: 1,
                    margin: "sm",
                    contents: [
                      {
                        type: "text",
                        text: "กิจกรรม",
                        size: "xs",
                        color: "#888888",
                      },
                      {
                        type: "text",
                        text: bookingData.activity,
                        size: "sm",
                        weight: "bold",
                        color: "#333333",
                        wrap: true,
                      },
                    ],
                  },
                ],
              },
              ...(bookingData.attendees
                ? [
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "👥",
                          size: "sm",
                          flex: 0,
                        },
                        {
                          type: "box",
                          layout: "vertical",
                          flex: 1,
                          margin: "sm",
                          contents: [
                            {
                              type: "text",
                              text: "จำนวนผู้เข้าร่วม",
                              size: "xs",
                              color: "#888888",
                            },
                            {
                              type: "text",
                              text: `${bookingData.attendees} คน`,
                              size: "sm",
                              weight: "bold",
                              color: "#333333",
                            },
                          ],
                        },
                      ],
                    },
                  ]
                : []),
              ...(bookingData.specialRequests
                ? [
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "📝",
                          size: "sm",
                          flex: 0,
                        },
                        {
                          type: "box",
                          layout: "vertical",
                          flex: 1,
                          margin: "sm",
                          contents: [
                            {
                              type: "text",
                              text: "ความต้องการพิเศษ",
                              size: "xs",
                              color: "#888888",
                            },
                            {
                              type: "text",
                              text: bookingData.specialRequests,
                              size: "sm",
                              weight: "bold",
                              color: "#333333",
                              wrap: true,
                            },
                          ],
                        },
                      ],
                    },
                  ]
                : []),
            ],
          },
        ],
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "sm",
        paddingAll: "lg",
        contents: [
          {
            type: "button",
            action: {
              type: "uri",
              label: "✓ อนุมัติ",
              uri: `https://us-central1-booking-room-backend.cloudfunctions.net/app/updateState/${docId}?status=approved`,
            },
            style: "primary",
            color: "#4CAF50",
          },
          {
            type: "button",
            action: {
              type: "uri",
              label: "✗ ปฏิเสธ",
              uri: `https://us-central1-booking-room-backend.cloudfunctions.net/app/updateState/${docId}?status=rejected`,
            },
            style: "secondary",
            color: "#F44336",
          },
        ],
      },
    },
  };
}

// แก้ไข updateState route ให้ส่งข้อความกลับไปหาผู้จองและป้องกันการกดซ้ำ
app.get("/updateState/:docId", async (req, res) => {
  const docId = req.params.docId;
  const status = req.query.status;
  const adminAction = req.query.admin === "true"; // ตรวจสอบว่าเป็นการกระทำของ admin หรือไม่

  try {
    // ดึงข้อมูล booking
    const doc = await db.collection("bookingData").doc(docId).get();
    if (!doc.exists) {
      return res.status(404).send(`
        <html>
          <body>
            <h2>ไม่พบข้อมูลการจอง</h2>
            <p>เอกสารที่ร้องขอไม่มีอยู่ในระบบ</p>
          </body>
        </html>
      `);
    }

    const booking = doc.data();

    // ตรวจสอบสถานะปัจจุบัน - ป้องกันการกดซ้ำ
    if (booking.status !== "pending") {
      const statusText = {
        approved: "อนุมัติแล้ว",
        rejected: "ปฏิเสธแล้ว",
        cancelled: "ยกเลิกแล้ว",
      };

      return res.status(400).send(`
        <html>
          <head>
            <meta charset="UTF-8">
            <title>การจองได้ดำเนินการแล้ว</title>
          </head>
          <body style="font-family: Arial, sans-serif; padding: 20px; text-align: center;">
            <h2>⚠️ การจองนี้${
              statusText[booking.status] || "ดำเนินการแล้ว"
            }</h2>
            <p>สถานะของการจองนี้ถูกเปลี่ยนแปลงแล้ว ไม่สามารถดำเนินการซ้ำได้</p>
            <p>สถานะปัจจุบัน: <strong>${statusText[booking.status]}</strong></p>
          </body>
        </html>
      `);
    }

    // อัปเดตสถานะใน Firestore
    const updateData = {
      status,
      updatedAt: FieldValue.serverTimestamp(),
    };

    // เพิ่มข้อมูลการ action ถ้าเป็น admin
    if (adminAction) {
      updateData.adminActionAt = FieldValue.serverTimestamp();
    }

    await db.collection("bookingData").doc(docId).update(updateData);

    // ส่ง Flex Message กลับไปหาผู้จอง
    if (booking.userId) {
      const userNotificationMessage = createUserNotificationMessage(
        booking,
        status
      );
      await sendLineMessage(booking.userId, userNotificationMessage);
    }

    // ถ้า approved ให้สร้าง calendar event ด้วย
    if (status === "approved") {
      try {
        const event = await createCalendarEventFromBooking(booking);

        // ส่งหน้าเว็บแจ้งผลสำเร็จ
        return res.status(200).send(`
          <html>
            <head>
              <meta charset="UTF-8">
              <title>อนุมัติการจองสำเร็จ</title>
              <meta name="viewport" content="width=device-width, initial-scale=1">
            </head>
            <body style="font-family: Arial, sans-serif; padding: 20px; text-align: center; background-color: #f8f9fa;">
              <div style="max-width: 400px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                <div style="color: #4CAF50; font-size: 48px; margin-bottom: 20px;">✅</div>
                <h2 style="color: #333; margin-bottom: 15px;">อนุมัติการจองสำเร็จ!</h2>
                <p style="color: #666; margin-bottom: 20px;">การจองห้อง <strong>${booking.selectedRoom}</strong> ได้รับการอนุมัติแล้ว</p>
                <p style="color: #666; margin-bottom: 20px;">ระบบได้สร้างกิจกรรมใน Google Calendar และแจ้งเตือนผู้จองเรียบร้อยแล้ว</p>
              </div>
            </body>
          </html>
        `);
      } catch (calendarError) {
        console.error("Calendar error:", calendarError);
        return res.status(200).send(`
          <html>
            <head>
              <meta charset="UTF-8">
              <title>อนุมัติการจองสำเร็จ</title>
            </head>
            <body style="font-family: Arial, sans-serif; padding: 20px; text-align: center;">
              <h2 style="color: #4CAF50;">✅ อนุมัติการจองสำเร็จ!</h2>
              <p>การจองได้รับการอนุมัติแล้ว แต่ไม่สามารถสร้าง Calendar Event ได้</p>
              <p style="color: #f44336;">Calendar Error: ${calendarError.message}</p>
            </body>
          </html>
        `);
      }
    } else {
      // กรณี reject หรือ cancel
      const actionText = status === "rejected" ? "ปฏิเสธ" : "ยกเลิก";
      return res.status(200).send(`
        <html>
          <head>
            <meta charset="UTF-8">
            <title>${actionText}การจองสำเร็จ</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
          </head>
          <body style="font-family: Arial, sans-serif; padding: 20px; text-align: center; background-color: #f8f9fa;">
            <div style="max-width: 400px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
              <div style="color: #f44336; font-size: 48px; margin-bottom: 20px;">${
                status === "rejected" ? "❌" : "🚫"
              }</div>
              <h2 style="color: #333; margin-bottom: 15px;">${actionText}การจองสำเร็จ</h2>
              <p style="color: #666; margin-bottom: 20px;">การจองห้อง <strong>${
                booking.selectedRoom
              }</strong> ได้ถูก${actionText}แล้ว</p>
              <p style="color: #666;">ระบบได้แจ้งเตือนผู้จองเรียบร้อยแล้ว</p>
            </div>
          </body>
        </html>
      `);
    }
  } catch (error) {
    console.error("❌ Error:", error);
    return res.status(500).send(`
      <html>
        <head>
          <meta charset="UTF-8">
          <title>เกิดข้อผิดพลาด</title>
        </head>
        <body style="font-family: Arial, sans-serif; padding: 20px; text-align: center;">
          <h2 style="color: #f44336;">เกิดข้อผิดพลาด</h2>
          <p>${error.message}</p>
        </body>
      </html>
    `);
  }
});

// เพิ่ม route สำหรับการยกเลิกจากผู้ใช้
app.get("/cancelBooking/:docId", async (req, res) => {
  const docId = req.params.docId;

  try {
    const doc = await db.collection("bookingData").doc(docId).get();
    if (!doc.exists) {
      return res.status(404).send(`
        <html>
          <head>
            <meta charset="UTF-8">
            <title>ไม่พบข้อมูลการจอง</title>
          </head>
          <body style="font-family: Arial, sans-serif; padding: 20px; text-align: center;">
            <h2>ไม่พบข้อมูลการจอง</h2>
            <p>เอกสารที่ร้องขอไม่มีอยู่ในระบบ</p>
          </body>
        </html>
      `);
    }

    const booking = doc.data();

    // ตรวจสอบสถานะปัจจุบัน
    if (booking.status !== "pending") {
      const statusText = {
        approved: "อนุมัติแล้ว",
        rejected: "ปฏิเสธแล้ว",
        cancelled: "ยกเลิกแล้ว",
      };

      return res.status(400).send(`
        <html>
          <head>
            <meta charset="UTF-8">
            <title>ไม่สามารถยกเลิกได้</title>
          </head>
          <body style="font-family: Arial, sans-serif; padding: 20px; text-align: center;">
            <h2>ไม่สามารถยกเลิกการจองได้</h2>
            <p>การจองนี้${statusText[booking.status]} ไม่สามารถยกเลิกได้แล้ว</p>
          </body>
        </html>
      `);
    }

    // อัปเดตสถานะเป็น cancelled
    await db.collection("bookingData").doc(docId).update({
      status: "cancelled",
      cancelledAt: FieldValue.serverTimestamp(),
      cancelledBy: "user",
    });

    // แจ้งเตือน Admin ว่ามีการยกเลิก
    const adminCancelNotification = {
      type: "text",
      text: `การจองห้อง "${booking.selectedRoom}" วันที่ ${formatThaiDate(
        booking.date
      )} เวลา ${booking.startTime}-${booking.endTime} โดย ${
        booking.booker
      } ได้ถูกยกเลิกโดยผู้จอง`,
    };

    await sendLineMessage(ADMIN_USER_ID, adminCancelNotification);

    return res.status(200).send(`
      <html>
        <head>
          <meta charset="UTF-8">
          <title>ยกเลิกการจองสำเร็จ</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
        </head>
        <body style="font-family: Arial, sans-serif; padding: 20px; text-align: center; background-color: #f8f9fa;">
          <div style="max-width: 400px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <div style="color: #ff9800; font-size: 48px; margin-bottom: 20px;">✓</div>
            <h2 style="color: #333; margin-bottom: 15px;">ยกเลิกการจองสำเร็จ</h2>
            <p style="color: #666; margin-bottom: 20px;">การจองห้อง <strong>${booking.selectedRoom}</strong> ได้ถูกยกเลิกแล้ว</p>
            <p style="color: #666;">ระบบได้แจ้งเตือนผู้ดูแลเรียบร้อยแล้ว</p>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Cancel booking error:", error);
    return res.status(500).send(`
      <html>
        <head>
          <meta charset="UTF-8">
          <title>เกิดข้อผิดพลาด</title>
        </head>
        <body style="font-family: Arial, sans-serif; padding: 20px; text-align: center;">
          <h2 style="color: #f44336;">เกิดข้อผิดพลาด</h2>
          <p>${error.message}</p>
        </body>
      </html>
    `);
  }
});

// สร้าง Flex Message แจ้งผู้ใช้หลังจาก admin ดำเนินการ
function createUserNotificationMessage(booking, status) {
  const isApproved = status === "approved";

  return {
    type: "flex",
    altText: isApproved ? "✅ การจองได้รับการอนุมัติ" : "❌ การจองถูกปฏิเสธ",
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "horizontal",
        backgroundColor: isApproved ? "#E8F5E8" : "#FFEBEE",
        paddingAll: "lg",
        contents: [
          {
            type: "text",
            text: isApproved
              ? "✅ การจองได้รับการอนุมัติ"
              : "❌ การจองถูกปฏิเสธ",
            size: "sm",
            color: isApproved ? "#2E7D32" : "#C62828",
            weight: "bold",
            wrap: true,
          },
        ],
      },
      hero: booking.roomDetails?.picture
        ? {
            type: "image",
            url: booking.roomDetails.picture,
            size: "full",
            aspectRatio: "16:9",
            aspectMode: "cover",
          }
        : undefined,
      body: {
        type: "box",
        layout: "vertical",
        spacing: "lg",
        paddingAll: "lg",
        contents: [
          {
            type: "text",
            text: booking.selectedRoom,
            weight: "bold",
            size: "lg",
            color: "#333333",
          },
          {
            type: "box",
            layout: "vertical",
            spacing: "md",
            contents: [
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  {
                    type: "text",
                    text: "🗓️",
                    size: "sm",
                    flex: 0,
                  },
                  {
                    type: "text",
                    text: `${formatThaiDate(booking.date)} \n${
                      booking.startTime
                    }-${booking.endTime} น.`,
                    size: "sm",
                    color: "#333333",
                    margin: "sm",
                    wrap: true,
                  },
                ],
              },
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  {
                    type: "text",
                    text: "📋",
                    size: "sm",
                    flex: 0,
                  },
                  {
                    type: "text",
                    text: booking.activity,
                    size: "sm",
                    color: "#333333",
                    margin: "sm",
                    wrap: true,
                  },
                ],
              },
            ],
          },
          {
            type: "separator",
            margin: "lg",
          },
          {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents: [
              {
                type: "text",
                text: "📝 สถานะการจอง",
                weight: "bold",
                size: "md",
                color: "#333333",
              },
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  {
                    type: "box",
                    layout: "vertical",
                    contents: [
                      {
                        type: "filler",
                      },
                      {
                        type: "box",
                        layout: "vertical",
                        contents: [],
                        width: "12px",
                        height: "12px",
                        backgroundColor: isApproved ? "#4CAF50" : "#F44336",
                        cornerRadius: "6px",
                      },
                      {
                        type: "filler",
                      },
                    ],
                    flex: 0,
                  },
                  {
                    type: "box",
                    layout: "vertical",
                    contents: [
                      {
                        type: "text",
                        text: isApproved ? "อนุมัติแล้ว" : "ปฏิเสธ",
                        size: "sm",
                        weight: "bold",
                        color: isApproved ? "#4CAF50" : "#F44336",
                      },
                      {
                        type: "text",
                        text: isApproved
                          ? "สามารถใช้ห้องประชุมได้ตามเวลาที่กำหนด"
                          : "การจองไม่ได้รับการอนุมัติ",
                        size: "xs",
                        color: "#666666",
                        wrap: true,
                      },
                    ],
                    margin: "sm",
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  };
}

// ✅ เพิ่ม route สำหรับจัดการ Admin Users
app.get("/admin/list", async (req, res) => {
  try {
    const admins = await getAdminUsers();
    res.json({ success: true, admins });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ เพิ่ม Admin ใหม่
app.post("/admin/add", async (req, res) => {
  const { lineUserId, name } = req.body;

  if (!lineUserId || !name) {
    return res.status(400).json({ error: "lineUserId and name are required" });
  }

  try {
    // ตรวจสอบว่า Admin นี้มีอยู่แล้วหรือไม่
    const existingAdmin = await db.collection("users").doc(lineUserId).get();

    if (existingAdmin.exists) {
      return res.status(400).json({ error: "Admin already exists" });
    }

    await db.collection("users").doc(lineUserId).set({
      lineUserId,
      name,
      role: "admin",
      isActive: true,
      createdAt: FieldValue.serverTimestamp(),
    });

    res.json({ success: true, message: "Admin added successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ ปิดการใช้งาน Admin (แทนที่จะลบ)
app.post("/admin/deactivate/:adminId", async (req, res) => {
  const { adminId } = req.params;

  try {
    await db.collection("users").doc(adminId).update({
      isActive: false,
      deactivatedAt: FieldValue.serverTimestamp(),
    });

    res.json({ success: true, message: "Admin deactivated successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ เปิดการใช้งาน Admin
app.post("/admin/activate/:adminId", async (req, res) => {
  const { adminId } = req.params;

  try {
    await db.collection("users").doc(adminId).update({
      isActive: true,
      activatedAt: FieldValue.serverTimestamp(),
    });

    res.json({ success: true, message: "Admin activated successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

exports.pushLineMessage = functions.https.onRequest(async (req, res) => {
  try {
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
    const rooms = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
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
    const allData = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    const totalItems = allData.length;
    const totalPages = Math.ceil(totalItems / limit);

    const paginatedData = allData.slice(start, start + limit);

    res.status(200).json({
      currentPage: page,
      totalPages,
      totalItems,
      data: paginatedData,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/getStatusNumber", async (req, res) => {
  try {
    const snapshot = await db.collection("bookingData").get();
    const allData = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    const statusCount = allData.reduce((acc, booking) => {
      acc[booking.status] = (acc[booking.status] || 0) + 1;
      return acc;
    }, {});

    // แปลง object เป็น array format ที่ต้องการ
    const formattedResult = Object.entries(statusCount).map(
      ([status, count]) => ({
        status,
        count,
      })
    );

    res.status(200).json(formattedResult);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/updateState/:docId", async (req, res) => {
  const docId = req.params.docId;
  const status = req.query.status;

  try {
    // อัปเดตสถานะใน Firestore
    await db.collection("bookingData").doc(docId).update({ status });

    // ดึงข้อมูล booking
    const doc = await db.collection("bookingData").doc(docId).get();
    if (!doc.exists) {
      return res.status(404).json({ error: "Document not found" });
    }

    const booking = doc.data();

    const {
      selectedRoom,
      date,
      startTime,
      endTime,
      booker,
      phone,
      activity,
      bookingId,
    } = booking;

    console.log(booking);

    // ส่ง LINE Flex
    const response = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LINE_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(lineMessage),
    });

    // ถ้า approved ให้สร้าง calendar event ด้วย
    if (status === "approved") {
      const event = await createCalendarEventFromBooking(booking);
      return res.status(200).json({
        success: true,
        calendarEventLink: event.htmlLink,
        calendarEventId: event.id,
      });
    } else {
      return res.status(200).json({
        success: true,
        redirectUrl: "https://booking-room-15abd.web.app/success",
      });
    }
  } catch (error) {
    console.error("❌ Error:", error);
    return res.status(500).json({ error: error.message });
  }
});

async function createCalendarEventFromBooking(booking) {
  try {
    console.log("📋 Booking data received:", booking);

    // 1. ตรวจสอบว่า booking.roomId มีข้อมูลหรือไม่
    let roomId = booking.roomId || booking.selectedRoom;

    if (!roomId) {
      throw new Error("❌ No roomId or selectedRoom found in booking data");
    }

    console.log(`🔍 Looking for room with ID: ${roomId}`);

    // 2. ดึงข้อมูลห้องจาก Firestore
    const roomRef = db.collection("rooms").doc(roomId);
    const roomSnap = await roomRef.get();

    if (!roomSnap.exists) {
      console.log(`❌ Room ${roomId} not found, trying to find by name...`);

      // ถ้าหาไม่เจอ ลองหาด้วย selectedRoom name
      const roomsQuery = await db
        .collection("rooms")
        .where("name", "==", booking.selectedRoom)
        .limit(1)
        .get();

      if (roomsQuery.empty) {
        throw new Error(
          `❌ Room '${booking.selectedRoom}' not found in Firestore`
        );
      }

      const roomDoc = roomsQuery.docs[0];
      roomId = roomDoc.id;
      const roomData = roomDoc.data();

      console.log(`✅ Found room by name: ${roomData.name} (ID: ${roomId})`);
    } else {
      console.log(`✅ Found room by ID: ${roomId}`);
    }

    // 3. ดึงข้อมูลห้อง
    const roomData = (await db.collection("rooms").doc(roomId).get()).data();

    if (!roomData.calendarId) {
      throw new Error(`❌ Room ${roomId} doesn't have calendarId configured`);
    }

    console.log(`📅 Using calendarId: ${roomData.calendarId}`);

    // 4. เตรียมข้อมูล event
    const event = {
      summary: `${booking.activity}`,
      description: [
        `ห้อง: ${roomData.name || "-"}`,
        `ผู้จอง: ${booking.booker || "-"}`,
        `เบอร์โทร: ${booking.phone || "-"}`,
      ].join("\n"),
      start: {
        dateTime: `${booking.date}T${booking.startTime}:00`,
        timeZone: "Asia/Bangkok",
      },
      end: {
        dateTime: `${booking.date}T${booking.endTime}:00`,
        timeZone: "Asia/Bangkok",
      },
      location: roomData.location || "",
      // เพิ่ม attendees ถ้ามีอีเมล
      ...(booking.email && {
        attendees: [
          {
            email: booking.email,
            displayName: booking.booker,
          },
        ],
      }),
    };

    console.log(`📅 Creating calendar event:`, {
      calendarId: roomData.calendarId,
      summary: event.summary,
      start: event.start,
      end: event.end,
    });

    // 5. เรียก Google Calendar API
    const calendar = google.calendar({ version: "v3", auth: oAuth2Client });
    const res = await calendar.events.insert({
      calendarId: roomData.calendarId,
      resource: event,
      sendUpdates: "all", // ส่งอีเมลแจ้งเตือนถ้ามี attendees
    });

    console.log(`✅ Calendar event created successfully:`, {
      eventId: res.data.id,
      htmlLink: res.data.htmlLink,
    });

    return res.data;
  } catch (error) {
    console.error("❌ Error creating calendar event:", error);
    throw error;
  }
}

// Function สร้าง Flex Message
function createDailyMeetingFlexMessage(meetings, date) {
  const thaiDate = formatThaiDate(date);

  // สร้าง contents สำหรับแต่ละการประชุม
  const meetingContents = meetings
    .map((meeting, index) => [
      ...(index > 0
        ? [
            {
              type: "separator",
              margin: "lg",
            },
          ]
        : []),
      {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        margin: "lg",
        contents: [
          {
            type: "box",
            layout: "horizontal",
            contents: [
              {
                type: "text",
                text: `🕐 ${meeting.startTime} - ${meeting.endTime}`,
                size: "sm",
                weight: "bold",
                color: "#1DB446",
                flex: 0,
              },
              {
                type: "text",
                text: meeting.selectedRoom,
                size: "sm",
                color: "#666666",
                align: "end",
              },
            ],
          },
          {
            type: "text",
            text: meeting.activity,
            size: "md",
            weight: "bold",
            wrap: true,
            margin: "xs",
          },
          {
            type: "text",
            text: `👤 ${meeting.booker}${
              meeting.attendees ? ` (${meeting.attendees} คน)` : ""
            }`,
            size: "xs",
            color: "#888888",
            margin: "xs",
          },
        ],
      },
    ])
    .flat();

  return {
    type: "flex",
    altText: `📅 การประชุมวันนี้ (${thaiDate})`,
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "horizontal",
        contents: [
          {
            type: "text",
            text: `📅 การประชุมวันนี้`,
            weight: "bold",
            color: "#FFFFFF",
            size: "md",
          },
        ],
        backgroundColor: "#1DB446",
        paddingAll: "lg",
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: thaiDate,
            size: "lg",
            weight: "bold",
            color: "#333333",
          },
          {
            type: "text",
            text: `📊 รวม ${meetings.length} การประชุม`,
            size: "sm",
            color: "#666666",
            margin: "sm",
          },
          ...meetingContents,
        ],
        paddingAll: "lg",
      },
      footer:
        meetings.length > 3
          ? {
              type: "box",
              layout: "vertical",
              contents: [
                {
                  type: "button",
                  action: {
                    type: "uri",
                    label: "ดูทั้งหมด",
                    uri: "https://calendar.google.com/calendar/embed?src=c_600107f59417995463751166cb7b61b85223dc775ef8ca920c077249a009267f@group.calendar.google.com&src=c_894fd9e2414ff541164b83e96314678ba6230f685fb8649545d4b9526778203c@group.calendar.google.com&ctz=Asia%2FBangkok",
                  },
                  style: "secondary",
                },
              ],
              paddingAll: "md",
            }
          : undefined,
    },
  };
}

// สร้าง collection สำหรับเก็บการตั้งค่า notification
async function saveNotificationSettings(groupId, groupName, settings) {
  try {
    await db
      .collection("lineGroups")
      .doc(groupId)
      .set({
        groupId: groupId,
        groupName: groupName,
        isActive: true,
        notificationSettings: {
          dailyMeetingNotification: settings.dailyMeetingNotification || true,
          reminderTime: settings.reminderTime || "08:00",
          reminderBeforeMeeting: settings.reminderBeforeMeeting || false,
          reminderMinutes: settings.reminderMinutes || 30,
        },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    console.log(
      `✅ Saved notification settings for group: ${groupName} (${groupId})`
    );
  } catch (error) {
    console.error("❌ Error saving notification settings:", error);
  }
}

// 2. ปรับปรุง webhook เพื่อ auto-register groups
app.post("/webhook", async (req, res) => {
  const events = req.body.events;

  for (const event of events) {
    console.log("📍 Event Type:", event.type);
    console.log("📍 Source Type:", event.source.type);

    if (event.source.type === "group") {
      const groupId = event.source.groupId;
      const groupName = event.source.groupName || "ไม่ระบุ";

      console.log("🎯 GROUP ID:", groupId);
      console.log("👥 Group Name:", groupName);

      // ตรวจสอบว่า group นี้เคยลงทะเบียนแล้วหรือไม่
      const groupDoc = await db.collection("lineGroups").doc(groupId).get();
      if (!groupDoc.exists) {
        // Auto-register group ใหม่
        await saveNotificationSettings(groupId, groupName, {
          dailyMeetingNotification: true,
        });
      }

      // จัดการคำสั่งต่างๆ
      if (event.type === "message" && event.message.type === "text") {
        await handleGroupCommand(event, groupId);
      }
    } else if (event.source.type === "user") {
      console.log("👤 USER ID:", event.source.userId);
    }
  }

  res.status(200).json({ status: "ok" });
});

// 3. จัดการคำสั่งใน GROUP
async function handleGroupCommand(event, groupId) {
  const message = event.message.text.toLowerCase().trim();
  const userId = event.source.userId;

  console.log(`📝 Group command received: "${message}" from group: ${groupId}`);

  try {
    // คำสั่งเปิด/ปิดการแจ้งเตือนรายวัน
    if (message === "เปิดการแจ้งเตือน" || message === "/enable") {
      await db.collection("lineGroups").doc(groupId).update({
        "notificationSettings.dailyMeetingNotification": true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await sendLineMessage(
        groupId,
        "✅ เปิดการแจ้งเตือนการประชุมประจำวันแล้ว"
      );
    } else if (message === "ปิดการแจ้งเตือน" || message === "/disable") {
      await db.collection("lineGroups").doc(groupId).update({
        "notificationSettings.dailyMeetingNotification": false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await sendLineMessage(groupId, "❌ ปิดการแจ้งเตือนการประชุมประจำวันแล้ว");
    }

    // ตั้งเวลาแจ้งเตือนรายวัน
    else if (message.startsWith("ตั้งเวลาแจ้งเตือน ")) {
      const timeMatch = message.match(/(\d{1,2}):(\d{2})/);
      if (timeMatch) {
        const hour = timeMatch[1].padStart(2, "0");
        const minute = timeMatch[2];
        const newTime = `${hour}:${minute}`;

        // Validate time format
        if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
          await db.collection("lineGroups").doc(groupId).update({
            "notificationSettings.reminderTime": newTime,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          await sendLineMessage(
            groupId,
            `⏰ ตั้งเวลาแจ้งเตือนประจำวันเป็น ${newTime} น. แล้ว`
          );
        } else {
          await sendLineMessage(
            groupId,
            "❌ เวลาไม่ถูกต้อง กรุณาใส่เวลาในรูปแบบ HH:MM (00:00 - 23:59)"
          );
        }
      } else {
        await sendLineMessage(
          groupId,
          "❌ รูปแบบเวลาไม่ถูกต้อง\nใช้รูปแบบ: ตั้งเวลาแจ้งเตือน 08:30"
        );
      }
    }

    // เปิด/ปิดการแจ้งเตือนก่อนประชุม
    else if (message === "เปิดแจ้งก่อนประชุม") {
      await db.collection("lineGroups").doc(groupId).update({
        "notificationSettings.reminderBeforeMeeting": true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await sendLineMessage(
        groupId,
        "🔔 เปิดการแจ้งเตือนก่อนประชุมแล้ว (ค่าเริ่มต้น: แจ้งก่อน 30 นาที)"
      );
    } else if (message === "ปิดแจ้งก่อนประชุม") {
      await db.collection("lineGroups").doc(groupId).update({
        "notificationSettings.reminderBeforeMeeting": false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await sendLineMessage(groupId, "🔕 ปิดการแจ้งเตือนก่อนประชุมแล้ว");
    }

    // ตั้งเวลาแจ้งเตือนก่อนประชุม (นาที)
    else if (message.startsWith("ตั้งแจ้งก่อนประชุม ")) {
      const minuteMatch = message.match(/(\d+)/);
      if (minuteMatch) {
        const minutes = parseInt(minuteMatch[1]);

        if (minutes >= 5 && minutes <= 120) {
          await db.collection("lineGroups").doc(groupId).update({
            "notificationSettings.reminderMinutes": minutes,
            "notificationSettings.reminderBeforeMeeting": true, // เปิดการแจ้งเตือนด้วยเลย
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          await sendLineMessage(
            groupId,
            `⏱️ ตั้งแจ้งเตือนก่อนประชุม ${minutes} นาที แล้ว\n🔔 และเปิดการแจ้งเตือนก่อนประชุมด้วย`
          );
        } else {
          await sendLineMessage(
            groupId,
            "❌ จำนวนนาทีต้องอยู่ระหว่าง 5-120 นาที\nตัวอย่าง: ตั้งแจ้งก่อนประชุม 30"
          );
        }
      } else {
        await sendLineMessage(
          groupId,
          "❌ รูปแบบไม่ถูกต้อง\nใช้รูปแบบ: ตั้งแจ้งก่อนประชุม 30\n(ใส่แค่ตัวเลขนาที ไม่ต้องใส่วงเล็บ)"
        );
      }
    }

    // ดูสถานะการแจ้งเตือน
    else if (message === "สถานะการแจ้งเตือน" || message === "/status") {
      const groupDoc = await db.collection("lineGroups").doc(groupId).get();
      const settings = groupDoc.data()?.notificationSettings || {};

      const statusMessage =
        `📊 สถานะการแจ้งเตือน\n\n` +
        `🔔 การแจ้งเตือนประจำวัน: ${
          settings.dailyMeetingNotification ? "✅ เปิด" : "❌ ปิด"
        }\n` +
        // `⏰ เวลาแจ้งเตือนประจำวัน: ${settings.reminderTime || "08:00"} น.\n` +
        `⏰ เวลาแจ้งเตือนประจำวัน: 08:00" น.\n` +
        `📱 แจ้งก่อนประชุม: ${
          settings.reminderBeforeMeeting ? "✅ เปิด" : "❌ ปิด"
        }\n` +
        `⏱️ แจ้งก่อนประชุม: ${settings.reminderMinutes || 30} นาที`;

      await sendLineMessage(groupId, statusMessage);
    }

    // ดูการประชุมวันนี้
    else if (message === "ดูการประชุมวันนี้" || message === "/today") {
      await sendTodayMeetings(groupId);
    }

    if (message === "ทดสอบแจ้งเตือนรายวัน" || message === "/test-daily") {
      await sendTodayMeetings(groupId);
      await sendLineMessage(groupId, "✅ ทดสอบการแจ้งเตือนรายวันเสร็จสิ้น");
    } else if (
      message === "ทดสอบแจ้งก่อนประชุม" ||
      message === "/test-before"
    ) {
      const now = new Date();
      const today = now.toISOString().split("T")[0];

      // หาการประชุมที่ใกล้ที่สุด
      const meetingsSnapshot = await db
        .collection("bookingData")
        .where("date", "==", today)
        .where("status", "==", "approved")
        .get();

      if (!meetingsSnapshot.empty) {
        const meetings = meetingsSnapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }));
        const nextMeeting = meetings.find((meeting) => {
          const meetingTime = new Date(
            `${meeting.date}T${meeting.startTime}:00+07:00`
          );
          return meetingTime > now;
        });

        if (nextMeeting) {
          const testMessage =
            `🔔 [ทดสอบ] แจ้งเตือนการประชุม\n\n` +
            `📅 วันที่: ${formatThaiDate(nextMeeting.date)}\n` +
            `⏰ เวลา: ${nextMeeting.startTime} - ${nextMeeting.endTime}\n` +
            `📍 ห้อง: ${nextMeeting.selectedRoom}\n` +
            `👤 ผู้จอง: ${nextMeeting.booker}\n` +
            `📝 หัวข้อ: ${nextMeeting.activity || "ไม่ระบุ"}\n\n` +
            `✅ นี่คือการทดสอบการแจ้งเตือนก่อนประชุม`;

          await sendLineMessage(groupId, testMessage);
        } else {
          await sendLineMessage(
            groupId,
            "📭 ไม่มีการประชุมที่จะมาถึงในวันนี้สำหรับทดสอบ"
          );
        }
      } else {
        await sendLineMessage(groupId, "📭 ไม่มีการประชุมในวันนี้สำหรับทดสอบ");
      }
    }

    // คำสั่งช่วยเหลือ
    else if (message === "คำสั่ง" || message === "/help") {
      const helpMessage =
        `📝 คำสั่งที่ใช้ได้:\n\n` +
        // `📅 การแจ้งเตือนประจำวัน:\n` +
        // `• เปิดการแจ้งเตือน\n` +
        // `• ปิดการแจ้งเตือน\n` +
        // `• ตั้งเวลาแจ้งเตือน 08:30\n\n` +
        `🔔 การแจ้งเตือนก่อนประชุม:\n` +
        `• เปิดแจ้งก่อนประชุม\n` +
        `• ปิดแจ้งก่อนประชุม\n` +
        `• ตั้งแจ้งก่อนประชุม 45\n\n` +
        `📊 อื่นๆ:\n` +
        `• สถานะการแจ้งเตือน\n` +
        `• ดูการประชุมวันนี้\n` +
        `• คำสั่ง`
        // `🧪 ทดสอบระบบ:\n` +
        // `• ทดสอบแจ้งเตือนรายวัน\n` +
        // `• ทดสอบแจ้งก่อนประชุม`
        ;

      await sendLineMessage(groupId, helpMessage);
    }

    // ถ้าไม่ตรงคำสั่งไหน
    else {
      console.log(`❓ Unknown command: ${message}`);
      // ไม่ต้องตอบอะไร เพื่อไม่ให้รบกวนการสนทนาปกติ
      // หรือถ้าอยากให้ตอบ ก็ uncomment บรรทัดล่าง
      // await sendLineMessage(groupId, "❓ ไม่เข้าใจคำสั่ง พิมพ์ 'คำสั่ง' เพื่อดูคำสั่งที่ใช้ได้");
    }
  } catch (error) {
    console.error("❌ Error handling group command:", error);
    await sendLineMessage(
      groupId,
      "❌ เกิดข้อผิดพลาดในการดำเนินการ กรุณาลองใหม่อีกครั้ง"
    );
  }
}

// ===== 6. API เพิ่มเติมสำหรับ Debug =====
app.get("/api/notification-logs", async (req, res) => {
  try {
    const { date, groupId } = req.query;

    let query = db.collection("notificationLogs");

    if (date) {
      query = query.where("date", "==", date);
    }
    if (groupId) {
      query = query.where("groupId", "==", groupId);
    }

    const snapshot = await query.orderBy("sentAt", "desc").limit(50).get();
    const logs = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    res.json({ success: true, logs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/notification-logs", async (req, res) => {
  try {
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({ error: "Date parameter is required" });
    }

    const snapshot = await db
      .collection("notificationLogs")
      .where("date", "==", date)
      .get();

    const batch = db.batch();
    snapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });

    await batch.commit();

    res.json({
      success: true,
      message: `Deleted ${snapshot.size} notification logs for date: ${date}`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

exports.dailyMeetingNotification = onSchedule(
  {
    schedule: "0 8 * * *", // 8:00 ทุกวัน (เป็น fallback สำหรับกลุ่มที่ไม่ได้ตั้งเวลา)
    timeZone: "Asia/Bangkok",
  },
  async (event) => {
    console.log("🔔 Running fallback daily meeting notification at 8:00 AM...");

    try {
      // ส่งเฉพาะ groups ที่ใช้เวลา default (08:00) และยังไม่ได้ส่ง
      const groupsSnapshot = await db
        .collection("lineGroups")
        .where("isActive", "==", true)
        .where("notificationSettings.dailyMeetingNotification", "==", true)
        .where("notificationSettings.reminderTime", "==", "08:00")
        .get();

      if (groupsSnapshot.empty) {
        console.log("📭 No groups using default 8:00 AM time");
        return;
      }

      const today = new Date().toISOString().split("T")[0];

      // ดึงข้อมูลการประชุมวันนี้
      const meetingsSnapshot = await db
        .collection("bookingData")
        .where("date", "==", today)
        .where("status", "==", "approved")
        .get();

      const meetings = meetingsSnapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));
      meetings.sort((a, b) => a.startTime.localeCompare(b.startTime));

      // ส่งไปยังทุก groups ที่ยังไม่ได้ส่ง
      for (const groupDoc of groupsSnapshot.docs) {
        const groupData = groupDoc.data();
        const groupId = groupData.groupId;

        // ตรวจสอบว่าส่งไปแล้ววันนี้หรือยัง
        const notificationLogDoc = await db
          .collection("notificationLogs")
          .doc(`${groupId}_${today}_daily`)
          .get();

        if (!notificationLogDoc.exists) {
          try {
            if (meetings.length > 0) {
              const flexMessage = createDailyMeetingFlexMessage(
                meetings,
                today
              );
              await sendLineMessage(groupId, flexMessage);
            } else {
              await sendLineMessage(
                groupId,
                "📭 วันนี้ไม่มีการประชุมที่จองไว้"
              );
            }

            // บันทึกว่าส่งแล้ว
            await db
              .collection("notificationLogs")
              .doc(`${groupId}_${today}_daily`)
              .set({
                groupId: groupId,
                date: today,
                type: "daily_fallback",
                sentAt: admin.firestore.FieldValue.serverTimestamp(),
              });

            console.log(
              `✅ Fallback notification sent to group: ${groupData.groupName}`
            );
          } catch (error) {
            console.error(
              `❌ Failed to send fallback notification to group ${groupId}:`,
              error
            );
          }
        }
      }
    } catch (error) {
      console.error("❌ Error sending fallback daily notification:", error);
    }
  }
);

// ใช้วิธีการตรวจสอบทุก 30 นาที แล้วเช็คว่าถึงเวลาส่งหรือยัง
exports.checkDailyNotifications = onSchedule(
  {
    schedule: "*/30 * * * *", // ทุก 30 นาที
    timeZone: "Asia/Bangkok",
  },
  async (event) => {
    console.log("🔍 Checking for daily notifications...");

    try {
      const now = new Date();
      const bangkokTime = new Date(
        now.toLocaleString("en-US", { timeZone: "Asia/Bangkok" })
      );
      const currentHour = bangkokTime.getHours();
      const currentMinute = now.getMinutes();
      const currentTime = `${currentHour
        .toString()
        .padStart(2, "0")}:${currentMinute.toString().padStart(2, "0")}`;

      console.log(`⏰ Current time: ${currentTime}`);

      // ดึง groups ที่ active และเปิดการแจ้งเตือน
      const groupsSnapshot = await db
        .collection("lineGroups")
        .where("isActive", "==", true)
        .where("notificationSettings.dailyMeetingNotification", "==", true)
        .get();

      if (groupsSnapshot.empty) {
        console.log("📭 No active groups for notification");
        return;
      }

      const today = new Date().toISOString().split("T")[0];

      // ดึงข้อมูลการประชุมวันนี้
      const meetingsSnapshot = await db
        .collection("bookingData")
        .where("date", "==", today)
        .where("status", "==", "approved")
        .get();

      const meetings = meetingsSnapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));
      meetings.sort((a, b) => a.startTime.localeCompare(b.startTime));

      // ตรวจสอบแต่ละ group ว่าถึงเวลาส่งหรือยัง
      for (const groupDoc of groupsSnapshot.docs) {
        const groupData = groupDoc.data();
        const groupId = groupData.groupId;
        const reminderTime =
          groupData.notificationSettings?.reminderTime || "08:00";

        // เช็คว่าเวลาปัจจุบันตรงกับเวลาที่ตั้งไว้หรือไม่ (ให้ความคลาดเคลื่อน ±15 นาที)
        const [reminderHour, reminderMinute] = reminderTime
          .split(":")
          .map(Number);
        const timeDifferenceMinutes = Math.abs(
          currentHour * 60 +
            currentMinute -
            (reminderHour * 60 + reminderMinute)
        );

        if (timeDifferenceMinutes <= 15) {
          // ถ้าห่างไม่เกิน 15 นาที
          console.log(
            `📤 Sending daily notification to group: ${groupData.groupName} at ${currentTime}`
          );

          try {
            // ตรวจสอบว่าส่งไปแล้ววันนี้หรือยัง
            const notificationLogDoc = await db
              .collection("notificationLogs")
              .doc(`${groupId}_${today}_daily`)
              .get();

            if (!notificationLogDoc.exists) {
              // ยังไม่เคยส่งวันนี้ ให้ส่งเลย
              if (meetings.length > 0) {
                const flexMessage = createDailyMeetingFlexMessage(
                  meetings,
                  today
                );
                await sendLineMessage(groupId, flexMessage);
              } else {
                await sendLineMessage(
                  groupId,
                  "📭 วันนี้ไม่มีการประชุมที่จองไว้"
                );
              }

              // บันทึกว่าส่งแล้ว
              await db
                .collection("notificationLogs")
                .doc(`${groupId}_${today}_daily`)
                .set({
                  groupId: groupId,
                  date: today,
                  type: "daily",
                  sentAt: admin.firestore.FieldValue.serverTimestamp(),
                });

              console.log(
                `✅ Daily notification sent to group: ${groupData.groupName}`
              );
            } else {
              console.log(
                `⏭️ Daily notification already sent to group: ${groupData.groupName}`
              );
            }
          } catch (error) {
            console.error(
              `❌ Failed to send daily notification to group ${groupId}:`,
              error
            );
          }
        }
      }
    } catch (error) {
      console.error("❌ Error checking daily notifications:", error);
    }
  }
);

// ===== 2. เพิ่ม Before Meeting Notification Function =====
exports.checkBeforeMeetingNotifications = onSchedule(
  {
    schedule: "*/5 * * * *", // ทุก 5 นาที
    timeZone: "Asia/Bangkok",
  },
  async (event) => {
    console.log("🔔 Checking for before-meeting notifications...");

    try {
      const now = new Date();
      const today = now.toISOString().split("T")[0];

      // ดึง groups ที่เปิดการแจ้งเตือนก่อนประชุม
      const groupsSnapshot = await db
        .collection("lineGroups")
        .where("isActive", "==", true)
        .where("notificationSettings.reminderBeforeMeeting", "==", true)
        .get();

      if (groupsSnapshot.empty) {
        console.log("📭 No active groups for before-meeting notification");
        return;
      }

      // ดึงการประชุมของวันนี้
      const meetingsSnapshot = await db
        .collection("bookingData")
        .where("date", "==", today)
        .where("status", "==", "approved")
        .get();

      if (meetingsSnapshot.empty) {
        console.log("📭 No meetings today for before-meeting notification");
        return;
      }

      const meetings = meetingsSnapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));

      // ตรวจสอบแต่ละ group
      for (const groupDoc of groupsSnapshot.docs) {
        const groupData = groupDoc.data();
        const groupId = groupData.groupId;
        const reminderMinutes =
          groupData.notificationSettings?.reminderMinutes || 30;

        // ตรวจสอบแต่ละการประชุม
        for (const meeting of meetings) {
          const meetingDateTime = new Date(
            `${meeting.date}T${meeting.startTime}:00+07:00`
          );
          const timeDifference = meetingDateTime.getTime() - now.getTime();
          const minutesUntilMeeting = Math.floor(timeDifference / (1000 * 60));

          // ถ้าใกล้เวลาประชุมตามที่ตั้งไว้ (ให้ความคลาดเคลื่อน ±2 นาที)
          if (Math.abs(minutesUntilMeeting - reminderMinutes) <= 2) {
            const notificationId = `${groupId}_${meeting.id}_before`;
            const notificationLogDoc = await db
              .collection("notificationLogs")
              .doc(notificationId)
              .get();

            if (!notificationLogDoc.exists) {
              console.log(
                `⏰ Sending before-meeting notification for: ${meeting.title}`
              );

              try {
                const message =
                  `🔔 แจ้งเตือนการประชุม\n\n` +
                  `📅 วันที่: ${formatThaiDate(meeting.date)}\n` +
                  `⏰ เวลา: ${meeting.startTime} - ${meeting.endTime}\n` +
                  `📍 ห้อง: ${meeting.selectedRoom}\n` +
                  `👤 ผู้จอง: ${meeting.booker}\n` +
                  `📝 หัวข้อ: ${meeting.activity || "ไม่ระบุ"}\n\n` +
                  `🚨 การประชุมจะเริ่มในอีก ${minutesUntilMeeting} นาที`;

                await sendLineMessage(groupId, message);

                // บันทึกว่าส่งแล้ว
                await db
                  .collection("notificationLogs")
                  .doc(notificationId)
                  .set({
                    groupId: groupId,
                    meetingId: meeting.id,
                    type: "before_meeting",
                    sentAt: admin.firestore.FieldValue.serverTimestamp(),
                    minutesBeforeMeeting: minutesUntilMeeting,
                  });

                console.log(
                  `✅ Before-meeting notification sent to group: ${groupData.groupName}`
                );
              } catch (error) {
                console.error(
                  `❌ Failed to send before-meeting notification:`,
                  error
                );
              }
            }
          }
        }
      }
    } catch (error) {
      console.error("❌ Error checking before-meeting notifications:", error);
    }
  }
);

async function sendLineMessage(to, messageData) {
  try {
    let messages = [];

    // ถ้าส่ง string มาใช้เป็น text message
    if (typeof messageData === "string" && messageData.trim() !== "") {
      messages.push({ type: "text", text: messageData });
    }
    // ถ้าส่ง object มาและมี type ใช้เป็น message object
    else if (typeof messageData === "object" && messageData.type) {
      messages.push(messageData);
    }
    // ถ้าส่ง array มาใช้เป็น messages array
    else if (Array.isArray(messageData)) {
      messages = messageData;
    }
    // ถ้าเป็น object ที่มี text และ flex
    else if (
      typeof messageData === "object" &&
      (messageData.text || messageData.flexMessage)
    ) {
      if (messageData.text && messageData.text.trim() !== "") {
        messages.push({ type: "text", text: messageData.text });
      }
      if (messageData.flexMessage) {
        messages.push(messageData.flexMessage);
      }
    }
    // สำหรับรูปแบบเก่าที่ส่ง 3 พารามิเตอร์ (to, text, flexMessage)
    else if (arguments.length === 3) {
      const text = arguments[1];
      const flexMessage = arguments[2];

      if (typeof text === "string" && text.trim() !== "") {
        messages.push({ type: "text", text: text });
      }
      if (flexMessage) {
        messages.push(flexMessage);
      }
    }

    if (messages.length === 0) {
      throw new Error("No valid message content to send");
    }

    const response = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LINE_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        to: to,
        messages: messages,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("LINE API error:", errorText);
      throw new Error(`LINE API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    console.log("✅ LINE message sent successfully to:", to);
    return result;
  } catch (error) {
    console.error("❌ Error sending LINE message:", error);
    throw error;
  }
}

// Function เฉพาะสำหรับส่ง text message อย่างเดียว
async function sendTextMessage(to, text) {
  return await sendLineMessage(to, text);
}

// Function เฉพาะสำหรับส่ง flex message อย่างเดียว
async function sendFlexMessage(to, flexMessage) {
  return await sendLineMessage(to, flexMessage);
}

// Function สำหรับส่งทั้ง text และ flex message
async function sendMixedMessage(to, text, flexMessage) {
  return await sendLineMessage(to, { text, flexMessage });
}

// 6. ฟังก์ชันส่งการประชุมวันนี้
async function sendTodayMeetings(groupId) {
  try {
    const today = new Date().toISOString().split("T")[0];

    const snapshot = await db
      .collection("bookingData")
      .where("date", "==", today)
      .where("status", "==", "approved")
      .get();

    if (snapshot.empty) {
      await sendLineMessage(groupId, "📭 วันนี้ไม่มีการประชุมที่จองไว้");
      return;
    }

    const meetings = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    meetings.sort((a, b) => a.startTime.localeCompare(b.startTime));

    const flexMessage = createDailyMeetingFlexMessage(meetings, today);
    await sendLineMessage(groupId, flexMessage);
  } catch (error) {
    console.error("❌ Error sending today meetings:", error);
    await sendLineMessage(groupId, "❌ เกิดข้อผิดพลาดในการดึงข้อมูลการประชุม");
  }
}

// 7. API สำหรับจัดการ groups (สำหรับ admin)
app.get("/api/line-groups", async (req, res) => {
  try {
    const snapshot = await db.collection("lineGroups").get();
    const groups = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    res.json({ success: true, groups });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/line-groups/:groupId", async (req, res) => {
  try {
    const { groupId } = req.params;
    const updates = req.body;

    await db
      .collection("lineGroups")
      .doc(groupId)
      .update({
        ...updates,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    res.json({ success: true, message: "Group settings updated" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 8. Test endpoint ที่ส่งไปทุก active groups
app.get("/test-daily-notification-all-groups", async (req, res) => {
  try {
    const groupsSnapshot = await db
      .collection("lineGroups")
      .where("isActive", "==", true)
      .where("notificationSettings.dailyMeetingNotification", "==", true)
      .get();

    if (groupsSnapshot.empty) {
      return res.json({ message: "No active groups", groups: 0 });
    }

    const today = new Date().toISOString().split("T")[0];

    const meetingsSnapshot = await db
      .collection("bookingData")
      .where("date", "==", today)
      .where("status", "==", "approved")
      .get();

    const meetings = meetingsSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    meetings.sort((a, b) => a.startTime.localeCompare(b.startTime));

    const results = [];

    for (const groupDoc of groupsSnapshot.docs) {
      const groupData = groupDoc.data();
      const groupId = groupData.groupId;

      try {
        if (meetings.length > 0) {
          const flexMessage = createDailyMeetingFlexMessage(meetings, today);
          await sendLineMessage(groupId, flexMessage);
        } else {
          await sendLineMessage(groupId, "📭 วันนี้ไม่มีการประชุมที่จองไว้");
        }

        results.push({
          groupId,
          groupName: groupData.groupName,
          status: "success",
        });
      } catch (error) {
        results.push({
          groupId,
          groupName: groupData.groupName,
          status: "error",
          error: error.message,
        });
      }
    }

    res.json({
      success: true,
      totalGroups: groupsSnapshot.size,
      meetings: meetings.length,
      results,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== เพิ่ม API สำหรับทดสอบคำสั่ง =====
app.post("/test-group-command", async (req, res) => {
  try {
    const { groupId, command } = req.body;

    // สร้าง mock event สำหรับทดสอบ
    const mockEvent = {
      type: "message",
      message: {
        type: "text",
        text: command,
      },
      source: {
        type: "group",
        groupId: groupId,
      },
    };

    await handleGroupCommand(mockEvent, groupId);

    res.json({
      success: true,
      message: `Command "${command}" processed successfully`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Debug ฟังก์ชันเพื่อดูข้อมูล Group =====
app.get("/debug/group/:groupId", async (req, res) => {
  try {
    const { groupId } = req.params;

    const groupDoc = await db.collection("lineGroups").doc(groupId).get();

    if (!groupDoc.exists) {
      return res.json({
        exists: false,
        message: "Group not found in database",
      });
    }

    const groupData = groupDoc.data();

    res.json({
      exists: true,
      groupData: groupData,
      settings: groupData.notificationSettings || {},
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/checkUserId/:lineUserId", async (req, res) => {
  const lineUserId = req.params.lineUserId;
  try {
    const user = await db.collection("users").doc(lineUserId).get();

    if (!user.data() || user.data().role !== "admin") {
      console.log(`User with ID ${lineUserId} not found.`);
      return res.status(404).json({ error: "User not found" });
    }

    res.status(200).json("User found");
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/getUserData/:userId', async (req, res) => {
  const userId = req.params.userId;

  try {
    const userDoc = await db.collection('users').doc(userId).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    return res.status(200).json(userData);

  } catch (error) {
    console.error('Error getting user data:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});


exports.app = onRequest({ cors: true }, app);
