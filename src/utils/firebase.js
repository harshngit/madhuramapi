const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");

if (getApps().length === 0) {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    : null;

  if (serviceAccount) {
    initializeApp({ credential: cert(serviceAccount) });
    console.log("Firebase Admin initialized");
  } else {
    console.warn("FIREBASE_SERVICE_ACCOUNT_JSON not set — push notifications disabled");
  }
}

async function sendPushNotification({ token, title, body, data = {} }) {
  if (getApps().length === 0) return null;

  try {
    const message = {
      token,
      notification: { title, body },
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      ),
      android: {
        priority: "high",
        notification: { sound: "default", channelId: "default" },
      },
      webpush: {
        notification: { icon: "/icon.png", badge: "/badge.png" },
      },
    };
    const response = await getMessaging().send(message);
    return response;
  } catch (error) {
    console.error("FCM send error:", error.message);
    return null;
  }
}

async function sendPushToMultiple({ tokens, title, body, data = {} }) {
  if (getApps().length === 0 || !tokens || tokens.length === 0) return [];

  const messages = tokens.map((token) => ({
    token,
    notification: { title, body },
    data: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)])
    ),
    android: {
      priority: "high",
      notification: { sound: "default", channelId: "default" },
    },
    webpush: {
      notification: { icon: "/icon.png", badge: "/badge.png" },
    },
  }));

  try {
    const response = await getMessaging().sendEach(messages);
    return response.responses;
  } catch (error) {
    console.error("FCM sendEach error:", error.message);
    return [];
  }
}

module.exports = { sendPushNotification, sendPushToMultiple };
