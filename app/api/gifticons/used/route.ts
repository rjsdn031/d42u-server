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
  if (!deviceDoc.exists) {
    console.log(`[used/device] device not found deviceId=${deviceId}`);
    return null;
  }

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
    console.log("[/api/gifticons/used] request received");

    let body: UsedGifticonRequest;
    try {
      body = (await req.json()) as UsedGifticonRequest;
    } catch (jsonError) {
      console.warn("[/api/gifticons/used] invalid json body", jsonError);
      return NextResponse.json(
        { error: "Invalid JSON body." },
        { status: 400 }
      );
    }

    const { gifticonId, usedBy } = body;

    console.log("[/api/gifticons/used] parsed body", {
      gifticonId,
      usedBy,
    });

    if (!gifticonId || !usedBy) {
      console.warn("[/api/gifticons/used] missing required fields", {
        gifticonId,
        usedBy,
      });

      return NextResponse.json(
        { error: "gifticonId and usedBy are required." },
        { status: 400 }
      );
    }

    const docRef = db.collection("gifticons").doc(gifticonId);
    console.log(`[/api/gifticons/used] loading gifticon doc gifticonId=${gifticonId}`);
    const doc = await docRef.get();

    if (!doc.exists) {
      console.warn(`[/api/gifticons/used] gifticon not found gifticonId=${gifticonId}`);
      return NextResponse.json(
        { error: "Gifticon not found." },
        { status: 404 }
      );
    }

    const data = doc.data()!;

    console.log("[/api/gifticons/used] gifticon loaded", {
      gifticonId,
      status: data.status,
      ownerId: data.ownerId,
      receiverIds: Array.isArray(data.receiverIds) ? data.receiverIds : [],
      itemName: data.itemName ?? null,
    });

    if (data.status === "used") {
      console.log(`[/api/gifticons/used] already used gifticonId=${gifticonId}`);
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

    console.log("[/api/gifticons/used] permission check", {
      gifticonId,
      usedBy,
      ownerId,
      receiverIds,
      isOwner,
      isReceiver,
    });

    if (!isOwner && !isReceiver) {
      console.warn("[/api/gifticons/used] unauthorized usedBy", {
        gifticonId,
        usedBy,
      });

      return NextResponse.json(
        { error: "usedBy is not allowed to use this gifticon." },
        { status: 403 }
      );
    }

    const usedByDevice = await getDeviceInfo(usedBy);
    const usedByNickname = usedByDevice?.nickname?.trim() || null;

    console.log("[/api/gifticons/used] actor info", {
      usedBy,
      usedByNickname,
      hasActorToken: Boolean(usedByDevice?.fcmToken),
    });

    await docRef.update({
      status: "used",
      usedBy,
      usedByNickname,
      usedAt: FieldValue.serverTimestamp(),
    });

    console.log("[/api/gifticons/used] marked as used", {
      gifticonId,
      usedBy,
      usedByNickname,
    });

    const targetIds = await getNotificationTargets(data, usedBy);

    console.log("[/api/gifticons/used] notification targets resolved", {
      gifticonId,
      targetIds,
    });

    const targetInfos = await Promise.all(
      targetIds.map(async (deviceId) => {
        const info = await getDeviceInfo(deviceId);
        return {
          deviceId,
          fcmToken: info?.fcmToken?.trim() ?? "",
          nickname: info?.nickname?.trim() ?? "",
        };
      })
    );

    console.log("[/api/gifticons/used] target infos", {
      gifticonId,
      targets: targetInfos.map((t) => ({
        deviceId: t.deviceId,
        hasToken: Boolean(t.fcmToken),
        nickname: t.nickname || null,
      })),
    });

    const validTargets = targetInfos.filter((t) => t.fcmToken);

    if (validTargets.length > 0) {
      const displayName = usedByNickname ? `${usedByNickname}님` : "누군가";

      const results = await Promise.allSettled(
        validTargets.map(async (target) => {
          console.log("[used/fcm] sending", {
            gifticonId,
            targetId: target.deviceId,
          });

          const messageId = await messaging.send({
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
          });

          console.log("[used/fcm] sent", {
            gifticonId,
            targetId: target.deviceId,
            messageId,
          });

          return { targetId: target.deviceId, messageId };
        })
      );

      const successCount = results.filter(
        (result) => result.status === "fulfilled"
      ).length;

      const failCount = results.filter(
        (result) => result.status === "rejected"
      ).length;

      console.log("[used/fcm] summary", {
        gifticonId,
        successCount,
        failCount,
        total: validTargets.length,
      });

      results.forEach((result, index) => {
        if (result.status === "rejected") {
          console.warn("[used/fcm] failed", {
            gifticonId,
            targetId: validTargets[index].deviceId,
            reason: result.reason,
          });
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