import { NextRequest, NextResponse } from "next/server";
import { db, bucket, messaging } from "../../../../lib/firebase";
import { firestore } from "firebase-admin";
const { FieldValue } = firestore;

export const runtime = "nodejs";

type ShareGifticonRequest = {
  gifticonId: string;
  ownerId: string;
  imageBase64: string;
  merchantName?: string | null;
  itemName?: string | null;
  couponNumber?: string | null;
  expiresAt: string;
};

type DeviceDoc = {
  nickname?: string;
  fcmToken?: string;
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
}): Promise<{ matched: boolean; receiverIds?: string[] }> {
  console.log(`[share/match] start gifticonId=${gifticonId}, ownerId=${ownerId}`);

  const devicesSnap = await db.collection("devices").get();
  console.log(`[share/match] devices fetched count=${devicesSnap.size}`);

  const allDevices = devicesSnap.docs.map((d) => {
    const data = d.data() as DeviceDoc;
    return {
      deviceId: d.id,
      fcmToken: data.fcmToken ?? "",
      nickname: data.nickname ?? "",
    };
  });

  const candidates = allDevices.filter(
    (d) => d.fcmToken !== "" && d.deviceId !== ownerId
  );

  console.log("[share/match] candidate summary", {
    gifticonId,
    totalDevices: allDevices.length,
    candidates: candidates.length,
    candidateIds: candidates.map((c) => c.deviceId),
  });

  if (candidates.length === 0) {
    console.log(`[share/match] no candidates for gifticonId=${gifticonId}`);
    return { matched: false };
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
    `[share/match] gifticonId=${gifticonId} marked shared to ${candidates.length} receivers`
  );

  const results = await Promise.allSettled(
    candidates.map(async (receiver) => {
      console.log("[share/fcm] sending", {
        gifticonId,
        receiverId: receiver.deviceId,
        hasToken: Boolean(receiver.fcmToken),
        receiverNickname: receiver.nickname,
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

      return {
        receiverId: receiver.deviceId,
        messageId,
      };
    })
  );

  let successCount = 0;
  let failCount = 0;

  results.forEach((result, index) => {
    const receiver = candidates[index];

    if (result.status === "fulfilled") {
      successCount += 1;
    } else {
      failCount += 1;
      console.warn("[share/fcm] failed", {
        gifticonId,
        receiverId: receiver.deviceId,
        reason: result.reason,
      });
    }
  });

  console.log("[share/fcm] summary", {
    gifticonId,
    successCount,
    failCount,
    total: candidates.length,
  });

  return {
    matched: true,
    receiverIds: candidates.map((c) => c.deviceId),
  };
}

export async function POST(req: NextRequest) {
  try {
    console.log("[/api/gifticons/share] request received");

    let body: ShareGifticonRequest;
    try {
      body = (await req.json()) as ShareGifticonRequest;
    } catch (jsonError) {
      console.warn("[/api/gifticons/share] invalid json body", jsonError);
      return NextResponse.json(
        { error: "Invalid JSON body." },
        { status: 400 }
      );
    }

    const {
      gifticonId,
      ownerId,
      imageBase64,
      merchantName,
      itemName,
      couponNumber,
      expiresAt,
    } = body;

    console.log("[/api/gifticons/share] parsed body", {
      gifticonId,
      ownerId,
      hasImageBase64: Boolean(imageBase64),
      imageBase64Length: imageBase64?.length ?? 0,
      merchantName,
      itemName,
      hasCouponNumber: Boolean(couponNumber),
      expiresAt,
    });

    if (!gifticonId || !ownerId || !imageBase64 || !expiresAt) {
      console.warn("[/api/gifticons/share] missing required fields", {
        gifticonId,
        ownerId,
        hasImageBase64: Boolean(imageBase64),
        expiresAt,
      });

      return NextResponse.json(
        { error: "gifticonId, ownerId, imageBase64, expiresAt are required." },
        { status: 400 }
      );
    }

    console.log(`[/api/gifticons/share] loading owner device ownerId=${ownerId}`);
    const ownerSnap = await db.collection("devices").doc(ownerId).get();
    const ownerData = ownerSnap.data() as DeviceDoc | undefined;
    const ownerNickname = ownerData?.nickname?.trim() ?? null;

    console.log("[/api/gifticons/share] owner lookup result", {
      ownerId,
      ownerExists: ownerSnap.exists,
      ownerNickname,
      hasOwnerToken: Boolean(ownerData?.fcmToken),
    });

    if (!ownerSnap.exists) {
      console.warn(
        `[share] owner device not registered: ownerId=${ownerId} — proceeding without nickname`
      );
    }

    console.log(`[/api/gifticons/share] checking existing gifticon gifticonId=${gifticonId}`);
    const existing = await db.collection("gifticons").doc(gifticonId).get();

    if (existing.exists) {
      console.log("[/api/gifticons/share] already shared", {
        gifticonId,
        imageUrl: existing.data()?.imageUrl,
      });

      return NextResponse.json(
        {
          gifticonId,
          imageUrl: existing.data()?.imageUrl,
          ownerNickname: existing.data()?.ownerNickname ?? ownerNickname,
          alreadyShared: true,
        },
        { status: 200 }
      );
    }

    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    const imageBuffer = Buffer.from(base64Data, "base64");

    console.log("[/api/gifticons/share] image decoded", {
      gifticonId,
      bufferBytes: imageBuffer.length,
    });

    const filePath = `gifticons/${gifticonId}.jpg`;
    const file = bucket.file(filePath);

    console.log("[/api/gifticons/share] uploading image", {
      gifticonId,
      filePath,
      bucket: bucket.name,
    });

    await file.save(imageBuffer, {
      metadata: { contentType: "image/jpeg" },
    });

    console.log("[/api/gifticons/share] image uploaded", {
      gifticonId,
      filePath,
    });

    await file.makePublic();
    const imageUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;

    console.log("[/api/gifticons/share] image public url ready", {
      gifticonId,
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

    console.log("[/api/gifticons/share] gifticon document created", {
      gifticonId,
      ownerId,
      ownerNickname,
      imageUrl,
      expiresAt,
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

    console.log("[/api/gifticons/share] completed", {
      gifticonId,
      matched: matchResult.matched,
      receiverIds: matchResult.receiverIds ?? [],
    });

    return NextResponse.json(
      {
        gifticonId,
        imageUrl,
        ownerNickname,
        matched: matchResult.matched,
        receiverIds: matchResult.receiverIds ?? [],
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("[/api/gifticons/share] error:", error);
    return NextResponse.json(
      { error: "Failed to share gifticon." },
      { status: 500 }
    );
  }
}