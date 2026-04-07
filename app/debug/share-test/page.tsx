"use client";

import { useState } from "react";

type TestShareResponse = {
  ok?: boolean;
  error?: string;
  sourceGifticonId?: string;
  testGifticonId?: string;
  result?: unknown;
};

const DebugShareTestPage = () => {
  const [gifticonId, setGifticonId] = useState("");
  const [secret, setSecret] = useState("");
  const [force, setForce] = useState(true);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TestShareResponse | null>(null);

  const handleSubmit = async () => {
    setLoading(true);
    setResult(null);

    try {
      const res = await fetch("/api/dev/test-share", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          gifticonId,
          secret,
          force,
        }),
      });

      const data = (await res.json()) as TestShareResponse;
      setResult(data);
    } catch (error) {
      setResult({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ maxWidth: 720, margin: "40px auto", padding: 24 }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>
        Gifticon Share Test
      </h1>

      <p style={{ marginBottom: 24, color: "#666" }}>
        기존 gifticon 문서를 기준으로 테스트용 복제 gifticon을 만들어 전체 공유를 강제 실행합니다.
      </p>

      <div style={{ display: "grid", gap: 12 }}>
        <label>
          <div style={{ marginBottom: 6 }}>Source gifticonId</div>
          <input
            value={gifticonId}
            onChange={(e) => setGifticonId(e.target.value)}
            placeholder="예: 123e4567-..."
            style={{ width: "100%", padding: 12 }}
          />
        </label>

        <label>
          <div style={{ marginBottom: 6 }}>Debug secret</div>
          <input
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="DEBUG_TEST_SECRET"
            style={{ width: "100%", padding: 12 }}
            type="password"
          />
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
          />
          clone test item and force share
        </label>

        <button
          onClick={handleSubmit}
          disabled={loading || !gifticonId || !secret}
          style={{
            padding: "12px 16px",
            fontWeight: 600,
            cursor: loading ? "default" : "pointer",
          }}
        >
          {loading ? "실행 중..." : "테스트 실행"}
        </button>
      </div>

      <pre
        style={{
          marginTop: 24,
          padding: 16,
          background: "#f5f5f5",
          overflowX: "auto",
          whiteSpace: "pre-wrap",
        }}
      >
        {result ? JSON.stringify(result, null, 2) : "결과가 여기 표시됩니다."}
      </pre>
    </main>
  );
};

export default DebugShareTestPage;