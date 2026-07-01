import type { ReactNode } from "react";

export type DetailPanelSectionConfig = {
  id: string;
  title: string;
  value?: ReactNode;
  description?: ReactNode;
  actionSlot?: ReactNode;
  children?: ReactNode;
};

type DetailPanelSectionProps = DetailPanelSectionConfig & {
  titleId?: string;
};

type DetailPanelSectionsProps = {
  sections: DetailPanelSectionConfig[];
};

export function detailPanelSectionTitleId(sectionId: string, prefix = "detail-panel-section") {
  const normalized = sectionId.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${prefix}-${normalized || "section"}`;
}

export function DetailPanelSection({
  id,
  title,
  value,
  description,
  actionSlot,
  children,
  titleId = detailPanelSectionTitleId(id),
}: DetailPanelSectionProps) {
  return (
    <section className="detail-panel-section" aria-labelledby={titleId}>
      <div className="detail-panel-section-heading">
        <h3 id={titleId}>{title}</h3>
        {value ? <strong>{value}</strong> : null}
      </div>
      {description ? <p>{description}</p> : null}
      {children}
      {actionSlot ? <div className="detail-panel-section-actions">{actionSlot}</div> : null}
    </section>
  );
}

export function DetailPanelSections({ sections }: DetailPanelSectionsProps) {
  if (sections.length === 0) return null;

  return (
    <div className="detail-panel-sections">
      {sections.map((section) => (
        <DetailPanelSection key={section.id} {...section} />
      ))}
    </div>
  );
}
