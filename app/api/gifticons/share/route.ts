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
}): Promise<{ matched: boolean; receiverId?: string }> {
  // owner 제외한 기기 목록 조회
  const devicesSnap = await db.collection("devices").get();
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

  if (candidates.length === 0) {
    console.log(`[share/match] no candidates for gifticonId=${gifticonId}`);
    return { matched: false };
  }

  // 랜덤 선택
  const receiver = candidates[Math.floor(Math.random() * candidates.length)];

  // Firestore 매칭 업데이트
  await db.collection("gifticons").doc(gifticonId).update({
    receiverId: receiver.deviceId,
    receiverNickname: receiver.nickname || null,
    status: "matched",
    matchedAt: FieldValue.serverTimestamp(),
  });

  console.log(
    `[share/match] matched gifticonId=${gifticonId} → receiverId=${receiver.deviceId}`
  );

  // 수신자에게 FCM 발송
  try {
    await messaging.send({
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
    console.log(`[share/match] FCM sent to receiverId=${receiver.deviceId}`);
  } catch (fcmError) {
    console.warn(`[share/match] FCM failed for receiverId=${receiver.deviceId}:`, fcmError);
  }

  return { matched: true, receiverId: receiver.deviceId };
}

export async function POST(req: NextRequest) {
  try {
    let body: ShareGifticonRequest;
    try {
      body = (await req.json()) as ShareGifticonRequest;
    } catch {
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

    if (!gifticonId || !ownerId || !imageBase64 || !expiresAt) {
      return NextResponse.json(
        { error: "gifticonId, ownerId, imageBase64, expiresAt are required." },
        { status: 400 }
      );
    }

    // owner nickname 조회 — 미등록이어도 null로 진행
    const ownerSnap = await db.collection("devices").doc(ownerId).get();
    const ownerData = ownerSnap.data() as DeviceDoc | undefined;
    const ownerNickname = ownerData?.nickname?.trim() ?? null;

    if (!ownerSnap.exists) {
      console.warn(
        `[share] owner device not registered: ownerId=${ownerId} — proceeding without nickname`
      );
    }

    // 이미 공유된 문서인지 확인 (중복 방지)
    const existing = await db.collection("gifticons").doc(gifticonId).get();
    if (existing.exists) {
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

    // base64 → Buffer → Storage 업로드
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    const imageBuffer = Buffer.from(base64Data, "base64");

    const filePath = `gifticons/${gifticonId}.jpg`;
    const file = bucket.file(filePath);

    await file.save(imageBuffer, {
      metadata: { contentType: "image/jpeg" },
    });

    await file.makePublic();
    const imageUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;

    // Firestore 문서 생성
    await db.collection("gifticons").doc(gifticonId).set({
      gifticonId,
      ownerId,
      ownerNickname,
      receiverId: null,
      receiverNickname: null,
      imageUrl,
      merchantName: merchantName ?? null,
      itemName: itemName ?? null,
      couponNumber: couponNumber ?? null,
      expiresAt: new Date(expiresAt),
      status: "pending_match",
      sharedAt: FieldValue.serverTimestamp(),
      matchedAt: null,
      usedAt: null,
      usedBy: null,
      usedByNickname: null,
    });

    console.log(
      `[share] gifticonId=${gifticonId} uploaded ownerNickname=${ownerNickname}`
    );

    // 등록 즉시 매칭 시도
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

    return NextResponse.json(
      {
        gifticonId,
        imageUrl,
        ownerNickname,
        matched: matchResult.matched,
        receiverId: matchResult.receiverId ?? null,
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