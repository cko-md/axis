"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";

type Props = {
  offer: {
    saves: number;
    events: number;
    collisions: number;
  } | null;
  onAccept: () => Promise<void>;
  onDecline: () => void;
  motion?: "standard" | "reduced";
};

export function VectorAdoptionModal({ offer, onAccept, onDecline, motion }: Props) {
  const [working, setWorking] = useState(false);

  return (
    <Modal
      open={offer !== null}
      onClose={onDecline}
      title="Anonymous VECTOR records found"
      motion={motion}
      busy={working}
      footer={(
        <>
          <Button disabled={working} onClick={onDecline}>Keep separate</Button>
          <Button
            variant="primary"
            disabled={working}
            onClick={() => {
              setWorking(true);
              void onAccept().finally(() => setWorking(false));
            }}
          >
            {working ? "Merging…" : "Merge into account"}
          </Button>
        </>
      )}
    >
      <div data-testid="vector-adoption-offer">
        <p>
          This device has {offer?.saves ?? 0} anonymous save
          {(offer?.saves ?? 0) === 1 ? "" : "s"} and {offer?.events ?? 0} pending event
          {(offer?.events ?? 0) === 1 ? "" : "s"}. Nothing moves across owner namespaces
          without this explicit decision.
        </p>
        {(offer?.collisions ?? 0) > 0 ? (
          <p>
            {offer?.collisions} matching slot
            {offer?.collisions === 1 ? "" : "s"} will be preserved as conflicts for
            explicit resolution; neither branch is overwritten.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
