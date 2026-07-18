import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { redactRouteError } from "@/lib/observability/redactRouteError";

const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file" }, { status: 400 });

  if (file.size > MAX_AVATAR_BYTES) {
    return NextResponse.json({ error: "File too large (max 5 MB)" }, { status: 413 });
  }
  const ext = ALLOWED_MIME_TO_EXT[file.type];
  if (!ext) {
    return NextResponse.json(
      { error: "Unsupported file type — use JPEG, PNG, or WebP" },
      { status: 415 },
    );
  }

  const path = `${user.id}/avatar.${ext}`;

  const { error } = await supabase.storage
    .from("avatars")
    .upload(path, file, { upsert: true, contentType: file.type });

  if (error) return redactRouteError(error, { route: "profile/avatar", area: "profile" });

  const { data: { publicUrl } } = supabase.storage.from("avatars").getPublicUrl(path);

  // bust the CDN cache by appending a timestamp
  const url = `${publicUrl}?t=${Date.now()}`;
  return NextResponse.json({ url });
}
