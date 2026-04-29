import crypto from "crypto";
import { WebsiteArtifactKind } from "@/lib/types";

const DEFAULT_ATTACHMENT_EXPIRY_SECONDS = 20 * 60;

interface V0AttachmentTokenPayload {
  s: string;
  j: string;
  k: WebsiteArtifactKind;
  exp: number;
}

function getSigningSecret() {
  return (
    process.env.V0_ATTACHMENT_SIGNING_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.V0_API_KEY ||
    ""
  );
}

function getAppBaseUrl() {
  const raw =
    process.env.APP_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  return raw.replace(/\/+$/, "");
}

function signTokenBody(body: string) {
  const secret = getSigningSecret();
  if (!secret) {
    throw new Error("V0 attachment signing secret is not configured.");
  }

  return crypto.createHmac("sha256", secret).update(body).digest("base64url");
}

export function createV0WebsiteArtifactAttachmentUrl({
  sessionId,
  jobId,
  artifactKind,
  expiresInSeconds = DEFAULT_ATTACHMENT_EXPIRY_SECONDS
}: {
  sessionId: string;
  jobId: string;
  artifactKind: WebsiteArtifactKind;
  expiresInSeconds?: number;
}) {
  const baseUrl = getAppBaseUrl();
  if (!baseUrl) {
    return null;
  }

  const payload: V0AttachmentTokenPayload = {
    s: sessionId,
    j: jobId,
    k: artifactKind,
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = signTokenBody(body);
  return `${baseUrl}/api/v0-attachments/website/${body}.${signature}`;
}

export function verifyV0WebsiteArtifactAttachmentToken(token: string) {
  const [body, signature] = token.split(".");
  if (!body || !signature) {
    return null;
  }

  const expectedSignature = signTokenBody(body);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  let payload: V0AttachmentTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as V0AttachmentTokenPayload;
  } catch {
    return null;
  }

  if (!payload.s || !payload.j || !payload.k || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }

  if (payload.k !== "previewImage") {
    return null;
  }

  return {
    sessionId: payload.s,
    jobId: payload.j,
    artifactKind: payload.k
  };
}
