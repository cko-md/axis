import { NextRequest, NextResponse } from "next/server";

type ArticHit = {
  id: number;
  title: string;
  artist_display: string;
  date_display: string;
  image_id: string | null;
  medium_display: string;
  place_of_origin: string;
};

export async function GET(req: NextRequest) {
  const seed = parseInt(req.nextUrl.searchParams.get("seed") ?? "0", 10) || Math.floor(Date.now() / 86400000);
  const from = Math.abs(seed) % 2000;

  try {
    const url = new URL("https://api.artic.edu/api/v1/artworks/search");
    url.searchParams.set("q", "painting");
    url.searchParams.set("is_public_domain", "1");
    url.searchParams.set("fields", "id,title,artist_display,date_display,image_id,medium_display,place_of_origin");
    url.searchParams.set("limit", "1");
    url.searchParams.set("from", String(from));

    const res = await fetch(url.toString(), { next: { revalidate: 3600 } });
    if (!res.ok) throw new Error(`ARTIC ${res.status}`);

    const json = (await res.json()) as { data: ArticHit[] };
    const art = json.data?.[0];
    if (!art?.image_id) throw new Error("No image");

    const artist = art.artist_display?.split("\n")[0]?.trim() ?? "Unknown";

    return NextResponse.json(
      {
        id: art.id,
        title: art.title ?? "Untitled",
        artist,
        date: art.date_display,
        medium: art.medium_display,
        origin: art.place_of_origin,
        imageUrl: `https://www.artic.edu/iiif/2/${art.image_id}/full/600,/0/default.jpg`,
        artUrl: `https://www.artic.edu/artworks/${art.id}`,
      },
      { headers: { "Cache-Control": "s-maxage=3600, stale-while-revalidate=86400" } },
    );
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
