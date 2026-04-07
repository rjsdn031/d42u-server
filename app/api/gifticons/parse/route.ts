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
    console.log("[/api/gifticons/parse] request received");

    if (!process.env.OPENAI_API_KEY) {
      console.error("[/api/gifticons/parse] OPENAI_API_KEY is missing");
      return NextResponse.json(
        { error: "OPENAI_API_KEY is not set." },
        { status: 500 }
      );
    }

    let body: ParseGifticonRequest;

    try {
      body = (await req.json()) as ParseGifticonRequest;
      console.log("[/api/gifticons/parse] raw body parsed", {
        hasRawText: Boolean(body.rawText),
        rawTextLength: body.rawText?.length ?? 0,
        rawTextPreview: body.rawText?.slice(0, 120) ?? "",
      });
    } catch (jsonError) {
      console.warn("[/api/gifticons/parse] invalid or empty JSON body", jsonError);
      return NextResponse.json(
        { error: "Invalid or empty JSON body." },
        { status: 400 }
      );
    }

    const rawText = body.rawText?.trim();

    console.log("[/api/gifticons/parse] normalized rawText", {
      hasRawText: Boolean(rawText),
      rawTextLength: rawText?.length ?? 0,
      rawTextPreview: rawText?.slice(0, 120) ?? "",
    });

    if (!rawText) {
      console.warn("[/api/gifticons/parse] rawText is missing after trim");
      return NextResponse.json(
        { error: "rawText is required." },
        { status: 400 }
      );
    }

    console.log("[/api/gifticons/parse] calling OpenAI responses.create", {
      model: "gpt-5-nano",
      rawTextLength: rawText.length,
    });

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

    console.log("[/api/gifticons/parse] OpenAI response received", {
      hasOutputText: Boolean(response.output_text),
      outputTextLength: response.output_text?.length ?? 0,
      outputTextPreview: response.output_text?.slice(0, 200) ?? "",
    });

    const outputText = response.output_text?.trim();

    if (!outputText) {
      console.warn("[/api/gifticons/parse] model returned empty output");
      return NextResponse.json(
        { error: "Model returned empty output." },
        { status: 502 }
      );
    }

    let parsed: GifticonParseResult;

    try {
      parsed = JSON.parse(outputText) as GifticonParseResult;
    } catch (parseError) {
      console.error("[/api/gifticons/parse] failed to JSON.parse outputText", {
        outputText,
        parseError,
      });

      return NextResponse.json(
        { error: "Model returned invalid JSON." },
        { status: 502 }
      );
    }

    console.log("[/api/gifticons/parse] parsed result", {
      merchantName: parsed.merchantName,
      itemName: parsed.itemName,
      expiresAt: parsed.expiresAt,
      hasCouponNumber: Boolean(parsed.couponNumber),
      couponNumberLength: parsed.couponNumber?.length ?? 0,
    });

    return NextResponse.json(parsed, { status: 200 });
  } catch (error) {
    console.error("[/api/gifticons/parse] error:", error);

    return NextResponse.json(
      { error: "Failed to parse gifticon text." },
      { status: 500 }
    );
  }
}