import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { VectorGamePlatformLazy } from "@/components/vector/VectorGamePlatformLazy";
import { getVectorGame, VECTOR_GAME_REGISTRY } from "@/lib/vector/registry";

type Props = {
  params: Promise<{ game: string }>;
};

export function generateStaticParams() {
  return VECTOR_GAME_REGISTRY.map((game) => ({ game: game.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { game: slug } = await params;
  const game = getVectorGame(slug);
  if (!game) return { title: "Unknown game · VECTOR · Axis" };
  return {
    title: `${game.title} · VECTOR · Axis`,
    description: game.shortDescription,
  };
}

export default async function VectorGamePage({ params }: Props) {
  const { game: slug } = await params;
  const game = getVectorGame(slug);
  if (!game) notFound();

  return (
    <AppShell section="Labs" page={game.title} suppressPresence>
      <VectorGamePlatformLazy gameId={game.id} />
    </AppShell>
  );
}
