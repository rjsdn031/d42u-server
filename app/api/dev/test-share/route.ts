import { NextRequest, NextResponse } from "next/server";
import { db } from "../../../../lib/firebase";
import { shareGifticon } from "../../../../lib/gifticon-share";

export const runtime = "nodejs";

type TestShareRequest = {
  gifticonId?: string;
  secret?: string;
  force?: boolean;
};

function getBase64MimePrefix(imageUrl: string) {
  const lower = imageUrl.toLowerCase();
  if (lower.endsWith(".png")) return "data:image/png;base64,";
  if (lower.endsWith(".webp")) return "data:image/webp;base64,";
  return "data:image/jpeg;base64,";
}

export async function POST(req: NextRequest) {
  try {
    console.log("[/api/dev/test-share] request received");

    let body: TestShareRequest;
    try {
      body = (await req.json()) as TestShareRequest;
    } catch (jsonError) {
      console.warn("[/api/dev/test-share] invalid json body", jsonError);
      return NextResponse.json(
        { error: "Invalid JSON body." },
        { status: 400 }
      );
    }

    const { gifticonId, secret, force } = body;

    console.log("[/api/dev/test-share] parsed body", {
      gifticonId,
      hasSecret: Boolean(secret),
      force,
    });

    if (!process.env.DEBUG_TEST_SECRET) {
      return NextResponse.json(
        { error: "DEBUG_TEST_SECRET is not set." },
        { status: 500 }
      );
    }

    if (secret !== process.env.DEBUG_TEST_SECRET) {
      console.warn("[/api/dev/test-share] unauthorized");
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    if (!gifticonId) {
      return NextResponse.json(
        { error: "gifticonId is required." },
        { status: 400 }
      );
    }

    const doc = await db.collection("gifticons").doc(gifticonId).get();

    if (!doc.exists) {
      console.warn(`[/api/dev/test-share] gifticon not found id=${gifticonId}`);
      return NextResponse.json(
        { error: "Gifticon not found." },
        { status: 404 }
      );
    }

    const data = doc.data()!;

    console.log("[/api/dev/test-share] source gifticon loaded", {
      gifticonId,
      ownerId: data.ownerId ?? null,
      status: data.status ?? null,
      imageUrl: data.imageUrl ?? null,
      merchantName: data.merchantName ?? null,
      itemName: data.itemName ?? null,
      expiresAt:
        typeof data.expiresAt?.toDate === "function"
          ? data.expiresAt.toDate().toISOString()
          : data.expiresAt ?? null,
      receiverIds: Array.isArray(data.receiverIds) ? data.receiverIds : [],
    });

    if (data.status === "used") {
      return NextResponse.json(
        { error: "Used gifticon cannot be shared again in test mode." },
        { status: 400 }
      );
    }

    if (data.status === "shared" && force !== true) {
      return NextResponse.json(
        {
          error: "Gifticon is already shared. Pass force=true only if you intentionally want to retry with a cloned test item.",
        },
        { status: 400 }
      );
    }

    const imageUrl = data.imageUrl as string | undefined;
    if (!imageUrl) {
      return NextResponse.json(
        { error: "imageUrl is missing in source gifticon." },
        { status: 400 }
      );
    }

    console.log("[/api/dev/test-share] downloading source image", { gifticonId, imageUrl });

    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      console.error("[/api/dev/test-share] image download failed", {
        gifticonId,
        status: imageResponse.status,
      });

      return NextResponse.json(
        { error: "Failed to download source image." },
        { status: 502 }
      );
    }

    const imageArrayBuffer = await imageResponse.arrayBuffer();
    const imageBase64 = Buffer.from(imageArrayBuffer).toString("base64");
    const imageBase64WithPrefix = `${getBase64MimePrefix(imageUrl)}${imageBase64}`;

    const testGifticonId = `${gifticonId}-test-${Date.now()}`;

    const expiresAt =
      typeof data.expiresAt?.toDate === "function"
        ? data.expiresAt.toDate().toISOString()
        : typeof data.expiresAt === "string"
          ? data.expiresAt
          : null;

    if (!data.ownerId || !expiresAt) {
      return NextResponse.json(
        { error: "ownerId or expiresAt is missing in source gifticon." },
        { status: 400 }
      );
    }

    console.log("[/api/dev/test-share] invoking shared core", {
      sourceGifticonId: gifticonId,
      testGifticonId,
      ownerId: data.ownerId,
      force,
    });

    const result = await shareGifticon({
      gifticonId: testGifticonId,
      ownerId: data.ownerId,
      imageBase64: imageBase64WithPrefix,
      merchantName: data.merchantName ?? null,
      itemName: data.itemName ?? null,
      couponNumber: data.couponNumber ?? null,
      expiresAt,
    });

    console.log("[/api/dev/test-share] completed", {
      sourceGifticonId: gifticonId,
      testGifticonId,
      matched: result.matched,
      receiverIds: result.receiverIds,
    });

    return NextResponse.json(
      {
        ok: true,
        sourceGifticonId: gifticonId,
        testGifticonId,
        result,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("[/api/dev/test-share] error:", error);
    return NextResponse.json(
      { error: "Failed to run test share." },
      { status: 500 }
    );
  }
}