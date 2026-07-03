"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { createLowlight, common } from "lowlight";
import { type NoteFont } from "@/lib/hooks/useNotes";
import styles from "./NotesEditor.module.css";

const lowlight = createLowlight(common);

/* ── Icons (inherit currentColor) ───────────────────────────── */
const I = {
  bold: <svg viewBox="0 0 24 24"><path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" /></svg>,
  italic: <svg viewBox="0 0 24 24"><path d="M10 5h7M7 19h7M14 5l-4 14" /></svg>,
  underline: <svg viewBox="0 0 24 24"><path d="M7 4v7a5 5 0 0 0 10 0V4M5 21h14" /></svg>,
  strike: <svg viewBox="0 0 24 24"><path d="M5 12h14M8 7s1.5-2 4-2 4 1.4 4 3M8 17s1.5 2 4 2 4-1.4 4-3" /></svg>,
  code: <svg viewBox="0 0 24 24"><path d="M9 8l-4 4 4 4M15 8l4 4-4 4" /></svg>,
  quote: <svg viewBox="0 0 24 24"><path d="M7 7H4v6h3l-1 4M17 7h-3v6h3l-1 4" /></svg>,
  bullet: <svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" /></svg>,
  ordered: <svg viewBox="0 0 24 24"><path d="M10 6h10M10 12h10M10 18h10M4 6h1v4M4 10h2M4 14h2l-2 3h2" /></svg>,
  task: <svg viewBox="0 0 24 24"><path d="M4 5h6v6H4zM6 8l1.2 1.2L9 6.8M14 7h6M14 17h6M4 14h6v6H4z" /></svg>,
  rule: <svg viewBox="0 0 24 24"><path d="M4 12h16" /></svg>,
  codeblock: <svg viewBox="0 0 24 24"><path d="M3 4h18v16H3zM8 9l-2 3 2 3M16 9l2 3-2 3" /></svg>,
  table: <svg viewBox="0 0 24 24"><path d="M3 4h18v16H3zM3 10h18M3 16h18M9 4v16M15 4v16" /></svg>,
  undo: <svg viewBox="0 0 24 24"><path d="M9 7L4 12l5 5M4 12h11a5 5 0 0 1 0 10h-3" /></svg>,
  redo: <svg viewBox="0 0 24 24"><path d="M15 7l5 5-5 5M20 12H9a5 5 0 0 0 0 10h3" /></svg>,
  attach: <svg viewBox="0 0 24 24"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>,
  popout: <svg viewBox="0 0 24 24"><path d="M15 3h6v6M10 14L21 3M9 3H3v18h18v-6" /></svg>,
};

type SlashCmd = {
  key: string;
  name: string;
  desc: string;
  icon: React.ReactNode;
  run: (e: Editor) => void;
};

const SLASH_COMMANDS: SlashCmd[] = [
  { key: "h1", name: "Heading 1", desc: "Large editorial title", icon: <span>H1</span>, run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run() },
  { key: "h2", name: "Heading 2", desc: "Section title", icon: <span>H2</span>, run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
  { key: "h3", name: "Heading 3", desc: "Gold caps label", icon: <span>H3</span>, run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run() },
  { key: "bullet", name: "Bullet list", desc: "Unordered list", icon: I.bullet, run: (e) => e.chain().focus().toggleBulletList().run() },
  { key: "ordered", name: "Numbered list", desc: "Ordered list", icon: I.ordered, run: (e) => e.chain().focus().toggleOrderedList().run() },
  { key: "task", name: "Task list", desc: "Checkable to-dos", icon: I.task, run: (e) => e.chain().focus().toggleTaskList().run() },
  { key: "quote", name: "Quote", desc: "Blockquote", icon: I.quote, run: (e) => e.chain().focus().toggleBlockquote().run() },
  { key: "code", name: "Code block", desc: "Fenced + highlighted", icon: I.codeblock, run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { key: "table", name: "Table", desc: "3×3 with header row", icon: I.table, run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { key: "rule", name: "Divider", desc: "Horizontal rule", icon: I.rule, run: (e) => e.chain().focus().setHorizontalRule().run() },
];

const FONT_FAMILY: Record<NoteFont, string> = {
  sans: "var(--sans)",
  serif: "var(--serif)",
  mono: "var(--mono)",
};

type NotesEditorAiProps = {
  onSummarize?: () => void;
  onRewrite?: () => void;
  onTitle?: () => void;
  loading?: string | null;
};

type NotesEditorWindowProps = {
  onPopout?: () => void;
  onMinimize?: () => void;
  isPopout?: boolean;
};

type Props = {
  content: string;
  onChange: (html: string) => void;
  saving?: boolean;
  saveLabel?: string;
  onRoute?: () => void;
  routing?: boolean;
  editable?: boolean;
  font?: NoteFont;
  onFontChange?: (f: NoteFont) => void;
  ai?: NotesEditorAiProps;
  window?: NotesEditorWindowProps;
};

export function NotesEditor({
  content,
  onChange,
  saving,
  saveLabel,
  onRoute,
  routing,
  editable = true,
  font = "sans",
  onFontChange,
  ai,
  window: windowProps,
}: Props) {
  const { onSummarize: onAiSummarize, onRewrite: onAiRewrite, onTitle: onAiTitle, loading: aiLoading } = ai ?? {};
  const { onPopout, onMinimize, isPopout = false } = windowProps ?? {};
  const [, force] = useState(0);
  const rerender = useCallback(() => force((n) => n + 1), []);

  const [slash, setSlash] = useState<{ x: number; y: number; query: string } | null>(null);
  const [slashIdx, setSlashIdx] = useState(0);
  const slashRangeRef = useRef<{ from: number; to: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        heading: { levels: [1, 2, 3] },
      }),
      Placeholder.configure({
        placeholder: ({ node }) =>
          node.type.name === "heading" ? "Heading…" : "Write, or press “/” for blocks…",
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      CodeBlockLowlight.configure({ lowlight }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: content || "",
    editable,
    editorProps: {
      attributes: { class: "axis-prose", spellcheck: "true" },
    },
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
    onSelectionUpdate: rerender,
    onTransaction: rerender,
  });

  useEffect(() => {
    if (!editor) return;
    const current = editor.getHTML();
    if (content !== current && content !== undefined) {
      editor.commands.setContent(content || "", { emitUpdate: false });
    }
  }, [content, editor]);

  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable);
  }, [editable, editor]);

  useEffect(() => {
    if (!editor || !editable) return;
    const handle = () => {
      const { state } = editor;
      const { from } = state.selection;
      const textBefore = state.doc.textBetween(Math.max(0, from - 40), from, "\n", "\n");
      const match = /(?:^|\s)\/(\w*)$/.exec(textBefore);
      if (match && editor.isFocused) {
        const start = from - match[1].length - 1;
        slashRangeRef.current = { from: start, to: from };
        const coords = editor.view.coordsAtPos(from);
        setSlash({ x: coords.left, y: coords.bottom + 6, query: match[1].toLowerCase() });
        setSlashIdx(0);
      } else {
        setSlash(null);
        slashRangeRef.current = null;
      }
    };
    editor.on("selectionUpdate", handle);
    editor.on("update", handle);
    return () => {
      editor.off("selectionUpdate", handle);
      editor.off("update", handle);
    };
  }, [editor, editable]);

  const filteredCmds = useMemo(() => {
    if (!slash) return [];
    const q = slash.query;
    if (!q) return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter((c) => c.key.includes(q) || c.name.toLowerCase().includes(q));
  }, [slash]);

  const runSlash = useCallback(
    (cmd: SlashCmd) => {
      if (!editor || !slashRangeRef.current) return;
      const { from, to } = slashRangeRef.current;
      editor.chain().focus().deleteRange({ from, to }).run();
      cmd.run(editor);
      setSlash(null);
      slashRangeRef.current = null;
    },
    [editor],
  );

  useEffect(() => {
    if (!slash) return;
    const onKey = (e: KeyboardEvent) => {
      if (!filteredCmds.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIdx((i) => (i + 1) % filteredCmds.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIdx((i) => (i - 1 + filteredCmds.length) % filteredCmds.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        runSlash(filteredCmds[slashIdx]);
      } else if (e.key === "Escape") {
        setSlash(null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [slash, filteredCmds, slashIdx, runSlash]);

  const handleFileAttach = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !editor) return;
      e.target.value = "";
      if (file.type.startsWith("image/")) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          const src = ev.target?.result as string;
          editor.chain().focus().insertContent(`<p><img src="${src}" alt="${file.name}" style="max-width:100%;border-radius:6px" /></p>`).run();
        };
        reader.readAsDataURL(file);
      } else {
        editor.chain().focus().insertContent(`<p>[📎 ${file.name}]</p>`).run();
      }
    },
    [editor],
  );

  if (!editor) return <div className={styles.shell} />;

  const Btn = ({
    active,
    disabled,
    onClick,
    title,
    children,
  }: {
    active?: boolean;
    disabled?: boolean;
    onClick: () => void;
    title: string;
    children: React.ReactNode;
  }) => (
    <button
      type="button"
      className={`${styles.btn} ${active ? styles.on : ""}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
    >
      {children}
    </button>
  );

  const inTable = editor.isActive("table");

  return (
    <div className={styles.shell}>
      {editable && (
        <div className={styles.bar}>
          <div className={styles.group}>
            <Btn title="Undo" onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()}>{I.undo}</Btn>
            <Btn title="Redo" onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()}>{I.redo}</Btn>
          </div>
          <span className={styles.sep} />
          <div className={styles.group}>
            {([1, 2, 3] as const).map((lvl) => (
              <Btn key={lvl} title={`Heading ${lvl}`} active={editor.isActive("heading", { level: lvl })} onClick={() => editor.chain().focus().toggleHeading({ level: lvl }).run()}>
                <span className={styles.btnLabel}>H{lvl}</span>
              </Btn>
            ))}
          </div>
          <span className={styles.sep} />
          <div className={styles.group}>
            <Btn title="Bold (⌘B)" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}>{I.bold}</Btn>
            <Btn title="Italic (⌘I)" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}>{I.italic}</Btn>
            <Btn title="Underline (⌘U)" active={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()}>{I.underline}</Btn>
            <Btn title="Strikethrough" active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()}>{I.strike}</Btn>
            <Btn title="Inline code" active={editor.isActive("code")} onClick={() => editor.chain().focus().toggleCode().run()}>{I.code}</Btn>
          </div>
          <span className={styles.sep} />
          <div className={styles.group}>
            <Btn title="Bullet list" active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}>{I.bullet}</Btn>
            <Btn title="Numbered list" active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}>{I.ordered}</Btn>
            <Btn title="Task list" active={editor.isActive("taskList")} onClick={() => editor.chain().focus().toggleTaskList().run()}>{I.task}</Btn>
            <Btn title="Blockquote" active={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()}>{I.quote}</Btn>
            <Btn title="Code block" active={editor.isActive("codeBlock")} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>{I.codeblock}</Btn>
            <Btn title="Divider" onClick={() => editor.chain().focus().setHorizontalRule().run()}>{I.rule}</Btn>
          </div>
          <span className={styles.sep} />
          <div className={styles.group}>
            <Btn title="Insert table" active={inTable} onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>{I.table}</Btn>
            {inTable && (
              <>
                <Btn title="Add column" onClick={() => editor.chain().focus().addColumnAfter().run()}><span className={styles.btnLabel}>+Col</span></Btn>
                <Btn title="Add row" onClick={() => editor.chain().focus().addRowAfter().run()}><span className={styles.btnLabel}>+Row</span></Btn>
                <Btn title="Delete column" onClick={() => editor.chain().focus().deleteColumn().run()}><span className={styles.btnLabel}>−Col</span></Btn>
                <Btn title="Delete row" onClick={() => editor.chain().focus().deleteRow().run()}><span className={styles.btnLabel}>−Row</span></Btn>
                <Btn title="Delete table" onClick={() => editor.chain().focus().deleteTable().run()}><span className={styles.btnLabel}>×Tbl</span></Btn>
              </>
            )}
          </div>
          <span className={styles.sep} />
          <div className={styles.group}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.pdf"
              style={{ display: "none" }}
              onChange={handleFileAttach}
            />
            <Btn title="Attach image or PDF" onClick={() => fileInputRef.current?.click()}>{I.attach}</Btn>
          </div>
          {(onAiSummarize || onAiRewrite || onAiTitle) && (
            <>
              <span className={styles.sep} />
              <div className={styles.group}>
                {onAiSummarize && (
                  <button
                    type="button"
                    className={styles.btn}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={onAiSummarize}
                    disabled={!!aiLoading}
                    title="Summarize this note with AI"
                  >
                    <span className={styles.btnLabel} style={{ color: aiLoading === "summarize" ? "var(--ink-dim)" : "var(--gold)", fontSize: 10.5 }}>
                      {aiLoading === "summarize" ? "…" : "✦ Sum"}
                    </span>
                  </button>
                )}
                {onAiRewrite && (
                  <button
                    type="button"
                    className={styles.btn}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={onAiRewrite}
                    disabled={!!aiLoading}
                    title="Rewrite / polish this note"
                  >
                    <span className={styles.btnLabel} style={{ color: aiLoading === "rewrite" ? "var(--ink-dim)" : "var(--gold)", fontSize: 10.5 }}>
                      {aiLoading === "rewrite" ? "…" : "✦ Rw"}
                    </span>
                  </button>
                )}
                {onAiTitle && (
                  <button
                    type="button"
                    className={styles.btn}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={onAiTitle}
                    disabled={!!aiLoading}
                    title="Generate a title from note content"
                  >
                    <span className={styles.btnLabel} style={{ color: aiLoading === "title" ? "var(--ink-dim)" : "var(--gold)", fontSize: 10.5 }}>
                      {aiLoading === "title" ? "…" : "✦ T↑"}
                    </span>
                  </button>
                )}
              </div>
            </>
          )}
          {onFontChange && (
            <>
              <span className={styles.sep} />
              <div className={styles.group}>
                {(["sans", "serif", "mono"] as NoteFont[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={`${styles.fontChip} ${font === f ? styles.fontChipOn : ""}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onFontChange(f)}
                    title={`Editor font: ${f}`}
                  >
                    {f === "sans" ? "Aa" : f === "serif" ? "Ff" : "</>"}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className={styles.metaSpacer} />
          {onRoute && (
            <button
              type="button"
              className={styles.btn}
              onMouseDown={(e) => e.preventDefault()}
              onClick={onRoute}
              disabled={routing}
              title="Classify this note and suggest a destination"
              style={{ minWidth: "auto", paddingInline: 10, borderColor: "var(--line)" }}
            >
              <span className={styles.btnLabel} style={{ color: "var(--gold)" }}>
                {routing ? "Routing…" : "Route note →"}
              </span>
            </button>
          )}
          {onMinimize && isPopout && (
            <button
              type="button"
              className={styles.btn}
              onMouseDown={(e) => e.preventDefault()}
              onClick={onMinimize}
              title="Minimize"
              style={{ minWidth: "auto", paddingInline: 8 }}
            >
              <span className={styles.btnLabel}>–</span>
            </button>
          )}
          {onPopout && (
            <button
              type="button"
              className={styles.btn}
              onMouseDown={(e) => e.preventDefault()}
              onClick={onPopout}
              title={isPopout ? "Close pop-out" : "Pop out note"}
              style={{ minWidth: "auto", paddingInline: 8, color: isPopout ? "var(--gold)" : undefined }}
            >
              {isPopout ? <span className={styles.btnLabel}>✕</span> : I.popout}
            </button>
          )}
        </div>
      )}

      <div
        className={`${styles.editorWrap} ${styles.editor}`}
        style={{ fontFamily: FONT_FAMILY[font] }}
      >
        <EditorContent editor={editor} />
      </div>

      {slash && filteredCmds.length > 0 && (
        <div className={styles.slash} style={{ left: slash.x, top: slash.y }}>
          <div className={styles.slashHead}>Insert block</div>
          {filteredCmds.map((cmd, i) => (
            <div
              key={cmd.key}
              className={`${styles.slashItem} ${i === slashIdx ? styles.active : ""}`}
              onMouseEnter={() => setSlashIdx(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                runSlash(cmd);
              }}
            >
              <span className={styles.slashIcon}>{cmd.icon}</span>
              <span>
                <div className={styles.slashName}>{cmd.name}</div>
                <div className={styles.slashDesc}>{cmd.desc}</div>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className={styles.meta}>
        {editable ? (
          <span className={`${styles.saveDot} ${saving ? styles.saving : ""}`}>
            {saveLabel ?? (saving ? "Saving…" : "Saved")}
          </span>
        ) : (
          <span className={styles.saveDot} style={{ color: "var(--ink-faint)" }}>
            Locked · read-only
          </span>
        )}
        <span>{editor.storage.characterCount?.characters?.() ?? editor.getText().length} chars</span>
        <span className={styles.metaSpacer} />
        <span>{editable ? 'Markdown shortcuts · “/” for blocks' : 'Unlock to edit'}</span>
      </div>
    </div>
  );
}
