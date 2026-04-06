import { POST } from "@/app/api/gifticons/share/route";
import { db, bucket, messaging } from "@/lib/firebase";

jest.mock("@/lib/firebase", () => ({
  db: {
    collection: jest.fn(),
  },
  bucket: {
    name: "test-bucket",
    file: jest.fn(),
  },
  messaging: {
    send: jest.fn(),
  },
}));

const mockedDb = db as jest.Mocked<typeof db>;
const mockedBucket = bucket as jest.Mocked<typeof bucket>;
const mockedMessaging = messaging as jest.Mocked<typeof messaging>;

const makeReq = (body: unknown) =>
  new Request("http://localhost/api/gifticons/share", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const makeDocSnap = (exists: boolean, data?: Record<string, unknown>) => ({
  exists,
  id: data?.id ?? "doc-id",
  data: () => data,
});

describe("POST /api/gifticons/share", () => {
  const save = jest.fn();
  const makePublic = jest.fn();

  const devicesDocGet = jest.fn();
  const gifticonsDocGet = jest.fn();
  const gifticonsDocSet = jest.fn();
  const gifticonsDocUpdate = jest.fn();
  const devicesGet = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    save.mockResolvedValue(undefined);
    makePublic.mockResolvedValue(undefined);
    mockedBucket.file.mockReturnValue({
      save,
      makePublic,
    } as any);

    mockedMessaging.send.mockResolvedValue("message-id");

    mockedDb.collection.mockImplementation((name: string) => {
      if (name === "devices") {
        return {
          doc: jest.fn((id: string) => ({
            get: devicesDocGet,
          })),
          get: devicesGet,
        } as any;
      }

      if (name === "gifticons") {
        return {
          doc: jest.fn((id: string) => ({
            get: gifticonsDocGet,
            set: gifticonsDocSet,
            update: gifticonsDocUpdate,
          })),
        } as any;
      }

      throw new Error(`Unexpected collection: ${name}`);
    });
  });

  it("필수값이 없으면 400을 반환한다", async () => {
    const res = await POST(
      makeReq({
        gifticonId: "g1",
        ownerId: "owner-1",
        // imageBase64 누락
        expiresAt: "2026-04-10T00:00:00.000Z",
      }) as any
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "gifticonId, ownerId, imageBase64, expiresAt are required.",
    });
  });

  it("이미 공유된 기프티콘이면 alreadyShared=true 로 200을 반환한다", async () => {
    devicesDocGet.mockResolvedValueOnce(
      makeDocSnap(true, { nickname: "반짝이는수달" })
    );
    gifticonsDocGet.mockResolvedValueOnce(
      makeDocSnap(true, {
        imageUrl: "https://storage.googleapis.com/test-bucket/gifticons/g1.jpg",
        ownerNickname: "반짝이는수달",
      })
    );

    const res = await POST(
      makeReq({
        gifticonId: "g1",
        ownerId: "owner-1",
        imageBase64: "data:image/jpeg;base64,aGVsbG8=",
        expiresAt: "2026-04-10T00:00:00.000Z",
      }) as any
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      gifticonId: "g1",
      imageUrl: "https://storage.googleapis.com/test-bucket/gifticons/g1.jpg",
      ownerNickname: "반짝이는수달",
      alreadyShared: true,
    });

    expect(save).not.toHaveBeenCalled();
    expect(gifticonsDocSet).not.toHaveBeenCalled();
  });

  it("후보 디바이스가 없으면 업로드 후 matched=false 로 201을 반환한다", async () => {
    devicesDocGet.mockResolvedValueOnce(
      makeDocSnap(true, { nickname: "반짝이는수달" })
    );
    gifticonsDocGet.mockResolvedValueOnce(makeDocSnap(false));

    devicesGet.mockResolvedValueOnce({
      docs: [
        {
          id: "owner-1",
          data: () => ({
            fcmToken: "owner-token",
            nickname: "반짝이는수달",
          }),
        },
      ],
    });

    const res = await POST(
      makeReq({
        gifticonId: "g2",
        ownerId: "owner-1",
        imageBase64: "data:image/jpeg;base64,aGVsbG8=",
        merchantName: "스타벅스",
        itemName: "아메리카노",
        expiresAt: "2026-04-10T00:00:00.000Z",
      }) as any
    );

    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body).toMatchObject({
      gifticonId: "g2",
      ownerNickname: "반짝이는수달",
      matched: false,
      receiverId: null,
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(makePublic).toHaveBeenCalledTimes(1);
    expect(gifticonsDocSet).toHaveBeenCalledTimes(1);
    expect(gifticonsDocUpdate).not.toHaveBeenCalled();
    expect(mockedMessaging.send).not.toHaveBeenCalled();
  });

  it("후보가 있으면 matched=true, receiverId 를 반환하고 FCM을 보낸다", async () => {
    devicesDocGet.mockResolvedValueOnce(
      makeDocSnap(true, { nickname: "반짝이는수달" })
    );
    gifticonsDocGet.mockResolvedValueOnce(makeDocSnap(false));

    devicesGet.mockResolvedValueOnce({
      docs: [
        {
          id: "owner-1",
          data: () => ({
            fcmToken: "owner-token",
            nickname: "반짝이는수달",
          }),
        },
        {
          id: "receiver-1",
          data: () => ({
            fcmToken: "receiver-token",
            nickname: "포근한여우",
          }),
        },
      ],
    });

    const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0);

    const res = await POST(
      makeReq({
        gifticonId: "g3",
        ownerId: "owner-1",
        imageBase64: "data:image/jpeg;base64,aGVsbG8=",
        merchantName: "스타벅스",
        itemName: "아메리카노",
        couponNumber: "1234",
        expiresAt: "2026-04-10T00:00:00.000Z",
      }) as any
    );

    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body).toMatchObject({
      gifticonId: "g3",
      ownerNickname: "반짝이는수달",
      matched: true,
      receiverId: "receiver-1",
    });

    expect(gifticonsDocUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        receiverId: "receiver-1",
        receiverNickname: "포근한여우",
        status: "matched",
      })
    );

    expect(mockedMessaging.send).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "receiver-token",
        notification: expect.objectContaining({
          title: "기프티콘이 도착했어요 🎁",
        }),
        data: expect.objectContaining({
          type: "gifticon_received",
          gifticonId: "g3",
          ownerId: "owner-1",
          ownerNickname: "반짝이는수달",
        }),
      })
    );

    randomSpy.mockRestore();
  });

  it("FCM 전송이 실패해도 전체 요청은 성공한다", async () => {
    devicesDocGet.mockResolvedValueOnce(
      makeDocSnap(true, { nickname: "반짝이는수달" })
    );
    gifticonsDocGet.mockResolvedValueOnce(makeDocSnap(false));

    devicesGet.mockResolvedValueOnce({
      docs: [
        {
          id: "owner-1",
          data: () => ({
            fcmToken: "owner-token",
            nickname: "반짝이는수달",
          }),
        },
        {
          id: "receiver-1",
          data: () => ({
            fcmToken: "receiver-token",
            nickname: "포근한여우",
          }),
        },
      ],
    });

    mockedMessaging.send.mockRejectedValueOnce(new Error("FCM failed"));
    const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0);

    const res = await POST(
      makeReq({
        gifticonId: "g4",
        ownerId: "owner-1",
        imageBase64: "data:image/jpeg;base64,aGVsbG8=",
        expiresAt: "2026-04-10T00:00:00.000Z",
      }) as any
    );

    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body).toMatchObject({
      gifticonId: "g4",
      matched: true,
      receiverId: "receiver-1",
    });

    expect(gifticonsDocUpdate).toHaveBeenCalled();
    randomSpy.mockRestore();
  });
});