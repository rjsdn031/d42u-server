import { NextRequest, NextResponse } from "next/server";
import { db, messaging } from "../../../../lib/firebase";
import { firestore } from "firebase-admin";
const { FieldValue } = firestore;

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

async function getNotificationTargets(
  data: FirebaseFirestore.DocumentData,
  usedBy: string
): Promise<string[]> {
  const ownerId = data.ownerId as string | undefined;
  const receiverIds = Array.isArray(data.receiverIds)
    ? (data.receiverIds as string[])
    : [];

  const participants = new Set<string>();

  if (ownerId) participants.add(ownerId);
  for (const receiverId of receiverIds) {
    if (receiverId) participants.add(receiverId);
  }

  participants.delete(usedBy);

  return [...participants];
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

    const ownerId = data.ownerId as string | undefined;
    const receiverIds = Array.isArray(data.receiverIds)
      ? (data.receiverIds as string[])
      : [];

    const isOwner = usedBy === ownerId;
    const isReceiver = receiverIds.includes(usedBy);

    if (!isOwner && !isReceiver) {
      return NextResponse.json(
        { error: "usedBy is not allowed to use this gifticon." },
        { status: 403 }
      );
    }

    // 닉네임은 없어도 사용 처리는 항상 진행
    const usedByDevice = await getDeviceInfo(usedBy);
    const usedByNickname = usedByDevice?.nickname?.trim() || null;

    await docRef.update({
      status: "used",
      usedBy,
      usedByNickname,
      usedAt: FieldValue.serverTimestamp(),
    });

    console.log(
      `[used] gifticonId=${gifticonId} marked as used by ${usedBy}, nickname=${usedByNickname}`
    );

    // owner + 다른 receivers에게 모두 알림
    const targetIds = await getNotificationTargets(data, usedBy);

    const targetInfos = await Promise.all(
      targetIds.map(async (deviceId) => {
        const info = await getDeviceInfo(deviceId);
        return {
          deviceId,
          fcmToken: info?.fcmToken?.trim() ?? "",
        };
      })
    );

    const validTargets = targetInfos.filter((t) => t.fcmToken);

    if (validTargets.length > 0) {
      const displayName = usedByNickname ? `${usedByNickname}님` : "누군가";

      const results = await Promise.allSettled(
        validTargets.map((target) =>
          messaging.send({
            token: target.fcmToken,
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
          })
        )
      );

      const successCount = results.filter(
        (result) => result.status === "fulfilled"
      ).length;

      const failCount = results.filter(
        (result) => result.status === "rejected"
      ).length;

      console.log(
        `[used] FCM sent: success=${successCount}, fail=${failCount}, targets=${validTargets.length}`
      );

      results.forEach((result, index) => {
        if (result.status === "rejected") {
          console.warn(
            `[used] FCM send failed for target=${validTargets[index].deviceId}:`,
            result.reason
          );
        }
      });
    } else {
      console.log(
        `[used] no valid target FCM tokens found for gifticonId=${gifticonId}`
      );
    }

    return NextResponse.json(
      {
        gifticonId,
        usedBy,
        usedByNickname,
        notifiedTargetIds: validTargets.map((t) => t.deviceId),
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("[/api/gifticons/used] error:", error);
    return NextResponse.json(
      { error: "Failed to mark gifticon as used." },
      { status: 500 }
    );
  }
}