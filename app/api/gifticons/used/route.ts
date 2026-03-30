import { NextRequest, NextResponse } from "next/server";
import { db, messaging } from "../../../../lib/firebase";
import { FieldValue } from "firebase-admin/firestore";

export const runtime = "nodejs";

type UsedGifticonRequest = {
  gifticonId: string;
  usedBy: string; // 사용한 기기 ID
};

async function getCounterpartToken(
  data: FirebaseFirestore.DocumentData,
  usedBy: string
): Promise<string | null> {
  // usedBy가 owner면 상대방은 receiver, 아니면 owner
  const isOwner = usedBy === data.ownerId;
  const counterpartId = isOwner ? data.receiverId : data.ownerId;

  if (!counterpartId) return null;

  const deviceDoc = await db.collection("devices").doc(counterpartId).get();
  if (!deviceDoc.exists) return null;

  return (deviceDoc.data()?.fcmToken as string) ?? null;
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

    // Firestore 사용 처리
    await docRef.update({
      status: "used",
      usedBy,
      usedAt: FieldValue.serverTimestamp(),
    });

    console.log(`[used] gifticonId=${gifticonId} marked as used by ${usedBy}`);

    // Firestore /devices에서 상대방 FCM 토큰 조회 후 발송
    const counterpartToken = await getCounterpartToken(data, usedBy);

    if (counterpartToken) {
      const isOwner = usedBy === data.ownerId;
      const whoUsed = isOwner ? "보낸 분" : "받은 분";

      try {
        await messaging.send({
          token: counterpartToken,
          notification: {
            title: "기프티콘이 사용되었어요",
            body: `${data.itemName ?? "기프티콘"}을 ${whoUsed}이 사용했어요.`,
          },
          data: {
            type: "gifticon_used",
            gifticonId,
          },
          android: { priority: "high" },
        });
        console.log(
          `[used] FCM sent to counterpart token=${counterpartToken.slice(0, 10)}...`
        );
      } catch (fcmError) {
        // FCM 실패는 무시 — Firestore는 이미 업데이트됨
        console.warn("[used] FCM send failed:", fcmError);
      }
    } else {
      console.log(`[used] no counterpart FCM token found for gifticonId=${gifticonId}`);
    }

    return NextResponse.json({ gifticonId, usedBy }, { status: 200 });
  } catch (error) {
    console.error("[/api/gifticons/used] error:", error);
    return NextResponse.json(
      { error: "Failed to mark gifticon as used." },
      { status: 500 }
    );
  }
}