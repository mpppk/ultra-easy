import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { AppLink } from "#components/layout/app-link";

/** Renders canonical Markdown (react-markdown + remark-gfm; raw HTML is not rendered). */
export function MarkdownView({ markdown }: { markdown: string }) {
  return (
    <div className="markdown" data-slot="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) =>
            href?.startsWith("/") ? (
              <AppLink href={href}>{children}</AppLink>
            ) : (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ),
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
