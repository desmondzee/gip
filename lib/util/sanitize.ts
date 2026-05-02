export function sanitizeText(s: string): string {
  if (!s) return ""
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
}

// Slice-then-sanitize. UTF-16 code-unit slicing can split a surrogate pair
// (emoji) in half; sanitizing after the slice strips the resulting orphan so
// downstream JSON encoders and Anthropic's strict request validator stay happy.
export function safeTruncate(s: string, n: number): string {
  if (!s) return ""
  return sanitizeText(s.slice(0, n))
}
