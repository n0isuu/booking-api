const express = require("express");
const fetch = require("node-fetch");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const serviceAccount = require("./config/serviceAccountKey.json");
const { google } = require("googleapis");
const authorize = require("./auth");
const { FieldValue } = require("firebase-admin/firestore");

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
    specialRequests,
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
    });

    console.log("📄 Booking data saved with ID:", docRef.id);

    // 2️⃣ ส่งข้อความไปยัง LINE
    // const lineMessage = {
    //   to: "U2698869fcd7379f81181c2fdc0b961eb",
    //   messages: [
    //     {
    //       type: "flex",
    //       altText: "การจองห้องประชุมสำเร็จ",
    //       contents: {
    //         type: "bubble",
    //         header: {
    //           type: "box",
    //           layout: "vertical",
    //           contents: [
    //             {
    //               type: "text",
    //               text: "✅ จองห้องประชุมสำเร็จ",
    //               weight: "bold",
    //               size: "lg",
    //               color: "#1DB446",
    //             },
    //           ],
    //         },
    //         hero: {
    //           type: "image",
    //           url: `${selectedRoom.picture}`,
    //           size: "full",
    //           aspectRatio: "16:9",
    //           aspectMode: "cover",
    //         },
    //         body: {
    //           type: "box",
    //           layout: "vertical",
    //           spacing: "md",
    //           contents: [
    //             {
    //               type: "text",
    //               text: `ห้อง: ${selectedRoom.name}`,
    //               weight: "bold",
    //               size: "md",
    //             },
    //             {
    //               type: "box",
    //               layout: "baseline",
    //               contents: [
    //                 {
    //                   type: "text",
    //                   text: "วันที่:",
    //                   weight: "bold",
    //                   size: "sm",
    //                   flex: 1,
    //                 },
    //                 {
    //                   type: "text",
    //                   text: `${date}`,
    //                   size: "sm",
    //                   flex: 3,
    //                 },
    //               ],
    //             },
    //             {
    //               type: "text",
    //               text: `ผู้จอง: ${booker} (${phone})`,
    //               size: "sm",
    //               wrap: true,
    //             },
    //             {
    //               type: "text",
    //               text: `กิจกรรม: ${activity}`,
    //               size: "sm",
    //               wrap: true,
    //             },
    //             {
    //               type: "text",
    //               text: `จำนวนผู้เข้าร่วม: ${attendees}`,
    //               size: "sm",
    //             },
    //             {
    //               type: "text",
    //               text: `คำขอพิเศษ: ${specialRequests}`,
    //               size: "sm",
    //               wrap: true,
    //             },
    //             {
    //               type: "text",
    //               text: `สถานะ: ${status}`,
    //               size: "sm",
    //               color: "#888888",
    //             },
    //           ],
    //         },
    //         footer: {
    //           type: "box",
    //           layout: "horizontal",
    //           contents: [
    //             {
    //               type: "button",
    //               action: {
    //                 type: "uri",
    //                 label: "ยกเลิกการจอง",
    //                 uri: `https://us-central1-booking-room-backend.cloudfunctions.net/app/updateState/${docRef.id}?status=rejected`,
    //               },
    //               style: "primary",
    //             },
    //           ],
    //         },
    //       },
    //     },
    //   ],
    // };
    const lineMessage = {
      to: "U2698869fcd7379f81181c2fdc0b961eb",
      messages: [
        {
          type: "flex",
          altText: "การจองห้องประชุมสำเร็จ",
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
                  text: "✅",
                  size: "lg",
                  flex: 0,
                },
                {
                  type: "text",
                  text: "จองห้องประชุมสำเร็จ",
                  weight: "bold",
                  size: "md",
                  color: "#2E7D32",
                  flex: 1,
                  margin: "sm",
                },
              ],
            },
            hero: {
              type: "image",
              url: `${selectedRoom.picture}`,
              size: "full",
              aspectRatio: "16:9",
              aspectMode: "cover",
            },
            body: {
              type: "box",
              layout: "vertical",
              spacing: "lg",
              paddingAll: "lg",
              contents: [
                {
                  type: "text",
                  text: `${selectedRoom.name}`,
                  weight: "bold",
                  size: "xl",
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
                          text: "📅",
                          size: "md",
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
                              size: "sm",
                              color: "#888888",
                            },
                            {
                              type: "text",
                              text: `${date}`,
                              size: "md",
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
                          text: "🕐",
                          size: "md",
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
                              size: "sm",
                              color: "#888888",
                            },
                            {
                              type: "text",
                              text: "13:00 - 14:00 น.",
                              size: "md",
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
                          text: "👤",
                          size: "md",
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
                              size: "sm",
                              color: "#888888",
                            },
                            {
                              type: "text",
                              text: `${booker}`,
                              size: "md",
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
                          text: "💬",
                          size: "md",
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
                              text: "กิจกรรม/หัวข้อการประชุม",
                              size: "sm",
                              color: "#888888",
                            },
                            {
                              type: "text",
                              text: `${activity}`,
                              size: "md",
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
                  spacing: "md",
                  contents: [
                    {
                      type: "text",
                      text: "สถานะการจอง",
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
                                      width: "10px",
                                      height: "10px",
                                      backgroundColor: "#1DB446",
                                      cornerRadius: "5px",
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
                                      text: "25 ก.ค. 2568 11:37 น.",
                                      size: "xs",
                                      color: "#888888",
                                    },
                                    {
                                      type: "text",
                                      text: "ส่งคำขอจองสำเร็จ",
                                      size: "sm",
                                      weight: "bold",
                                      color: "#333333",
                                    },
                                  ],
                                  margin: "sm",
                                },
                              ],
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
                                      type: "box",
                                      layout: "vertical",
                                      contents: [],
                                      width: "1px",
                                      height: "20px",
                                      backgroundColor: "#DDDDDD",
                                    },
                                  ],
                                  flex: 0,
                                  alignItems: "center",
                                },
                              ],
                              margin: "none",
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
                                      width: "10px",
                                      height: "10px",
                                      backgroundColor: "#FFC107",
                                      cornerRadius: "5px",
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
                                      text: "รอดำเนินการ",
                                      size: "xs",
                                      color: "#888888",
                                    },
                                    {
                                      type: "text",
                                      text: "รอการอนุมัติจากผู้แลระบบ",
                                      size: "sm",
                                      weight: "bold",
                                      color: "#333333",
                                    },
                                  ],
                                  margin: "sm",
                                },
                              ],
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
                                      type: "box",
                                      layout: "vertical",
                                      contents: [],
                                      width: "1px",
                                      height: "20px",
                                      backgroundColor: "#DDDDDD",
                                    },
                                  ],
                                  flex: 0,
                                  alignItems: "center",
                                },
                              ],
                              margin: "none",
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
                                      width: "10px",
                                      height: "10px",
                                      backgroundColor: "#DDDDDD",
                                      cornerRadius: "5px",
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
                                      text: "รอดำเนินการ",
                                      size: "xs",
                                      color: "#CCCCCC",
                                    },
                                    {
                                      type: "text",
                                      text: "อนุมัติการจอง",
                                      size: "sm",
                                      color: "#CCCCCC",
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
                  ],
                },
              ],
            },
            footer: {
              type: "box",
              layout: "horizontal",
              spacing: "md",
              paddingAll: "lg",
              contents: [
                {
                  type: "button",
                  action: {
                    type: "uri",
                    label: "ยกเลิกการจอง",
                    uri: `https://us-central1-booking-room-backend.cloudfunctions.net/app/updateState/${docRef.id}?status=rejected`,
                  },
                  style: "secondary",
                  color: "#888888",
                },
              ],
            },
            styles: {
              footer: {
                backgroundColor: "#FFFFFF",
              },
            },
          },
        },
      ],
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

    // สร้าง Flex Message (แสดงรายละเอียดแบบภาพ)
    // const lineMessage = {
    //   to: "U2698869fcd7379f81181c2fdc0b961eb", // ควรเก็บ userId ไว้ใน booking
    //   messages: [
    //     {
    //       type: "flex",
    //       altText:
    //         status === "approved"
    //           ? "การจองห้องประชุมได้รับการอนุมัติแล้ว"
    //           : "การจองห้องถูกปฏิเสธ",
    //       contents: {
    //         type: "bubble",
    //         size: "kilo",
    //         header: {
    //           type: "box",
    //           layout: "horizontal",
    //           contents: [
    //             {
    //               type: "text",
    //               text:
    //                 status === "approved"
    //                   ? "✅ การจองห้องประชุมได้รับการอนุมัติแล้ว"
    //                   : "❌ การจองถูกปฏิเสธ",
    //               wrap: true,
    //               weight: "bold",
    //               color: status === "approved" ? "#1DB446" : "#FF3B30",
    //               size: "sm",
    //             },
    //           ],
    //           paddingAll: "md",
    //           backgroundColor: status === "approved" ? "#E6F5EA" : "#FDEBEC",
    //         },
    //         hero: selectedRoom?.picture
    //           ? {
    //               type: "image",
    //               url: selectedRoom.picture,
    //               size: "full",
    //               aspectRatio: "16:9",
    //               aspectMode: "cover",
    //             }
    //           : undefined,
    //         body: {
    //           type: "box",
    //           layout: "vertical",
    //           contents: [
    //             {
    //               type: "text",
    //               text: `ห้อง${selectedRoom || "-"}`,
    //               weight: "bold",
    //               size: "xl",
    //               margin: "md",
    //             },
    //             {
    //               type: "box",
    //               layout: "vertical",
    //               margin: "lg",
    //               spacing: "sm",
    //               contents: [
    //                 {
    //                   type: "box",
    //                   layout: "baseline",
    //                   contents: [
    //                     {
    //                       type: "text",
    //                       text: "วันที่:",
    //                       size: "sm",
    //                       weight: "bold",
    //                       flex: 1,
    //                     },
    //                     {
    //                       type: "text",
    //                       text: `${date}`,
    //                       size: "sm",
    //                       flex: 3,
    //                     },
    //                   ],
    //                 },
    //                 {
    //                   type: "box",
    //                   layout: "baseline",
    //                   contents: [
    //                     {
    //                       type: "text",
    //                       text: "เวลา:",
    //                       size: "sm",
    //                       weight: "bold",
    //                       flex: 1,
    //                     },
    //                     {
    //                       type: "text",
    //                       text: `${startTime} - ${endTime}`,
    //                       size: "sm",
    //                       flex: 3,
    //                     },
    //                   ],
    //                 },
    //                 {
    //                   type: "box",
    //                   layout: "baseline",
    //                   contents: [
    //                     {
    //                       type: "text",
    //                       text: "ผู้จอง:",
    //                       size: "sm",
    //                       weight: "bold",
    //                       flex: 1,
    //                     },
    //                     {
    //                       type: "text",
    //                       text: `${booker} (${phone})`,
    //                       size: "sm",
    //                       flex: 3,
    //                     },
    //                   ],
    //                 },
    //                 {
    //                   type: "box",
    //                   layout: "baseline",
    //                   contents: [
    //                     {
    //                       type: "text",
    //                       text: "กิจกรรม:",
    //                       size: "sm",
    //                       weight: "bold",
    //                       flex: 1,
    //                     },
    //                     {
    //                       type: "text",
    //                       text: `${activity}`,
    //                       size: "sm",
    //                       flex: 3,
    //                     },
    //                   ],
    //                 },
    //               ],
    //             },
    //           ],
    //         },
    //       },
    //     },
    //   ],
    // };

    // const lineMessage = {
    //   to: "U2698869fcd7379f81181c2fdc0b961eb", // ควรเก็บ userId ไว้ใน booking
    //   messages: [
    //     {
    //       type: "flex",
    //       altText:
    //         status === "approved"
    //           ? "การจองห้องประชุมได้รับการอนุมัติแล้ว"
    //           : "การจองห้องไม่ได้รับการอนุมัติ",
    //       contents: {
    //         type: "bubble",
    //         size: "kilo",
    //         header: {
    //           type: "box",
    //           layout: "horizontal",
    //           contents: [
    //             {
    //               type: "text",
    //               text:
    //                 status === "approved"
    //                   ? "✓ การจองได้รับการอนุมัติแล้ว"
    //                   : "✘ การจองห้องไม่ได้รับการอนุมัติ",
    //               wrap: true,
    //               weight: "bold",
    //               color: status === "approved" ? "#1DB446" : "#FF3B30",
    //               size: "sm",
    //             },
    //           ],
    //           paddingAll: "md",
    //           backgroundColor: status === "approved" ? "#E6F5EA" : "#FDEBEC",
    //         },
    //         hero: selectedRoom?.picture
    //           ? {
    //               type: "image",
    //               url: selectedRoom.picture,
    //               size: "full",
    //               aspectRatio: "16:9",
    //               aspectMode: "cover",
    //             }
    //           : undefined,
    //         body: {
    //           type: "box",
    //           layout: "vertical",
    //           contents: [
    //             {
    //               type: "text",
    //               text: `ห้อง ${selectedRoom || "-"}`,
    //               weight: "bold",
    //               size: "xl",
    //               margin: "md",
    //             },
    //             {
    //               type: "box",
    //               layout: "vertical",
    //               margin: "lg",
    //               spacing: "sm",
    //               contents: [
    //                 {
    //                   type: "box",
    //                   layout: "baseline",
    //                   contents: [
    //                     {
    //                       type: "text",
    //                       text: "วันที่: ",
    //                       size: "sm",
    //                       weight: "bold",
    //                       flex: 1,
    //                     },
    //                     {
    //                       type: "text",
    //                       text: `${date}`,
    //                       size: "sm",
    //                       flex: 3,
    //                     },
    //                   ],
    //                 },
    //                 {
    //                   type: "box",
    //                   layout: "baseline",
    //                   contents: [
    //                     {
    //                       type: "text",
    //                       text: "เวลา: ",
    //                       size: "sm",
    //                       weight: "bold",
    //                       flex: 1,
    //                     },
    //                     {
    //                       type: "text",
    //                       text: `${startTime} - ${endTime} น.`,
    //                       size: "sm",
    //                       flex: 3,
    //                     },
    //                   ],
    //                 },
    //                 {
    //                   type: "box",
    //                   layout: "baseline",
    //                   contents: [
    //                     {
    //                       type: "text",
    //                       text: "ผู้จอง:",
    //                       size: "sm",
    //                       weight: "bold",
    //                       flex: 1,
    //                     },
    //                     {
    //                       type: "text",
    //                       text: `${booker} (${phone})`,
    //                       size: "sm",
    //                       flex: 3,
    //                     },
    //                   ],
    //                 },
    //                 {
    //                   type: "box",
    //                   layout: "baseline",
    //                   contents: [
    //                     {
    //                       type: "text",
    //                       text: "กิจกรรม:",
    //                       size: "sm",
    //                       weight: "bold",
    //                       flex: 1,
    //                     },
    //                     {
    //                       type: "text",
    //                       text: `${activity}`,
    //                       size: "sm",
    //                       flex: 3,
    //                     },
    //                   ],
    //                 },
    //               ],
    //             },
    //           ],
    //         },
    //         footer: {
    //           type: "box",
    //           layout: "vertical",
    //           contents: [
    //             {
    //               type: "text",
    //               text:
    //                 status === "approved"
    //                   ? "การจองได้รับการอนุมัติแล้ว"
    //                   : "การจองห้องไม่ได้รับการอนุมัติ กรุณาติดต่อเจ้าหน้าที่",
    //               size: "sm",
    //               color: status === "approved" ? "#1DB446" : "#FF3B30",
    //               weight: "bold",
    //               wrap: true,
    //               align: "center",
    //             },
    //           ],
    //           paddingAll: "md",
    //           backgroundColor: status === "approved" ? "#E6F5EA" : "#FDEBEC",
    //           spacing: "sm",
    //         },
    //       },
    //     },
    //   ],
    // };
    const lineMessage = {
      to: "U2698869fcd7379f81181c2fdc0b961eb", // ควรเก็บ userId ไว้ใน booking
      messages: [
        {
          type: "flex",
          altText:
            status === "approved"
              ? "การจองห้องประชุมได้รับการอนุมัติแล้ว"
              : "การจองห้องไม่ได้รับการอนุมัติ",
          contents: {
            type: "bubble",
            size: "kilo",
            header: {
              type: "box",
              layout: "horizontal",
              contents: [
                {
                  type: "text",
                  text:
                    status === "approved"
                      ? "การจองห้องประชุมได้รับการอนุมัติแล้ว"
                      : "การจองห้องไม่ได้รับการอนุมัติ",
                  wrap: true,
                  weight: "bold",
                  color: "#FFFFFF",
                  size: "sm",
                },
              ],
              paddingAll: "md",
              backgroundColor: status === "approved" ? "#4CAF50" : "#F44336",
            },
            hero: selectedRoom?.picture
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
              contents: [
                {
                  type: "text",
                  text: `ห้องประชุมใหญ่ ${selectedRoom || "812"}`,
                  weight: "bold",
                  size: "xl",
                  margin: "md",
                },
                {
                  type: "box",
                  layout: "vertical",
                  margin: "lg",
                  spacing: "sm",
                  contents: [
                    {
                      type: "box",
                      layout: "baseline",
                      contents: [
                        {
                          type: "text",
                          text: "📅",
                          size: "sm",
                          flex: 0,
                        },
                        {
                          type: "text",
                          text: "วันที่",
                          size: "sm",
                          color: "#666666",
                          margin: "sm",
                          flex: 0,
                        },
                      ],
                    },
                    {
                      type: "text",
                      text: `${date || "27 กรกฎาคม 2568"}`,
                      size: "sm",
                      margin: "sm",
                    },
                    {
                      type: "box",
                      layout: "baseline",
                      contents: [
                        {
                          type: "text",
                          text: "⏰",
                          size: "sm",
                          flex: 0,
                        },
                        {
                          type: "text",
                          text: "เวลา",
                          size: "sm",
                          color: "#666666",
                          margin: "sm",
                          flex: 0,
                        },
                      ],
                    },
                    {
                      type: "text",
                      text: `${startTime || "13:00"} - ${
                        endTime || "14:00"
                      } น.`,
                      size: "sm",
                      margin: "sm",
                    },
                    {
                      type: "box",
                      layout: "baseline",
                      contents: [
                        {
                          type: "text",
                          text: "👤",
                          size: "sm",
                          flex: 0,
                        },
                        {
                          type: "text",
                          text: "ผู้จอง",
                          size: "sm",
                          color: "#666666",
                          margin: "sm",
                          flex: 0,
                        },
                      ],
                    },
                    {
                      type: "text",
                      text: `${booker || "คุณสมชาย ใจดี"}`,
                      size: "sm",
                      margin: "sm",
                    },
                    {
                      type: "box",
                      layout: "baseline",
                      contents: [
                        {
                          type: "text",
                          text: "💬",
                          size: "sm",
                          flex: 0,
                        },
                        {
                          type: "text",
                          text: "กิจกรรม/หัวข้อการประชุม",
                          size: "sm",
                          color: "#666666",
                          margin: "sm",
                          flex: 0,
                        },
                      ],
                    },
                    {
                      type: "text",
                      text: `${activity || "ประชุมวางแผนโครงการ"}`,
                      size: "sm",
                      margin: "sm",
                    },
                    {
                      type: "separator",
                      margin: "xl",
                    },
                    {
                      type: "text",
                      text: "สถานะการจอง",
                      weight: "bold",
                      size: "sm",
                      margin: "xl",
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
                              cornerRadius: "30px",
                              height: "12px",
                              width: "12px",
                              borderColor:
                                status === "approved" ? "#4CAF50" : "#F44336",
                              borderWidth: "2px",
                              backgroundColor:
                                status === "approved" ? "#4CAF50" : "#F44336",
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
                              text: `${new Date().toLocaleDateString("th-TH", {
                                day: "numeric",
                                month: "short",
                                year: "numeric",
                              })} ${new Date().toLocaleTimeString("th-TH", {
                                hour: "2-digit",
                                minute: "2-digit",
                              })} น.`,
                              size: "xs",
                              color: "#666666",
                            },
                            {
                              type: "text",
                              text:
                                status === "approved"
                                  ? "การจองได้รับการอนุมัติแล้ว"
                                  : "การจองห้องไม่ได้รับการอนุมัติ กรุณาติดต่อเจ้าหน้าที่",
                              size: "sm",
                              wrap: true,
                              color:
                                status === "approved" ? "#4CAF50" : "#F44336",
                              weight: "bold",
                            },
                          ],
                          margin: "sm",
                        },
                      ],
                      margin: "md",
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
    };

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
  const event = {
    summary: booking.activity,
    description: booking.booker,
    start: {
      dateTime: `${booking.date}T${booking.startTime}:00`,
      timeZone: "Asia/Bangkok", // เปลี่ยนเป็นเวลาประเทศไทย
    },
    end: {
      dateTime: `${booking.date}T${booking.endTime}:00`,
      timeZone: "Asia/Bangkok",
    },
  };

  console.log("📅 Creating calendar event:", event);

  return new Promise((resolve, reject) => {
    calendar.events.insert(
      {
        calendarId: "primary",
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

exports.app = onRequest({ cors: true }, app);
