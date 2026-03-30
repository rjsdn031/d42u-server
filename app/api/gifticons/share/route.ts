import { NextRequest, NextResponse } from "next/server";
import { db, bucket } from "../../../../lib/firebase";
import { FieldValue } from "firebase-admin/firestore";

export const runtime = "nodejs";

type ShareGifticonRequest = {
  gifticonId: string;      // 로컬 Hive ID (Flutter에서 생성한 UUID)
  ownerId: string;         // 기기 ID
  imageBase64: string;     // 이미지 base64 (data:image/... 포함 가능)
  merchantName?: string | null;
  itemName?: string | null;
  couponNumber?: string | null;
  expiresAt: string;       // ISO 8601
};

type DeviceDoc = {
  nickname?: string;
  fcmToken?: string;
};

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

    // owner nickname 조회
    const ownerSnap = await db.collection("devices").doc(ownerId).get();
    if (!ownerSnap.exists) {
      return NextResponse.json(
        { error: "Owner device is not registered." },
        { status: 404 }
      );
    }

    const ownerData = ownerSnap.data() as DeviceDoc | undefined;
    const ownerNickname = ownerData?.nickname?.trim();

    if (!ownerNickname) {
      return NextResponse.json(
        { error: "Owner nickname is missing." },
        { status: 400 }
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

    // base64 → Buffer
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    const imageBuffer = Buffer.from(base64Data, "base64");

    // Firebase Storage 업로드
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
      `[share] gifticonId=${gifticonId} uploaded and registered ownerNickname=${ownerNickname}`
    );

    return NextResponse.json(
      { gifticonId, imageUrl, ownerNickname },
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