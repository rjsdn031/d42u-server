import { NextRequest, NextResponse } from "next/server";
import { db } from "../../../../lib/firebase";
import { firestore } from "firebase-admin";
import { adjectives, animals } from "../../../../lib/nickname-words";

const { FieldValue } = firestore;

export const runtime = "nodejs";

type RegisterDeviceRequest = {
  deviceId: string;
  fcmToken: string;
  shareEnabled?: boolean;
};

const generateNickname = () => {
  const adjective =
    adjectives[Math.floor(Math.random() * adjectives.length)];
  const animal = animals[Math.floor(Math.random() * animals.length)];
  return `${adjective}${animal}`;
};

const generateUniqueNickname = async () => {
  for (let i = 0; i < 20; i++) {
    const candidate = generateNickname();

    console.log(`[devices/register][nickname] try=${i + 1} candidate=${candidate}`);

    const snapshot = await db
      .collection("devices")
      .where("nickname", "==", candidate)
      .limit(1)
      .get();

    if (snapshot.empty) {
      console.log(`[devices/register][nickname] selected=${candidate}`);
      return candidate;
    }

    console.log(`[devices/register][nickname] duplicate=${candidate}`);
  }

  throw new Error("Failed to generate unique nickname.");
};

export async function POST(req: NextRequest) {
  try {
    console.log("[/api/devices/register] request received");

    let body: RegisterDeviceRequest;
    try {
      body = (await req.json()) as RegisterDeviceRequest;
    } catch (jsonError) {
      console.warn("[/api/devices/register] invalid json body", jsonError);
      return NextResponse.json(
        { error: "Invalid JSON body." },
        { status: 400 }
      );
    }

    const { deviceId, fcmToken, shareEnabled } = body;

    console.log("[/api/devices/register] parsed body", {
      hasDeviceId: Boolean(deviceId),
      hasFcmToken: Boolean(fcmToken),
      deviceId,
      fcmTokenLength: fcmToken?.length ?? 0,
      shareEnabled,
    });

    if (!deviceId || !fcmToken) {
      console.warn("[/api/devices/register] missing required fields", {
        deviceId,
        hasFcmToken: Boolean(fcmToken),
      });

      return NextResponse.json(
        { error: "deviceId and fcmToken are required." },
        { status: 400 }
      );
    }

    const docRef = db.collection("devices").doc(deviceId);

    console.log(`[/api/devices/register] reading device doc: deviceId=${deviceId}`);
    const snap = await docRef.get();

    let nickname: string;
    let nicknameSource: "existing" | "generated";

    if (snap.exists && snap.data()?.nickname) {
      nickname = snap.data()!.nickname as string;
      nicknameSource = "existing";
      console.log(
        `[/api/devices/register] existing device found: deviceId=${deviceId}, nickname=${nickname}`
      );
    } else {
      nickname = await generateUniqueNickname();
      nicknameSource = "generated";
      console.log(
        `[/api/devices/register] new nickname generated: deviceId=${deviceId}, nickname=${nickname}`
      );
    }

    await docRef.set(
      {
        fcmToken,
        nickname,
        shareEnabled: shareEnabled === true,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    console.log("[/api/devices/register] device saved", {
      deviceId,
      nickname,
      nicknameSource,
      fcmTokenLength: fcmToken.length,
      shareEnabled: shareEnabled === true,
    });

    return NextResponse.json(
      {
        ok: true,
        deviceId,
        nickname,
        shareEnabled: shareEnabled === true,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("[/api/devices/register] error:", error);
    return NextResponse.json(
      { error: "Failed to register device." },
      { status: 500 }
    );
  }
}