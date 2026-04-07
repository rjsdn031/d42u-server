import { NextRequest, NextResponse } from "next/server";
import { shareGifticon, ShareGifticonInput } from "../../../../lib/gifticon-share";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    console.log("[/api/gifticons/share] request received");

    let body: ShareGifticonInput;
    try {
      body = (await req.json()) as ShareGifticonInput;
    } catch (jsonError) {
      console.warn("[/api/gifticons/share] invalid json body", jsonError);
      return NextResponse.json(
        { error: "Invalid JSON body." },
        { status: 400 }
      );
    }

    const {
      gifticonId,
      ownerId,
      imageBase64,
      expiresAt,
    } = body;

    if (!gifticonId || !ownerId || !imageBase64 || !expiresAt) {
      console.warn("[/api/gifticons/share] missing required fields", {
        gifticonId,
        ownerId,
        hasImageBase64: Boolean(imageBase64),
        expiresAt,
      });

      return NextResponse.json(
        { error: "gifticonId, ownerId, imageBase64, expiresAt are required." },
        { status: 400 }
      );
    }

    const result = await shareGifticon(body);

    console.log("[/api/gifticons/share] completed", result);
    return NextResponse.json(result, { status: result.alreadyShared ? 200 : 201 });
  } catch (error) {
    console.error("[/api/gifticons/share] error:", error);
    return NextResponse.json(
      { error: "Failed to share gifticon." },
      { status: 500 }
    );
  }
}