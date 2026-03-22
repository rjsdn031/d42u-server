import OpenAI from "openai";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type ParseGifticonRequest = {
  rawText?: string;
};

type GifticonParseResult = {
  merchantName: string | null;
  itemName: string | null;
  expiresAt: string | null;
  couponNumber: string | null;
};

const gifticonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    merchantName: { type: ["string", "null"] },
    itemName: { type: ["string", "null"] },
    expiresAt: { type: ["string", "null"] },
    couponNumber: { type: ["string", "null"] },
  },
  required: ["merchantName", "itemName", "expiresAt", "couponNumber"],
} as const;

export async function POST(req: NextRequest) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY is not set." },
        { status: 500 }
      );
    }

    let body: ParseGifticonRequest;

    try {
      body = (await req.json()) as ParseGifticonRequest;
    } catch {
      return NextResponse.json(
        { error: "Invalid or empty JSON body." },
        { status: 400 }
      );
    }

    const rawText = body.rawText?.trim();

    if (!rawText) {
      return NextResponse.json(
        { error: "rawText is required." },
        { status: 400 }
      );
    }

    const response = await client.responses.create({
      model: "gpt-5-nano",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "너는 한국 모바일 기프티콘 OCR 텍스트에서 정보를 추출하는 파서다. " +
                "주어진 OCR 원문만 보고 merchantName, itemName, expiresAt, couponNumber를 추출하라. " +
                "불확실하면 null로 반환하라. " +
                "추측하지 말고, OCR에 없는 내용을 지어내지 마라. " +
                "expiresAt은 날짜가 분명할 때만 ISO 8601 문자열로 반환하라. " +
                "날짜만 보이면 해당 날짜의 한국 시간 23:59:59로 맞춰도 된다.",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `다음 OCR 텍스트를 파싱해라:\n\n${rawText}`,
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "gifticon_parse_result",
          schema: gifticonSchema,
          strict: true,
        },
      },
    });

    const outputText = response.output_text?.trim();

    if (!outputText) {
      return NextResponse.json(
        { error: "Model returned empty output." },
        { status: 502 }
      );
    }

    const parsed = JSON.parse(outputText) as GifticonParseResult;

    return NextResponse.json(parsed, { status: 200 });
  } catch (error) {
    console.error("[/api/gifticons/parse] error:", error);

    return NextResponse.json(
      { error: "Failed to parse gifticon text." },
      { status: 500 }
    );
  }
}