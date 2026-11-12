import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

function CodeBlock({ children, ...props }: React.HTMLAttributes<HTMLPreElement>) {
  const ref = React.useRef<HTMLPreElement>(null);
  const [copied, setCopied] = React.useState(false);
  const lang = React.isValidElement(children) ? String((children.props as { className?: string }).className ?? "").replace(/.*language-(\S+).*/, "$1") : "";
  const copy = async () => {
    await navigator.clipboard.writeText(ref.current?.innerText ?? "");
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <div className="group relative">
      <div className="absolute right-1.5 top-1.5 z-10 flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
        {lang && !lang.includes(" ") && <span className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[10px] text-white/70">{lang}</span>}
        <button onClick={copy} className="rounded-md bg-black/40 p-1 text-white/80 transition hover:bg-black/60" aria-label="Copy code">
          {copied ? <Check className="h-3.5 w-3.5 text-olive" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
      <pre ref={ref} {...props}>{children}</pre>
    </div>
  );
}

export const Markdown = React.memo(function Markdown({ children, className, streaming }: { children: string; className?: string; streaming?: boolean }) {
  return (
    <div className={cn("prose prose-sm max-w-none break-words dark:prose-invert prose-p:my-1.5 prose-headings:mb-2 prose-headings:mt-3 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5", streaming && "caret", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{ pre: CodeBlock, a: ({ ...p }) => <a {...p} target="_blank" rel="noreferrer noopener" /> }}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
