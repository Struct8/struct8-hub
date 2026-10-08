/**
 * How a runtime reads a switch from its environment.
 *
 * Shared by the two runtimes so that `on` means the same thing on both. Every switch read this way
 * turns on something an account has to ask for — a CPU-burn route, X-Ray billing, failures on
 * request — so anything that is not clearly a yes is a no.
 */

/** An explicit on-ish value. Anything else, absence included, is off. */
export const onish = (value: string | undefined): boolean => {
	const v = (value ?? '').trim().toLowerCase();
	return v === 'on' || v === 'true' || v === '1' || v === 'yes';
};
