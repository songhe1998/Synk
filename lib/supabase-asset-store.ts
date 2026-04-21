import path from "path";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseStorageBucket } from "@/lib/supabase/config";
import { normalizeSupabaseError } from "@/lib/supabase/errors";

export interface StoredBinaryAsset {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  storagePath: string;
}

export interface BinaryAssetRecord {
  session_id: string;
  kind: string;
  storage_path: string;
  file_name: string;
  mime_type: string | null;
  bytes: number | null;
}

function normalizeStoragePath(storagePath: string) {
  return storagePath.replace(/^\/+/, "");
}

export async function uploadSessionBinaryAsset({
  userId,
  sessionId,
  kind,
  fileName,
  mimeType,
  buffer
}: {
  userId: string;
  sessionId: string;
  kind: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}) {
  const admin = getSupabaseAdminClient();
  const bucket = getSupabaseStorageBucket();
  const storagePath = normalizeStoragePath(path.posix.join(userId, sessionId, fileName));

  const { error: uploadError } = await admin.storage.from(bucket).upload(storagePath, buffer, {
    contentType: mimeType,
    upsert: true
  });

  if (uploadError) {
    throw normalizeSupabaseError(uploadError);
  }

  const { error: assetError } = await admin.from("session_assets").upsert(
    {
      session_id: sessionId,
      kind,
      storage_path: storagePath,
      file_name: fileName,
      mime_type: mimeType,
      bytes: buffer.byteLength
    },
    {
      onConflict: "session_id,kind"
    }
  );

  if (assetError) {
    throw normalizeSupabaseError(assetError);
  }

  return storagePath;
}

export async function readSessionBinaryAsset(storagePath: string, fileName: string, mimeType: string | null) {
  const admin = getSupabaseAdminClient();
  const bucket = getSupabaseStorageBucket();
  const { data, error } = await admin.storage.from(bucket).download(storagePath);

  if (error || !data) {
    return null;
  }

  const arrayBuffer = await data.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    fileName,
    mimeType: mimeType || "application/octet-stream",
    storagePath
  } satisfies StoredBinaryAsset;
}
