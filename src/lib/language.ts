import hljs from "highlight.js/lib/common";

/** Extension to highlight.js language. Only the families the common bundle
 * actually registers — anything else falls through to plain text rather than
 * to an auto-detect guess that gets it wrong. */
const LANGUAGE: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  rs: "rust",
  json: "json",
  jsonc: "json",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  py: "python",
  go: "go",
  rb: "ruby",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  diff: "diff",
  patch: "diff",
};

/** The highlight.js language for a filename, or `null` when the pack has no
 * grammar for it — shared by the file viewer, the diff viewer and the tool
 * cards, which highlight the same languages. Lives here rather than in
 * `FileView` so the tool cards can be rendered without the editor (the phone
 * app draws them too). */
export function languageFor(name: string): string | null {
  const dot = name.toLowerCase().lastIndexOf(".");
  if (dot < 0) return null;
  const language = LANGUAGE[name.toLowerCase().slice(dot + 1)];
  return language && hljs.getLanguage(language) ? language : null;
}
