/**
 * Base64 of text, for the APIs that carry a message as bytes: Kinesis and Firehose on AWS, and
 * Pub/Sub and Secret Manager on Google.
 *
 * Encoding through TextEncoder rather than handing `btoa` a string directly: `btoa` throws on any
 * character above U+00FF, so a message with an accent in it would fail and a plain one would not,
 * which is a bug that only shows up in production and only for some users.
 */
export const b64 = (text: string): string => {
	const bytes = new TextEncoder().encode(text);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
};

/** The inverse, for reading records off a stream or a subscription. */
export const unb64 = (encoded: string): string => {
	const binary = atob(encoded);
	const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
	return new TextDecoder().decode(bytes);
};
