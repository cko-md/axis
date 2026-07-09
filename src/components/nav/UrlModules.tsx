"use client";

import { useEffect, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import {
  assignModuleToBoard,
  createUrlBoard,
  isModuleOnBoard,
  loadUrlBoards,
  removeModuleFromBoard,
  reorderModulesOnBoard,
  saveUrlBoards,
  type UrlBoard,
} from "@/lib/store/url-boards";

// ─── Storage key ──────────────────────────────────────────────────────────────
const URL_MODULES_KEY = "axis-url-modules";

// ─── Types ───────────────────────────────────────────────────────────────────
type UrlModule = { id: string; name: string; url: string };

const ASSIGNED_DROP = "board-assigned-drop";
const POOL_DROP = "board-pool-drop";
const poolId = (moduleId: string) => `pool-${moduleId}`;
const fromPoolId = (id: string) => id.startsWith("pool-") ? id.slice(5) : null;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function loadUrlModules(): UrlModule[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(URL_MODULES_KEY) ?? "[]"); }
  catch { return []; }
}

function normalizeUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const withProto = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try { return new URL(withProto).toString(); }
  catch { return null; }
}

// ─── Icons ───────────────────────────────────────────────────────────────────
function NavIcon({ name }: { name: string }) {
  const icons: Record<string, React.ReactNode> = {
    app:   <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 9h6v6H9z" /></>,
    add:   <path d="M12 5v14M5 12h14" />,
    board: <path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z" />,
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      {icons[name] ?? icons.app}
    </svg>
  );
}

function GripHandle(props: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      aria-hidden
      suppressHydrationWarning
      {...props}
      style={{
        display: "inline-grid",
        gridTemplateColumns: "repeat(2, 3px)",
        gridTemplateRows: "repeat(3, 3px)",
        gap: "2px",
        marginRight: 4,
        flexShrink: 0,
        cursor: "grab",
        color: "var(--ink-faint)",
        opacity: 0,
        transition: "opacity 0.15s",
        ...props.style,
      }}
    >
      {Array.from({ length: 6 }).map((_, i) => (
        <span
          key={i}
          style={{ width: 3, height: 3, borderRadius: "50%", background: "currentColor" }}
        />
      ))}
    </span>
  );
}

function ModuleChip({
  module: m,
  checked,
  dragHandle,
  onToggle,
  onOpen,
}: {
  module: UrlModule;
  checked: boolean;
  dragHandle?: React.HTMLAttributes<HTMLButtonElement>;
  onToggle?: (on: boolean) => void;
  onOpen: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        border: "1px solid var(--line)",
        borderRadius: "var(--r)",
        background: checked ? "var(--glass)" : "transparent",
      }}
    >
      {dragHandle ? (
        <button
          type="button"
          aria-label={`Drag ${m.name}`}
          {...dragHandle}
          style={{
            border: "none",
            background: "transparent",
            padding: 0,
            cursor: "grab",
            color: "var(--ink-faint)",
            lineHeight: 1,
          }}
        >
          <GripHandle style={{ opacity: 1, marginRight: 0 }} />
        </button>
      ) : null}
      {onToggle ? (
        <input type="checkbox" checked={checked} onChange={(e) => onToggle(e.target.checked)} />
      ) : null}
      <span style={{ flex: 1, fontSize: 13, color: "var(--ink)" }}>{m.name}</span>
      <button type="button" className="feed-manage" style={{ fontSize: 10 }} onClick={onOpen}>
        Open
      </button>
    </div>
  );
}

function SortableAssignedModule({
  module: m,
  onToggle,
  onOpen,
}: {
  module: UrlModule;
  onToggle: (on: boolean) => void;
  onOpen: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: m.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.45 : 1,
  };
  return (
    <div ref={setNodeRef} style={style}>
      <ModuleChip
        module={m}
        checked
        dragHandle={{ ...attributes, ...listeners }}
        onToggle={onToggle}
        onOpen={onOpen}
      />
    </div>
  );
}

function DraggablePoolModule({
  module: m,
  onOpen,
}: {
  module: UrlModule;
  onOpen: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: poolId(m.id) });
  const style = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    opacity: isDragging ? 0.45 : 1,
  };
  return (
    <div ref={setNodeRef} style={style}>
      <ModuleChip module={m} checked={false} dragHandle={{ ...attributes, ...listeners }} onOpen={onOpen} />
    </div>
  );
}

function DropZone({
  id,
  label,
  hint,
  empty,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  empty?: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{
        border: `1px dashed ${isOver ? "var(--accent)" : "var(--line)"}`,
        borderRadius: "var(--r)",
        padding: 10,
        minHeight: 72,
        background: isOver ? "var(--glass)" : "transparent",
        transition: "border-color 0.15s, background 0.15s",
      }}
    >
      <div style={{ fontSize: 10, fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-faint)", marginBottom: 8 }}>
        {label}
      </div>
      {empty ? <p style={{ fontSize: 12, color: "var(--ink-faint)", margin: 0 }}>{hint}</p> : children}
    </div>
  );
}

// ─── Props ───────────────────────────────────────────────────────────────────
type Props = {
  collapsed: boolean;
  openWebViewer: (url: string, name: string) => void;
};

export function UrlModules({ collapsed, openWebViewer }: Props) {
  const { toast } = useToast();

  const [urlModules, setUrlModules] = useState<UrlModule[]>([]);
  const [boards, setBoards] = useState<UrlBoard[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const [boardDetail, setBoardDetail] = useState<UrlBoard | null>(null);
  const [formName, setFormName] = useState("");
  const [formUrl, setFormUrl] = useState("");
  const [boardName, setBoardName] = useState("");
  const [dragModule, setDragModule] = useState<UrlModule | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => {
    setUrlModules(loadUrlModules());
    setBoards(loadUrlBoards());
  }, []);

  const persistModules = (mods: UrlModule[]) => {
    setUrlModules(mods);
    try { localStorage.setItem(URL_MODULES_KEY, JSON.stringify(mods)); }
    catch { /* ignore */ }
  };

  const persistBoards = (next: UrlBoard[] | ((prev: UrlBoard[]) => UrlBoard[])) => {
    setBoards((prev) => {
      const resolved = typeof next === "function" ? next(prev) : next;
      saveUrlBoards(resolved);
      return resolved;
    });
  };

  const addModule = () => {
    const url = normalizeUrl(formUrl);
    if (!url) { toast("Enter a valid URL", "warn", "Add Module"); return; }
    const name = formName.trim() || new URL(url).host.replace(/^www\./, "");
    persistModules([...urlModules, { id: `m${Date.now().toString(36)}`, name, url }]);
    setFormName(""); setFormUrl(""); setAddOpen(false);
    toast(`${name} added to Apps`, "success", "Add Module");
  };

  const removeModule = (id: string) => persistModules(urlModules.filter((m) => m.id !== id));

  const createBoard = () => {
    const name = boardName.trim();
    if (!name) { toast("Name your board first.", "warn", "Boards"); return; }
    const board = createUrlBoard(name);
    persistBoards((prev) => [...prev, board]);
    setBoardName("");
    setBoardOpen(false);
    setBoardDetail(board);
    toast(`Board "${board.name}" created (device-local).`, "success", "Boards");
  };

  const removeBoard = (id: string) => {
    persistBoards((prev) => prev.filter((b) => b.id !== id));
    if (boardDetail?.id === id) setBoardDetail(null);
    toast("Board removed.", "info", "Boards");
  };

  const toggleModuleOnBoard = (moduleId: string, on: boolean) => {
    if (!boardDetail) return;
    persistBoards((prev) => {
      const next = on
        ? assignModuleToBoard(prev, boardDetail.id, moduleId)
        : removeModuleFromBoard(prev, boardDetail.id, moduleId);
      const updated = next.find((b) => b.id === boardDetail.id) ?? null;
      setBoardDetail(updated);
      return next;
    });
  };

  const assignedModules = boardDetail
    ? urlModules.filter((m) => isModuleOnBoard(boardDetail, m.id))
    : [];
  const availableModules = boardDetail
    ? urlModules.filter((m) => !isModuleOnBoard(boardDetail, m.id))
    : [];

  const handleBoardDragEnd = (event: DragEndEvent) => {
    setDragModule(null);
    if (!boardDetail) return;
    const { active, over } = event;
    if (!over) return;

    const activeKey = String(active.id);
    const overKey = String(over.id);
    const poolModuleId = fromPoolId(activeKey);
    const detailId = boardDetail.id;
    const detailModuleIds = boardDetail.moduleIds;

    if (poolModuleId) {
      if (overKey === ASSIGNED_DROP || detailModuleIds.includes(overKey)) {
        persistBoards((prev) => {
          const next = assignModuleToBoard(prev, detailId, poolModuleId);
          setBoardDetail(next.find((b) => b.id === detailId) ?? null);
          return next;
        });
      }
      return;
    }

    if (!detailModuleIds.includes(activeKey)) return;

    if (overKey === POOL_DROP) {
      persistBoards((prev) => {
        const next = removeModuleFromBoard(prev, detailId, activeKey);
        setBoardDetail(next.find((b) => b.id === detailId) ?? null);
        return next;
      });
      return;
    }

    if (detailModuleIds.includes(overKey)) {
      const fromIndex = detailModuleIds.indexOf(activeKey);
      const toIndex = detailModuleIds.indexOf(overKey);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
      persistBoards((prev) => {
        const next = reorderModulesOnBoard(prev, detailId, fromIndex, toIndex);
        setBoardDetail(next.find((b) => b.id === detailId) ?? null);
        return next;
      });
    }
  };

  const openModule = (m: UrlModule) => openWebViewer(m.url, m.name);

  return (
    <>
      {/* Apps section label */}
      {!collapsed && (
        <div className="navlabel" style={{ display: "flex", alignItems: "center" }}>
          <GripHandle style={{ opacity: 0, pointerEvents: "none" }} />
          Apps
        </div>
      )}
      {collapsed && <div style={{ height: 1, background: "var(--line)", margin: "12px 8px" }} />}

      {boards.map((b) => (
        <button
          key={b.id}
          type="button"
          className="navitem url-module"
          style={{ width: "100%", background: "none", border: "none", textAlign: "left", font: "inherit", fontFamily: "var(--sans)" }}
          onClick={() => setBoardDetail(b)}
          title={`Board · ${b.moduleIds.length} modules`}
        >
          {!collapsed && <GripHandle style={{ opacity: 0, pointerEvents: "none" }} />}
          <NavIcon name="board" />
          {!collapsed && <span className="lbl">{b.name}</span>}
          {!collapsed && <span className="ix" style={{ fontSize: 9, opacity: 0.7 }}>board</span>}
        </button>
      ))}

      {/* Dynamic URL modules */}
      {urlModules.map((m) => (
        <button
          key={m.id}
          type="button"
          className="navitem url-module"
          style={{ width: "100%", background: "none", border: "none", textAlign: "left", font: "inherit", fontFamily: "var(--sans)" }}
          onClick={() => openWebViewer(m.url, m.name)}
          title={m.url}
        >
          {!collapsed && <GripHandle style={{ opacity: 0, pointerEvents: "none" }} />}
          <NavIcon name="app" />
          {!collapsed && <span className="lbl">{m.name}</span>}
          {!collapsed && (
            <span
              className="ix url-module-x"
              role="button"
              tabIndex={0}
              title="Remove module"
              onClick={(e) => { e.stopPropagation(); removeModule(m.id); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); removeModule(m.id); } }}
            >
              ✕
            </span>
          )}
        </button>
      ))}

      {/* Add Module button */}
      <button
        type="button"
        className="navitem"
        style={{ width: "100%", background: "none", border: "none", textAlign: "left", font: "inherit", fontFamily: "var(--sans)" }}
        onClick={() => setAddOpen(true)}
        title="Add a module by URL"
      >
        {!collapsed && <GripHandle style={{ opacity: 0, pointerEvents: "none" }} />}
        <NavIcon name="add" />
        {!collapsed && <span className="lbl">Add Module</span>}
      </button>

      {/* New Board button */}
      <button
        type="button"
        className="navitem"
        style={{ width: "100%", background: "none", border: "none", textAlign: "left", font: "inherit", fontFamily: "var(--sans)" }}
        onClick={() => setBoardOpen(true)}
        title="New Board"
      >
        {!collapsed && <GripHandle style={{ opacity: 0, pointerEvents: "none" }} />}
        <NavIcon name="board" />
        {!collapsed && <span className="lbl">New Board</span>}
        {!collapsed && <span className="ix">✦</span>}
      </button>

      {/* Add Module modal */}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Module"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={addModule}>Add to Apps</Button>
          </>
        }
      >
        <p className="mb-4 text-xs text-[var(--ink-dim)]">
          Pin any web app or tool as a near-fullscreen module. It opens in an embedded window with a one-click escape to a full browser tab.
        </p>
        <label className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-[var(--ink-faint)]">Name</label>
        <input
          value={formName}
          onChange={(e) => setFormName(e.target.value)}
          placeholder="e.g. UWorld, Anki, ClinicalKey"
          className="mb-3 w-full rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
        />
        <label className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-[var(--ink-faint)]">URL</label>
        <input
          value={formUrl}
          onChange={(e) => setFormUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addModule()}
          placeholder="uworld.com"
          className="w-full rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
        />
      </Modal>

      <Modal
        open={boardOpen}
        onClose={() => setBoardOpen(false)}
        title="New Board"
        footer={
          <>
            <Button variant="ghost" onClick={() => setBoardOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={createBoard}>Create board</Button>
          </>
        }
      >
        <p className="mb-4 text-xs text-[var(--ink-dim)]">
          Boards group URL modules into workspaces. Assign modules below — stored on this device until Supabase sync ships.
        </p>
        <label className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-[var(--ink-faint)]">Board name</label>
        <input
          value={boardName}
          onChange={(e) => setBoardName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && createBoard()}
          placeholder="e.g. Research stack, Clinical tools"
          autoFocus
          className="w-full rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
        />
      </Modal>

      <Modal
        open={!!boardDetail}
        onClose={() => setBoardDetail(null)}
        title={boardDetail?.name ?? "Board"}
        footer={
          <>
            <Button variant="ghost" onClick={() => boardDetail && removeBoard(boardDetail.id)}>Delete board</Button>
            <Button variant="primary" onClick={() => setBoardDetail(null)}>Close</Button>
          </>
        }
      >
        {boardDetail && (
          <>
            <p className="mb-3 text-xs text-[var(--ink-dim)]">
              {assignedModules.length} of {urlModules.length} module{urlModules.length === 1 ? "" : "s"} assigned · drag between zones or use checkboxes · device-local
            </p>
            {urlModules.length === 0 ? (
              <p className="text-sm text-[var(--ink-faint)]">Add URL modules in Apps first, then assign them here.</p>
            ) : (
              <DndContext
                id="board-module-assignment"
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={(e) => {
                  const id = String(e.active.id);
                  const moduleId = fromPoolId(id) ?? id;
                  const mod = urlModules.find((m) => m.id === moduleId) ?? null;
                  setDragModule(mod);
                }}
                onDragEnd={handleBoardDragEnd}
                onDragCancel={() => setDragModule(null)}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 12, maxHeight: 360, overflowY: "auto" }}>
                  <DropZone id={ASSIGNED_DROP} label="On this board" hint="Drag modules here to assign" empty={assignedModules.length === 0}>
                    <SortableContext items={assignedModules.map((m) => m.id)} strategy={verticalListSortingStrategy}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {assignedModules.map((m) => (
                          <SortableAssignedModule
                            key={m.id}
                            module={m}
                            onToggle={(on) => toggleModuleOnBoard(m.id, on)}
                            onOpen={() => openModule(m)}
                          />
                        ))}
                      </div>
                    </SortableContext>
                  </DropZone>
                  <DropZone id={POOL_DROP} label="Available" hint="All modules are on this board" empty={availableModules.length === 0}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {availableModules.map((m) => (
                        <DraggablePoolModule key={m.id} module={m} onOpen={() => openModule(m)} />
                      ))}
                    </div>
                  </DropZone>
                </div>
                <DragOverlay>
                  {dragModule ? (
                    <ModuleChip module={dragModule} checked={isModuleOnBoard(boardDetail, dragModule.id)} onOpen={() => openModule(dragModule)} />
                  ) : null}
                </DragOverlay>
              </DndContext>
            )}
          </>
        )}
      </Modal>
    </>
  );
}
