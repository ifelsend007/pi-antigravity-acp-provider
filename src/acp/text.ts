/** Bound a value for logging or display without splitting a surrogate pair: a bare
 * `slice` can end on a lone high surrogate, which encodes as U+FFFD downstream. */
export function truncateText(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return text.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, "");
}
