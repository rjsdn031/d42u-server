import { NextRequest, NextResponse } from "next/server";
import { db } from "../../../../lib/firebase";
import { firestore } from "firebase-admin";
const { FieldValue } = firestore;

export const runtime = "nodejs";

type RegisterDeviceRequest = {
  deviceId: string;
  fcmToken: string;
};

const adjectives = ["반짝이는", "포근한", "용감한", "재빠른", "행복한"];
const animals = ["수달", "고양이", "토끼", "여우", "참새"];

const generateNickname = () => {
  const adjective =
    adjectives[Math.floor(Math.random() * adjectives.length)];
  const animal = animals[Math.floor(Math.random() * animals.length)];
  return `${adjective}${animal}`;
};

export async function POST(req: NextRequest) {
  try {
    let body: RegisterDeviceRequest;
    try {
      body = (await req.json()) as RegisterDeviceRequest;
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body." },
        { status: 400 }
      );
    }

    const { deviceId, fcmToken } = body;

    if (!deviceId || !fcmToken) {
      return NextResponse.json(
        { error: "deviceId and fcmToken are required." },
        { status: 400 }
      );
    }

    const docRef = db.collection("devices").doc(deviceId);
    const snap = await docRef.get();

    let nickname: string;

    if (snap.exists && snap.data()?.nickname) {
      nickname = snap.data()!.nickname as string;
    } else {
      nickname = generateNickname();
    }

    await docRef.set(
      {
        fcmToken,
        nickname,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    console.log(`[devices/register] deviceId=${deviceId}, nickname=${nickname}`);

    return NextResponse.json(
      {
        ok: true,
        deviceId,
        nickname,
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