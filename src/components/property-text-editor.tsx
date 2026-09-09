"use client";

import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

export type PropertyEditorValue = { text: string; document?: JSONContent };

function plainDocument(text: string): JSONContent {
  return { type: "doc", content: text.split("\n").map((line) => ({
    type: "paragraph", content: line ? [{ type: "text", text: line }] : [],
  })) };
}

export function PropertyTextEditor({ label, value, onChange, language, disabled = false }: {
  label: string;
  value: PropertyEditorValue;
  onChange: (value: PropertyEditorValue) => void;
  language: string;
  disabled?: boolean;
}) {
  const de = language === "de";
  const shell = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState(false);
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: false, codeBlock: false, code: false, horizontalRule: false })],
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
    content: value.document ?? plainDocument(value.text),
    editable: !disabled,
    editorProps: { attributes: { role: "textbox", "aria-label": label, "aria-multiline": "true", class: "property-writing-surface" } },
    onUpdate: ({ editor }) => onChange({ text: editor.getText({ blockSeparator: "\n" }), document: editor.getJSON() }),
  });

  useEffect(() => {
    if (!editor) return;
    const content = value.document ?? plainDocument(value.text);
    if (JSON.stringify(editor.getJSON()) !== JSON.stringify(content)) editor.commands.setContent(content, { emitUpdate: false });
  }, [editor, value]);

  useEffect(() => { editor?.setEditable(!preview && !disabled); }, [editor, preview, disabled]);

  useEffect(() => {
    if (!expanded) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
      if (event.key === "Tab") {
        const elements = shell.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [contenteditable="true"]');
        if (!elements?.length) return;
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = previous; document.removeEventListener("keydown", onKey); };
  }, [expanded]);

  const tools = editor ? [
    { label: de ? "Fett" : "Bold", active: editor.isActive("bold"), run: () => editor.chain().focus().toggleBold().run() },
    { label: de ? "Kursiv" : "Italic", active: editor.isActive("italic"), run: () => editor.chain().focus().toggleItalic().run() },
    { label: de ? "Überschrift" : "Heading", active: editor.isActive("heading", { level: 2 }), run: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: de ? "Aufzählung" : "Bullet list", active: editor.isActive("bulletList"), run: () => editor.chain().focus().toggleBulletList().run() },
    { label: de ? "Nummerierung" : "Numbered list", active: editor.isActive("orderedList"), run: () => editor.chain().focus().toggleOrderedList().run() },
    { label: de ? "Rückgängig" : "Undo", run: () => editor.chain().focus().undo().run(), disabled: !editor.can().undo() },
    { label: de ? "Wiederholen" : "Redo", run: () => editor.chain().focus().redo().run(), disabled: !editor.can().redo() },
  ] : [];

  return <div ref={shell} className={`property-editor ${expanded ? "property-editor-expanded" : ""}`} role={expanded ? "dialog" : "group"} aria-modal={expanded || undefined} aria-label={label}>
    <div className="property-editor-heading">
      <strong>{label}</strong>
      <div className="flex flex-wrap gap-2">
        <button type="button" aria-pressed={preview} onClick={() => setPreview(!preview)}>{preview ? (de ? "Weiter schreiben" : "Edit") : (de ? "Textvorschau" : "Text preview")}</button>
        <button type="button" aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? (de ? "Vollbild schließen" : "Exit fullscreen") : (de ? "Vollbild" : "Fullscreen")}</button>
      </div>
    </div>
    {!preview && <div className="property-editor-toolbar" role="group" aria-label={de ? "Textformatierung" : "Formatting"}>
      {tools.map((tool) => <button type="button" key={tool.label} aria-pressed={tool.active} disabled={disabled || tool.disabled} onMouseDown={(event) => event.preventDefault()} onClick={tool.run}>{tool.label}</button>)}
    </div>}
    <EditorContent editor={editor} />
    <p className="property-editor-footer">{value.text.trim() ? value.text.trim().split(/\s+/).length : 0} {de ? "Wörter" : "words"} · {value.text.length} {de ? "Zeichen" : "characters"}{preview ? (de ? " · Textvorschau, kein fertiges PDF-Layout" : " · Text preview, not the final PDF layout") : ""}</p>
  </div>;
}
