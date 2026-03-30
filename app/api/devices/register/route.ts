import { NextRequest, NextResponse } from "next/server";
import { db } from "../../../../lib/firebase";
import { FieldValue } from "firebase-admin/firestore";

export const runtime = "nodejs";

type RegisterDeviceRequest = {
  deviceId: string;
  fcmToken: string;
};

const ADJECTIVES = [
  "용감한", "고요한", "반짝이는", "날쌘", "다정한",
  "명랑한", "든든한", "영리한", "재빠른", "포근한",
  // TODO: 50개로 확장
];

const ANIMALS = [
  "여우", "수달", "늑대", "토끼", "고양이",
  "강아지", "판다", "부엉이", "호랑이", "펭귄",
  // TODO: 50개로 확장
];

const randomItem = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];

const makeBaseNickname = () => `${randomItem(ADJECTIVES)}${randomItem(ANIMALS)}`;

const isNicknameTaken = async (nickname: string): Promise<boolean> => {
  const snap = await db
    .collection("devices")
    .where("nickname", "==", nickname)
    .limit(1)
    .get();

  return !snap.empty;
};

const generateUniqueNickname = async (): Promise<string> => {
  for (let i = 0; i < 20; i++) {
    const candidate = makeBaseNickname();
    if (!(await isNicknameTaken(candidate))) {
      return candidate;
    }
  }

  for (let i = 0; i < 100; i++) {
    const candidate = `${makeBaseNickname()}${Math.floor(10 + Math.random() * 9999)}`;
    if (!(await isNicknameTaken(candidate))) {
      return candidate;
    }
  }

  throw new Error("Failed to generate unique nickname");
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

    const deviceRef = db.collection("devices").doc(deviceId);
    const existingSnap = await deviceRef.get();
    const existingData = existingSnap.data() as
      | { nickname?: string; fcmToken?: string }
      | undefined;

    let nickname = existingData?.nickname;

    if (!nickname) {
      nickname = await generateUniqueNickname();
    }

    if (!existingSnap.exists) {
      await deviceRef.set({
        deviceId,
        fcmToken,
        nickname,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      await deviceRef.set(
        {
          deviceId,
          fcmToken,
          nickname,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

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