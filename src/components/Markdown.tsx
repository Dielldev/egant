import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/** Renders assistant replies as markdown — headings, lists, tables, links and
 * code all get real structure instead of a wall of pre-wrapped text. Every
 * element reads from the app's own CSS vars so it re-skins with the active
 * palette exactly like the rest of the transcript. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown flex flex-col text-sm leading-6 text-[var(--ink)]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

const components: Components = {
  p: ({ children }) => <p className="whitespace-pre-wrap last:mb-0">{children}</p>,
  h1: ({ children }) => (
    <h1 className="mt-4 mb-2 text-base font-semibold text-[var(--ink)] first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-4 mb-2 text-[15px] font-semibold text-[var(--ink)] first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-3 mb-1.5 text-sm font-semibold text-[var(--ink)] first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-3 mb-1.5 text-sm font-semibold text-[var(--ink)] first:mt-0">{children}</h4>
  ),
  ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="leading-6 marker:text-[var(--faint)]">{children}</li>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-[var(--accent)] underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-[var(--ink)]">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-[var(--faint)]">{children}</del>,
  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-[var(--border)] pl-3 text-[var(--muted)] last:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-[var(--border)]" />,
  table: ({ children }) => (
    <div className="mb-3 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-[var(--border)] px-2 py-1 text-left font-medium text-[var(--muted)]">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-[var(--border)] px-2 py-1 align-top">{children}</td>
  ),
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children, node, ...rest }) => {
    const raw = String(children).replace(/\n$/, "");
    // A code span never spans more than one source line; a fenced block
    // always does (opening fence, content, closing fence), so this tells
    // them apart regardless of whether an info string set `className`.
    const isBlock = node?.position ? node.position.start.line !== node.position.end.line : false;

    if (!isBlock) {
      // Inline code: transparent fill, theme-colored text. Nord gets cyan
      // #88c0d0 text, dracula purple, cobalt yellow… via --code-chip-bg
      // (the palette's most colorful solid, reused here as the text color).
      return (
        <code
          className="rounded-[4px] border border-[var(--border)] bg-transparent px-1 py-px font-mono text-[0.85em] font-medium text-[var(--code-chip-bg)]"
          {...rest}
        >
          {children}
        </code>
      );
    }

    const language = /language-(\w+)/.exec(className || "")?.[1];
    return <CodeBlock language={language} code={raw} />;
  },
};

function CodeBlock({ language, code }: { language?: string; code: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="group relative mb-3 last:mb-0">
      <pre className="max-h-[420px] overflow-auto rounded-lg bg-[rgba(0,0,0,0.15)] p-2.5 font-mono text-[11px] leading-5 text-[var(--faint)]">
        <code>{code}</code>
      </pre>
      <div className="absolute top-1.5 right-1.5 flex items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
        {language && (
          <span className="rounded-md bg-[rgba(0,0,0,0.4)] px-1.5 py-0.5 text-[10px] text-[var(--faint)]">
            {language}
          </span>
        )}
        <button
          type="button"
          title="Copy code"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => setCopied(true));
          }}
          className="cursor-pointer rounded-md bg-[rgba(0,0,0,0.4)] p-1 text-[var(--faint)] hover:text-[var(--ink)]"
        >
          {copied ? <Check size={11} strokeWidth={2} /> : <Copy size={11} strokeWidth={2} />}
        </button>
      </div>
    </div>
  );
}
