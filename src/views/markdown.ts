import MarkdownIt from "markdown-it";
import sanitizeHtml from "sanitize-html";

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

const markdownOptions: sanitizeHtml.IOptions = {
  allowedTags: [
    "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "hr", "li", "ol",
    "p", "pre", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul",
  ],
  allowedAttributes: {
    a: ["href", "name", "target", "rel"],
    code: ["class"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" }),
  },
};

export function renderMarkdown(source: string): string {
  return sanitizeHtml(markdown.render(source), markdownOptions);
}

export function sanitizeCommentHtml(source: string): string {
  return sanitizeHtml(source, markdownOptions);
}
