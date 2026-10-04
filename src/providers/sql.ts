/**
 * Talking to a relational database from a workload.
 *
 * `fetch` is the transport every other resource shares, and a database does not speak HTTP: it is
 * a TCP connection and a wire protocol of its own. That is a second transport, not a special case
 * of the first, so it gets a port of its own — and the port is what keeps the module that uses it
 * testable without a database.
 *
 * Which protocol is a property of the ENGINE, and the engine is only known at run time: the same
 * `aws_db_instance` type is a Postgres in one diagram and a MySQL in the next. So the module asks
 * for a connection by engine name and this file picks the driver. Another engine of a family that
 * has a driver is one line in {@link FAMILIES}. A new family is also a driver file that registers
 * itself, and the module's statements in that family's SQL: `aws_db_instance` writes Postgres
 * (`$1` placeholders, `timestamptz`, `on conflict`), which a MySQL rejects.
 *
 * Drivers register themselves on import (`providers/postgres.ts`), and a resource module imports
 * the ones it can use. That is what keeps a function that is not wired to a database from carrying
 * a database client: the bundler only includes what a chosen resource imports.
 */

/** Where a database listens. */
export interface Target {
	readonly host: string;
	readonly port: number;
	readonly database: string;
}

/** Who to be. Never logged, never placed in an error message. */
export interface Credentials {
	readonly user: string;
	readonly password: string;
}

/** One open connection. */
export interface Connection {
	/**
	 * Runs one statement. Values go in `params`, positional, and are never spliced into `text`:
	 * what is stored is somebody else's message, and a message is not trusted to be inert.
	 */
	run(text: string, params?: readonly unknown[]): Promise<void>;
	/** Releases the connection. Safe to call after a failure, and never throws. */
	close(): Promise<void>;
}

export interface Driver {
	connect(target: Target, credentials: Credentials): Promise<Connection>;
}

/**
 * Engine name, as the provider spells it, to the family of wire protocol it speaks.
 *
 * The RDS API names engines `postgres`, `mysql`, `mariadb`, `aurora-postgresql`, `oracle-ee`,
 * `sqlserver-se` and so on. Only the families with a driver are listed: an engine that is absent
 * here is refused by name, which is a diagnosis, instead of being tried against the wrong
 * protocol, which is a hang.
 */
const FAMILIES: Readonly<Record<string, string>> = {
	postgres: 'postgres',
	'aurora-postgresql': 'postgres',
};

/** The port each family listens on unless the wire says otherwise. */
const DEFAULT_PORTS: Readonly<Record<string, number>> = {
	postgres: 5432,
};

const drivers = new Map<string, Driver>();

/** Registers the driver for a family. Called by the driver's own file when it is imported. */
export function useDriver(family: string, driver: Driver): void {
	drivers.set(family, driver);
}

/** Test seam, in the same spirit as `registry.reset`. Never call this from library code. */
export function resetDrivers(): void {
	drivers.clear();
}

/** The family of an engine, or `undefined` when no driver speaks it. */
export const familyOf = (engine: string): string | undefined => FAMILIES[engine.trim().toLowerCase()];

/**
 * Refuses an engine this build cannot talk to, by name.
 *
 * Separate from {@link connect} so a caller can refuse BEFORE doing the work that precedes the
 * connection — reading a credential out of Secrets Manager for a database nobody can open is a
 * read, a bill and an audit-log line for nothing.
 */
export function assertSupported(engine: string): string {
	const family = familyOf(engine);
	if (!family) {
		throw new Error(
			`no driver for the "${engine}" engine in this build (supported: ${[...new Set(Object.values(FAMILIES))].join(', ')})`
		);
	}
	if (!drivers.has(family)) {
		throw new Error(`the ${family} driver is not loaded in this build`);
	}
	return family;
}

export async function connect(engine: string, target: Target, credentials: Credentials): Promise<Connection> {
	const family = assertSupported(engine);
	return drivers.get(family)!.connect(target, credentials);
}

/**
 * Reads `host`, `host:port`, or a URL-shaped value into the two parts a connection needs.
 *
 * The grammar says ENDPOINT is `host` or `host:port`, and RDS writes the second form. Being liberal
 * about a scheme or a path costs nothing and means a wire carrying `https://host/...` reaches the
 * port check instead of failing on a parse error that says nothing about the wire.
 */
export function parseEndpoint(raw: string, engine: string): { host: string; port: number } {
	const authority =
		raw
			.trim()
			.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
			.split(/[/?#]/)[0] ?? '';

	const colon = authority.lastIndexOf(':');
	const host = colon === -1 ? authority : authority.slice(0, colon);
	if (!host) throw new Error(`the endpoint ${JSON.stringify(raw)} has no host`);

	if (colon === -1) {
		const port = DEFAULT_PORTS[familyOf(engine) ?? ''];
		if (port === undefined) throw new Error(`the endpoint ${JSON.stringify(raw)} has no port and the engine has no default`);
		return { host, port };
	}

	const port = Number(authority.slice(colon + 1));
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`the endpoint ${JSON.stringify(raw)} has an invalid port`);
	}
	return { host, port };
}
