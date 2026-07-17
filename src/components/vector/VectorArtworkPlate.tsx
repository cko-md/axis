import Image from "next/image";
import type { VectorGameManifest } from "@/lib/vector/types";
import styles from "./Vector.module.css";

const MOTIF_INDEX: Record<VectorGameManifest["visualMotif"], string> = {
  dial: "01",
  ascent: "02",
  orbit: "03",
  flight: "04",
  arena: "05",
  rune: "06",
  biome: "07",
  blocks: "08",
  rift: "09",
};

export function VectorArtworkPlate({
  game,
  compact = false,
}: {
  game: VectorGameManifest;
  compact?: boolean;
}) {
  const artwork = compact ? game.cover : game.preview;
  if (artwork.status === "ready") {
    return (
      <div
        className={`${styles.artworkPlate}${compact ? ` ${styles.artworkPlateCompact}` : ""}`}
        data-artwork-status="ready"
        data-motif={game.visualMotif}
      >
        <Image
          src={artwork.src}
          alt={artwork.alt}
          fill
          sizes={compact ? "92px" : "(max-width: 820px) 100vw, 46vw"}
          style={{ objectFit: "cover" }}
        />
      </div>
    );
  }

  return (
    <div
      className={`${styles.artworkPlate}${compact ? ` ${styles.artworkPlateCompact}` : ""}`}
      data-artwork-status="planned"
      data-motif={game.visualMotif}
      aria-label={artwork.alt}
      role="img"
    >
      <div className={styles.artworkGrid} aria-hidden="true" />
      <div className={styles.artworkOrbit} aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className={styles.artworkSignal} aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </div>
      <span className={styles.artworkIndex} aria-hidden="true">{MOTIF_INDEX[game.visualMotif]}</span>
      <div className={styles.artworkCaption}>
        <span>Concept plate</span>
        <strong>Cover follows playable proof</strong>
      </div>
    </div>
  );
}
