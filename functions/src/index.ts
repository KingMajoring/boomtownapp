import { onValueCreated } from "firebase-functions/v2/database";
import { logger } from "firebase-functions";
import { initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";

initializeApp();

interface ChatMessage {
  uid: string;
  name: string;
  text: string;
  system?: boolean;
}

interface CrewUser {
  name?: string;
  fcmToken?: string;
}

// Realtime Database triggers need to run in the same region as the
// database instance itself (europe-west1 here, matching the app's
// databaseURL) or they won't fire reliably.
export const notifyOnNewChatMessage = onValueCreated(
  {
    ref: "/crews/{code}/chat/{msgId}",
    region: "europe-west1",
  },
  async (event) => {
    const message = event.data.val() as ChatMessage | null;
    // Skip system messages (check-ins, "left the stage", etc.) - only
    // notify on things someone actually typed
    if (!message || message.system || !message.text) return;

    const { code } = event.params;
    const senderUid = message.uid;
    const senderName = message.name || "Someone";
    const body = message.text.length > 120
      ? `${message.text.slice(0, 117)}...`
      : message.text;

    const usersSnap = await event.data.ref.root.child(`crews/${code}/users`).get();
    const users = (usersSnap.val() || {}) as Record<string, CrewUser>;

    const recipientUids = Object.keys(users).filter(
      (uid) => uid !== senderUid && users[uid] && users[uid].fcmToken
    );
    const tokens = recipientUids.map((uid) => users[uid].fcmToken as string);

    if (tokens.length === 0) {
      logger.info(`No push tokens to notify for crew ${code}`);
      return;
    }

    const response = await getMessaging().sendEachForMulticast({
      tokens,
      notification: {
        title: senderName,
        body,
      },
      data: {
        code,
        type: "chat",
      },
      webpush: {
        fcmOptions: {
          link: "/",
        },
      },
    });

    // Clean up tokens that are no longer valid (uninstalled, permission
    // revoked, etc.) so future sends don't keep retrying them
    const staleUids: string[] = [];
    response.responses.forEach((res, i) => {
      if (!res.success) {
        const errorCode = res.error?.code;
        if (
          errorCode === "messaging/registration-token-not-registered" ||
          errorCode === "messaging/invalid-registration-token" ||
          errorCode === "messaging/invalid-argument"
        ) {
          staleUids.push(recipientUids[i]);
        } else {
          logger.warn(`Push send failed for ${recipientUids[i]}:`, res.error);
        }
      }
    });

    if (staleUids.length) {
      const updates: Record<string, null> = {};
      staleUids.forEach((uid) => {
        updates[`crews/${code}/users/${uid}/fcmToken`] = null;
      });
      await event.data.ref.root.update(updates);
      logger.info(`Cleared ${staleUids.length} stale push token(s) for crew ${code}`);
    }
  }
);
