import { POST } from "@/app/api/gifticons/used/route";
import { db, messaging } from "@/lib/firebase";

jest.mock("@/lib/firebase", () => ({
  db: {
    collection: jest.fn(),
  },
  messaging: {
    send: jest.fn(),
  },
}));

const mockedDb = db as jest.Mocked<typeof db>;
const mockedMessaging = messaging as jest.Mocked<typeof messaging>;

const makeReq = (body: unknown) =>
  new Request("http://localhost/api/gifticons/used", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const makeDocSnap = (exists: boolean, data?: Record<string, unknown>) => ({
  exists,
  data: () => data,
});

describe("POST /api/gifticons/used", () => {
  const gifticonGet = jest.fn();
  const gifticonUpdate = jest.fn();
  const deviceGet = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    mockedMessaging.send.mockResolvedValue("message-id");

    mockedDb.collection.mockImplementation((name: string) => {
      if (name === "gifticons") {
        return {
          doc: jest.fn(() => ({
            get: gifticonGet,
            update: gifticonUpdate,
          })),
        } as any;
      }

      if (name === "devices") {
        return {
          doc: jest.fn(() => ({
            get: deviceGet,
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
      }) as any
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "gifticonId and usedBy are required.",
    });
  });

  it("기프티콘이 없으면 404를 반환한다", async () => {
    gifticonGet.mockResolvedValueOnce(makeDocSnap(false));

    const res = await POST(
      makeReq({
        gifticonId: "missing",
        usedBy: "device-a",
      }) as any
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: "Gifticon not found.",
    });
  });

  it("이미 사용된 기프티콘이면 alreadyUsed=true 로 200을 반환한다", async () => {
    gifticonGet.mockResolvedValueOnce(
      makeDocSnap(true, {
        status: "used",
      })
    );

    const res = await POST(
      makeReq({
        gifticonId: "g2",
        usedBy: "device-a",
      }) as any
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      gifticonId: "g2",
      alreadyUsed: true,
    });

    expect(gifticonUpdate).not.toHaveBeenCalled();
  });

  it("정상 사용 시 used 상태와 nickname을 업데이트한다", async () => {
    gifticonGet.mockResolvedValueOnce(
      makeDocSnap(true, {
        ownerId: "owner-1",
        receiverId: "receiver-1",
        itemName: "아메리카노",
        status: "matched",
      })
    );

    deviceGet
      .mockResolvedValueOnce(
        makeDocSnap(true, {
          nickname: "포근한여우",
          fcmToken: "receiver-token",
        })
      )
      .mockResolvedValueOnce(
        makeDocSnap(true, {
          nickname: "반짝이는수달",
          fcmToken: "owner-token",
        })
      );

    const res = await POST(
      makeReq({
        gifticonId: "g3",
        usedBy: "receiver-1",
      }) as any
    );

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({
      gifticonId: "g3",
      usedBy: "receiver-1",
      usedByNickname: "포근한여우",
    });

    expect(gifticonUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "used",
        usedBy: "receiver-1",
        usedByNickname: "포근한여우",
      })
    );
  });

  it("상대방 토큰이 있으면 FCM을 보낸다", async () => {
    gifticonGet.mockResolvedValueOnce(
      makeDocSnap(true, {
        ownerId: "owner-1",
        receiverId: "receiver-1",
        itemName: "아메리카노",
        status: "matched",
      })
    );

    deviceGet
      .mockResolvedValueOnce(
        makeDocSnap(true, {
          nickname: "포근한여우",
          fcmToken: "receiver-token",
        })
      )
      .mockResolvedValueOnce(
        makeDocSnap(true, {
          nickname: "반짝이는수달",
          fcmToken: "owner-token",
        })
      );

    const res = await POST(
      makeReq({
        gifticonId: "g4",
        usedBy: "receiver-1",
      }) as any
    );

    expect(res.status).toBe(200);
    expect(mockedMessaging.send).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "owner-token",
        notification: expect.objectContaining({
          title: "기프티콘이 사용되었어요",
        }),
        data: expect.objectContaining({
          type: "gifticon_used",
          gifticonId: "g4",
          usedBy: "receiver-1",
          usedByNickname: "포근한여우",
        }),
      })
    );
  });

  it("FCM 전송이 실패해도 전체 요청은 성공한다", async () => {
    gifticonGet.mockResolvedValueOnce(
      makeDocSnap(true, {
        ownerId: "owner-1",
        receiverId: "receiver-1",
        itemName: "아메리카노",
        status: "matched",
      })
    );

    deviceGet
      .mockResolvedValueOnce(
        makeDocSnap(true, {
          nickname: "포근한여우",
          fcmToken: "receiver-token",
        })
      )
      .mockResolvedValueOnce(
        makeDocSnap(true, {
          nickname: "반짝이는수달",
          fcmToken: "owner-token",
        })
      );

    mockedMessaging.send.mockRejectedValueOnce(new Error("FCM failed"));

    const res = await POST(
      makeReq({
        gifticonId: "g5",
        usedBy: "receiver-1",
      }) as any
    );

    expect(res.status).toBe(200);
    expect(gifticonUpdate).toHaveBeenCalled();
  });
});