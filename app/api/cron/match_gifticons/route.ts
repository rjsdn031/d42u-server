import { NextRequest, NextResponse } from "next/server";
import { db, messaging } from "../../../../lib/firebase";
import { FieldValue } from "firebase-admin/firestore";

export const runtime = "nodejs";

// Vercel cron 요청 검증
function isAuthorizedCron(req: NextRequest): boolean {
  const secret = req.headers.get("authorization");
  return secret === `Bearer ${process.env.CRON_SECRET}`;
}

type DeviceDoc = {
  fcmToken?: string;
  nickname?: string;
};

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    // 1. 매칭 대기 중인 기프티콘 조회
    const pendingSnap = await db
      .collection("gifticons")
      .where("status", "==", "pending_match")
      .get();

    if (pendingSnap.empty) {
      console.log("[cron/match] no pending gifticons");
      return NextResponse.json({ matched: 0 }, { status: 200 });
    }

    // 2. 등록된 기기 목록 조회
    const devicesSnap = await db.collection("devices").get();
    const devices = devicesSnap.docs
      .map((d) => {
        const data = d.data() as DeviceDoc;
        return {
          deviceId: d.id,
          fcmToken: data.fcmToken ?? "",
          nickname: data.nickname ?? "",
        };
      })
      .filter((d) => d.fcmToken !== "");

    let matchedCount = 0;

    for (const doc of pendingSnap.docs) {
      const data = doc.data();
      const gifticonId = doc.id;
      const ownerId = data.ownerId as string;
      const ownerNickname = (data.ownerNickname as string | undefined) ?? "";

      // owner 제외한 후보 목록
      const candidates = devices.filter((d) => d.deviceId !== ownerId);

      if (candidates.length === 0) {
        console.log(`[cron/match] no candidates for gifticonId=${gifticonId}`);
        continue;
      }

      // 랜덤 선택
      const receiver =
        candidates[Math.floor(Math.random() * candidates.length)];

      // 3. Firestore 업데이트
      await db.collection("gifticons").doc(gifticonId).update({
        receiverId: receiver.deviceId,
        receiverNickname: receiver.nickname || null,
        status: "matched",
        matchedAt: FieldValue.serverTimestamp(),
      });

      console.log(
        `[cron/match] matched gifticonId=${gifticonId} → receiverId=${receiver.deviceId}, receiverNickname=${receiver.nickname}`
      );

      // 4. 수신자에게 FCM 발송
      try {
        await messaging.send({
          token: receiver.fcmToken,
          notification: {
            title: "기프티콘이 도착했어요 🎁",
            body: `${data.merchantName ?? ""} ${data.itemName ?? "기프티콘"}을 받았어요. 지금 확인해보세요!`.trim(),
          },
          data: {
            type: "gifticon_received",
            gifticonId,
            imageUrl: data.imageUrl as string,
            merchantName: data.merchantName ?? "",
            itemName: data.itemName ?? "",
            couponNumber: data.couponNumber ?? "",
            expiresAt: (data.expiresAt as FirebaseFirestore.Timestamp)
              .toDate()
              .toISOString(),
            ownerId,
            ownerNickname,
          },
          android: {
            priority: "high",
          },
        });

        matchedCount++;
        console.log(`[cron/match] FCM sent to ${receiver.deviceId}`);
      } catch (fcmError) {
        console.warn(
          `[cron/match] FCM failed for receiverId=${receiver.deviceId}:`,
          fcmError
        );
      }
    }

    return NextResponse.json({ matched: matchedCount }, { status: 200 });
  } catch (error) {
    console.error("[cron/match-gifticons] error:", error);
    return NextResponse.json(
      { error: "Matching failed." },
      { status: 500 }
    );
  }
}