const admin = require("firebase-admin");

const getInitializedApps = () =>
  typeof admin.getApps === "function" ? admin.getApps() : (admin.apps || []);

if (getInitializedApps().length === 0) {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    : null;

  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential
        ? admin.credential.cert(serviceAccount)
        : admin.cert(serviceAccount),
    });
    console.log("Firebase Admin initialized");
  } else {
    console.warn("FIREBASE_SERVICE_ACCOUNT_JSON not set — push notifications disabled");
  }
}

function getMessagingInstance() {
  return typeof admin.messaging === "function"
    ? admin.messaging()
    : require("firebase-admin/messaging").getMessaging();
}

async function sendPushNotification({ token, title, body, data = {} }) {
  if (getInitializedApps().length === 0) return null;

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
    const response = await getMessagingInstance().send(message);
    return response;
  } catch (error) {
    console.error("FCM send error:", error.message);
    return null;
  }
}

async function sendPushToMultiple({ tokens, title, body, data = {} }) {
  if (getInitializedApps().length === 0 || !tokens || tokens.length === 0) return [];

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
    const response = await getMessagingInstance().sendEach(messages);
    return response.responses;
  } catch (error) {
    console.error("FCM sendEach error:", error.message);
    return [];
  }
}

module.exports = { sendPushNotification, sendPushToMultiple };
