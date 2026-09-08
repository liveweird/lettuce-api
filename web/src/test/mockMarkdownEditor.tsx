/* eslint-disable react-refresh/only-export-components -- test helper module, not app source: mixes the MarkdownEditorStub component with the mockMarkdownEditorModule() factory tests call from vi.mock() */
// Shared vi.mock replacement for the WYSIWYG MarkdownEditor. The real editor is a Lexical
// contenteditable that doesn't run in jsdom/happy-dom; this swaps it for a plain controlled
// textarea so the Content assertions (label, value, typing, template insert) exercise the same
// value flow. Usage in a spec:
//     import { mockMarkdownEditorModule } from "../test/mockMarkdownEditor";
//     vi.mock("./MarkdownEditor", () => mockMarkdownEditorModule());

type Props = {
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder?: string;
};

export function MarkdownEditorStub({ value, onChange, label, placeholder }: Props) {
  return (
    <textarea
      aria-label={label}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function mockMarkdownEditorModule() {
  return { default: MarkdownEditorStub };
}
