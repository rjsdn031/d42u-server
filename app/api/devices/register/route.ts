import { NextRequest, NextResponse } from "next/server";
import { db } from "../../../../lib/firebase";
import { firestore } from "firebase-admin";
const { FieldValue } = firestore;

export const runtime = "nodejs";

type RegisterDeviceRequest = {
  deviceId: string;
  fcmToken: string;
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

    await db.collection("devices").doc(deviceId).set(
      {
        fcmToken,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true } // 이미 있으면 토큰만 갱신
    );

    console.log(`[devices/register] deviceId=${deviceId}`);

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error("[/api/devices/register] error:", error);
    return NextResponse.json(
      { error: "Failed to register device." },
      { status: 500 }
    );
  }
}