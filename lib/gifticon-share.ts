import { bucket, db, messaging } from "./firebase";
import { firestore } from "firebase-admin";

const { FieldValue } = firestore;

export type DeviceDoc = {
  nickname?: string;
  fcmToken?: string;
};

export type ShareGifticonInput = {
  gifticonId: string;
  ownerId: string;
  imageBase64: string;
  merchantName?: string | null;
  itemName?: string | null;
  couponNumber?: string | null;
  expiresAt: string;
};

export type ShareGifticonResult = {
  gifticonId: string;
  imageUrl: string;
  ownerNickname: string | null;
  matched: boolean;
  receiverIds: string[];
  alreadyShared?: boolean;
};

async function matchAndNotify({
  gifticonId,
  ownerId,
  ownerNickname,
  imageUrl,
  merchantName,
  itemName,
  couponNumber,
  expiresAt,
}: {
  gifticonId: string;
  ownerId: string;
  ownerNickname: string | null;
  imageUrl: string;
  merchantName: string | null;
  itemName: string | null;
  couponNumber: string | null;
  expiresAt: string;
}): Promise<{ matched: boolean; receiverIds: string[] }> {
  console.log(`[share/match] start gifticonId=${gifticonId}, ownerId=${ownerId}`);

  const devicesSnap = await db.collection("devices").get();
  console.log(`[share/match] devices fetched count=${devicesSnap.size}`);

  const candidates = devicesSnap.docs
    .map((d) => {
      const data = d.data() as DeviceDoc;
      return {
        deviceId: d.id,
        fcmToken: data.fcmToken ?? "",
        nickname: data.nickname ?? "",
      };
    })
    .filter((d) => d.fcmToken !== "" && d.deviceId !== ownerId);

  console.log("[share/match] candidate summary", {
    gifticonId,
    ownerId,
    candidateCount: candidates.length,
    candidateIds: candidates.map((c) => c.deviceId),
  });

  if (candidates.length === 0) {
    console.log(`[share/match] no candidates for gifticonId=${gifticonId}`);
    return { matched: false, receiverIds: [] };
  }

  const receivers = candidates.map((c) => ({
    deviceId: c.deviceId,
    nickname: c.nickname || null,
  }));

  await db.collection("gifticons").doc(gifticonId).update({
    receiverIds: candidates.map((c) => c.deviceId),
    receivers,
    status: "shared",
    matchedAt: FieldValue.serverTimestamp(),
    sharedCount: candidates.length,
    receiverId: FieldValue.delete(),
    receiverNickname: FieldValue.delete(),
  });

  console.log(
    `[share/match] gifticonId=${gifticonId} shared to ${candidates.length} receivers`
  );

  const results = await Promise.allSettled(
    candidates.map(async (receiver) => {
      console.log("[share/fcm] sending", {
        gifticonId,
        receiverId: receiver.deviceId,
        hasToken: Boolean(receiver.fcmToken),
      });

      const messageId = await messaging.send({
        token: receiver.fcmToken,
        notification: {
          title: "기프티콘이 도착했어요 🎁",
          body: `${merchantName ?? ""} ${itemName ?? "기프티콘"}을 받았어요. 지금 확인해보세요!`.trim(),
        },
        data: {
          type: "gifticon_received",
          gifticonId,
          imageUrl,
          merchantName: merchantName ?? "",
          itemName: itemName ?? "",
          couponNumber: couponNumber ?? "",
          expiresAt,
          ownerId,
          ownerNickname: ownerNickname ?? "",
        },
        android: { priority: "high" },
      });

      console.log("[share/fcm] sent", {
        gifticonId,
        receiverId: receiver.deviceId,
        messageId,
      });

      return { receiverId: receiver.deviceId, messageId };
    })
  );

  const successCount = results.filter((r) => r.status === "fulfilled").length;
  const failCount = results.filter((r) => r.status === "rejected").length;

  console.log("[share/fcm] summary", {
    gifticonId,
    successCount,
    failCount,
    total: candidates.length,
  });

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.warn("[share/fcm] failed", {
        gifticonId,
        receiverId: candidates[index]?.deviceId ?? null,
        reason: result.reason,
      });
    }
  });

  return {
    matched: true,
    receiverIds: candidates.map((c) => c.deviceId),
  };
}

export async function shareGifticon(input: ShareGifticonInput): Promise<ShareGifticonResult> {
  const {
    gifticonId,
    ownerId,
    imageBase64,
    merchantName,
    itemName,
    couponNumber,
    expiresAt,
  } = input;

  console.log("[share/core] start", {
    gifticonId,
    ownerId,
    hasImageBase64: Boolean(imageBase64),
    imageBase64Length: imageBase64?.length ?? 0,
    merchantName,
    itemName,
    hasCouponNumber: Boolean(couponNumber),
    expiresAt,
  });

  const ownerSnap = await db.collection("devices").doc(ownerId).get();
  const ownerData = ownerSnap.data() as DeviceDoc | undefined;
  const ownerNickname = ownerData?.nickname?.trim() ?? null;

  console.log("[share/core] owner lookup", {
    ownerId,
    ownerExists: ownerSnap.exists,
    ownerNickname,
  });

  if (!ownerSnap.exists) {
    console.warn(
      `[share] owner device not registered: ownerId=${ownerId} — proceeding without nickname`
    );
  }

  const existing = await db.collection("gifticons").doc(gifticonId).get();
  if (existing.exists) {
    console.log("[share/core] existing gifticon found", {
      gifticonId,
      imageUrl: existing.data()?.imageUrl,
    });

    return {
      gifticonId,
      imageUrl: existing.data()?.imageUrl,
      ownerNickname: existing.data()?.ownerNickname ?? ownerNickname,
      matched: Array.isArray(existing.data()?.receiverIds) && existing.data()!.receiverIds.length > 0,
      receiverIds: Array.isArray(existing.data()?.receiverIds)
        ? existing.data()!.receiverIds
        : [],
      alreadyShared: true,
    };
  }

  const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
  const imageBuffer = Buffer.from(base64Data, "base64");

  console.log("[share/core] image decoded", {
    gifticonId,
    bufferBytes: imageBuffer.length,
  });

  const filePath = `gifticons/${gifticonId}.jpg`;
  const file = bucket.file(filePath);

  await file.save(imageBuffer, {
    metadata: { contentType: "image/jpeg" },
  });

  await file.makePublic();
  const imageUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;

  console.log("[share/core] image uploaded", {
    gifticonId,
    filePath,
    imageUrl,
  });

  await db.collection("gifticons").doc(gifticonId).set({
    gifticonId,
    ownerId,
    ownerNickname,
    receiverIds: [],
    receivers: [],
    imageUrl,
    merchantName: merchantName ?? null,
    itemName: itemName ?? null,
    couponNumber: couponNumber ?? null,
    expiresAt: new Date(expiresAt),
    status: "pending_share",
    sharedCount: 0,
    sharedAt: FieldValue.serverTimestamp(),
    matchedAt: null,
    usedAt: null,
    usedBy: null,
    usedByNickname: null,
  });

  console.log("[share/core] gifticon document created", {
    gifticonId,
    ownerId,
    ownerNickname,
  });

  const matchResult = await matchAndNotify({
    gifticonId,
    ownerId,
    ownerNickname,
    imageUrl,
    merchantName: merchantName ?? null,
    itemName: itemName ?? null,
    couponNumber: couponNumber ?? null,
    expiresAt,
  });

  return {
    gifticonId,
    imageUrl,
    ownerNickname,
    matched: matchResult.matched,
    receiverIds: matchResult.receiverIds,
  };
}