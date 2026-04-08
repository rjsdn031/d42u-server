import * as admin from "firebase-admin";

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY is not set.");
  }

  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error("[firebase] failed to JSON.parse FIREBASE_SERVICE_ACCOUNT_KEY", {
      rawLength: raw.length,
      rawPreview: raw.slice(0, 120),
      error,
    });
    throw new Error("Invalid FIREBASE_SERVICE_ACCOUNT_KEY JSON.");
  }

  const serviceAccount = {
    projectId: parsed.project_id as string,
    clientEmail: parsed.client_email as string,
    privateKey: (parsed.private_key as string)?.replace(/\\n/g, "\n"),
  };

  if (
    !serviceAccount.projectId ||
    !serviceAccount.clientEmail ||
    !serviceAccount.privateKey
  ) {
    console.error("[firebase] missing required service account fields", {
      hasProjectId: Boolean(serviceAccount.projectId),
      hasClientEmail: Boolean(serviceAccount.clientEmail),
      hasPrivateKey: Boolean(serviceAccount.privateKey),
    });
    throw new Error("Invalid Firebase service account fields.");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });

  console.log("[firebase] admin initialized", {
    projectId: serviceAccount.projectId,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET ?? null,
  });
}

export const db = admin.firestore();
export const messaging = admin.messaging();
export const bucket = admin.storage().bucket();