import { NextRequest, NextResponse } from "next/server";
import { db, messaging } from "../../../../lib/firebase";
import { FieldValue } from "firebase-admin/firestore";

export const runtime = "nodejs";

type UsedGifticonRequest = {
  gifticonId: string;
  usedBy: string;
};

type DeviceDoc = {
  fcmToken?: string;
  nickname?: string;
};

async function getDeviceInfo(deviceId: string): Promise<DeviceDoc | null> {
  const deviceDoc = await db.collection("devices").doc(deviceId).get();
  if (!deviceDoc.exists) return null;

  const data = deviceDoc.data() as DeviceDoc | undefined;
  return {
    fcmToken: data?.fcmToken ?? "",
    nickname: data?.nickname ?? "",
  };
}

async function getCounterpartToken(
  data: FirebaseFirestore.DocumentData,
  usedBy: string
): Promise<string | null> {
  const isOwner = usedBy === data.ownerId;
  const counterpartId = isOwner ? data.receiverId : data.ownerId;

  if (!counterpartId) return null;

  const deviceInfo = await getDeviceInfo(counterpartId);
  if (!deviceInfo?.fcmToken) return null;

  return deviceInfo.fcmToken;
}

export async function POST(req: NextRequest) {
  try {
    let body: UsedGifticonRequest;
    try {
      body = (await req.json()) as UsedGifticonRequest;
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body." },
        { status: 400 }
      );
    }

    const { gifticonId, usedBy } = body;

    if (!gifticonId || !usedBy) {
      return NextResponse.json(
        { error: "gifticonId and usedBy are required." },
        { status: 400 }
      );
    }

    const docRef = db.collection("gifticons").doc(gifticonId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return NextResponse.json(
        { error: "Gifticon not found." },
        { status: 404 }
      );
    }

    const data = doc.data()!;

    if (data.status === "used") {
      return NextResponse.json(
        { gifticonId, alreadyUsed: true },
        { status: 200 }
      );
    }

    // 닉네임은 없어도 사용 처리는 항상 진행
    const usedByDevice = await getDeviceInfo(usedBy);
    const usedByNickname = usedByDevice?.nickname?.trim() ?? null;

    await docRef.update({
      status: "used",
      usedBy,
      usedByNickname,
      usedAt: FieldValue.serverTimestamp(),
    });

    console.log(
      `[used] gifticonId=${gifticonId} marked as used by ${usedBy}, nickname=${usedByNickname}`
    );

    // 상대방 FCM 발송
    const counterpartToken = await getCounterpartToken(data, usedBy);

    if (counterpartToken) {
      const displayName = usedByNickname ? `${usedByNickname}님` : "누군가";
      try {
        await messaging.send({
          token: counterpartToken,
          notification: {
            title: "기프티콘이 사용되었어요",
            body: `${data.itemName ?? "기프티콘"}을 ${displayName}이 사용했어요.`,
          },
          data: {
            type: "gifticon_used",
            gifticonId,
            usedBy,
            usedByNickname: usedByNickname ?? "",
          },
          android: { priority: "high" },
        });
        console.log(
          `[used] FCM sent to counterpart token=${counterpartToken.slice(0, 10)}...`
        );
      } catch (fcmError) {
        console.warn("[used] FCM send failed:", fcmError);
      }
    } else {
      console.log(
        `[used] no counterpart FCM token found for gifticonId=${gifticonId}`
      );
    }

    return NextResponse.json({ gifticonId, usedBy, usedByNickname }, { status: 200 });
  } catch (error) {
    console.error("[/api/gifticons/used] error:", error);
    return NextResponse.json(
      { error: "Failed to mark gifticon as used." },
      { status: 500 }
    );
  }
}