// dist/runtimes/container.js
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

// dist/core/discovery.js
var COMMON_KEYS = [
  "NAME",
  "ARN",
  "URL",
  "ID",
  "BUCKET",
  "PATH",
  "ENDPOINT",
  "REGION",
  "ACCOUNT",
  "HANDLE"
];
var toEnvType = (catalogType) => catalogType.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
function parseName(name, vocab) {
  const byLength = (a, b) => b.length - a.length;
  const envTypes = vocab.types.map((t) => [toEnvType(t), t]).sort((a, b) => byLength(a[0], b[0]));
  const match = envTypes.find(([envType2]) => name.startsWith(envType2 + "_"));
  if (!match)
    return null;
  const [envType, catalogType] = match;
  const afterType = name.slice(envType.length + 1);
  const key = [...vocab.keys].sort(byLength).find((k) => afterType.startsWith(k + "_"));
  if (key === void 0)
    return null;
  const label = afterType.slice(key.length + 1);
  if (label === "")
    return null;
  return { type: catalogType, key, label };
}
function discover(source, vocab) {
  if (source === null || typeof source !== "object")
    return [];
  const byIdentity = /* @__PURE__ */ new Map();
  for (const [name, value] of Object.entries(source)) {
    if (value === void 0 || value === null)
      continue;
    const parsed = parseName(name, vocab);
    if (!parsed)
      continue;
    const identity = `${parsed.type}#${parsed.label}`;
    let neighbor = byIdentity.get(identity);
    if (!neighbor) {
      neighbor = { type: parsed.type, label: parsed.label, props: {} };
      byIdentity.set(identity, neighbor);
    }
    if (typeof value === "string")
      neighbor.props[parsed.key] = value;
    else
      neighbor.handle = value;
  }
  return [...byIdentity.values()].sort((a, b) => a.type.localeCompare(b.type) || a.label.localeCompare(b.label)).map((n) => n.handle === void 0 ? { type: n.type, label: n.label, props: n.props } : n);
}
var displayName = (n) => n.props["NAME"] ?? n.props["ARN"] ?? n.props["URL"] ?? n.props["ID"] ?? n.label;

// dist/core/envelope.js
var MARKER = "$hub";
var VERSION = 1;
var DEFAULT_HOPS = 3;
var hex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
var traceId = (at = /* @__PURE__ */ new Date()) => `1-${Math.floor(at.getTime() / 1e3).toString(16).padStart(8, "0")}-${hex(12)}`;
var spanId = () => hex(8);
var traceHeader = (trace) => `Root=${trace.root}${trace.parent ? `;Parent=${trace.parent}` : ""};Sampled=${trace.sampled ? "1" : "0"}`;
function open(body, self, opts = {}) {
  return {
    trace: opts.trace ?? traceId(),
    hops: opts.hops ?? DEFAULT_HOPS,
    path: [self],
    at: opts.at ?? (/* @__PURE__ */ new Date()).toISOString(),
    body
  };
}
function read(body) {
  if (!body.startsWith("{"))
    return null;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object")
    return null;
  const candidate = parsed;
  if (candidate[MARKER] !== VERSION)
    return null;
  if (typeof candidate.trace !== "string" || typeof candidate.body !== "string")
    return null;
  return {
    trace: candidate.trace,
    hops: typeof candidate.hops === "number" ? candidate.hops : 0,
    path: Array.isArray(candidate.path) ? candidate.path.filter((p) => typeof p === "string") : [],
    at: typeof candidate.at === "string" ? candidate.at : (/* @__PURE__ */ new Date(0)).toISOString(),
    body: candidate.body
  };
}
function advance(envelope, self) {
  if (envelope.hops <= 0)
    return null;
  return {
    ...envelope,
    hops: envelope.hops - 1,
    path: [...envelope.path, self]
  };
}
var seal = (envelope) => JSON.stringify({ [MARKER]: VERSION, ...envelope });
var isEnvelope = (value) => value !== null && typeof value === "object" && value[MARKER] === VERSION;

// dist/core/registry.js
var modules = /* @__PURE__ */ new Map();
function register(mod) {
  if (!mod.type || !/^[a-z][a-z0-9_]*$/.test(mod.type)) {
    throw new Error(`hub: invalid resource type ${JSON.stringify(mod.type)} (expected lowercase catalog type)`);
  }
  if (!mod.send && !mod.receive && !mod.consume) {
    throw new Error(`hub: resource ${mod.type} declares neither send nor receive nor consume; it could be discovered but never reached`);
  }
  const existing = modules.get(mod.type);
  if (existing && existing !== mod) {
    throw new Error(`hub: resource ${mod.type} is already registered`);
  }
  modules.set(mod.type, mod);
}
var get = (type) => modules.get(type);
var all = () => [...modules.values()];
var receivers = () => all().filter((m) => m.receive);
function vocabulary() {
  const keys = new Set(COMMON_KEYS);
  for (const mod of modules.values())
    for (const k of mod.keys ?? [])
      keys.add(k);
  return { types: [...modules.keys()], keys: [...keys] };
}

// dist/core/report.js
var reason = (err) => {
  let text;
  if (err instanceof Error)
    text = err.name === "Error" ? err.message : `${err.name}: ${err.message}`;
  else
    text = String(err);
  return text.length <= 300 ? text : text.slice(0, 300) + "\u2026";
};
var Trail = class {
  trace;
  origin;
  now;
  #hops = [];
  #failed = /* @__PURE__ */ new Set();
  #dropped = 0;
  constructor(trace, origin, now = () => Date.now()) {
    this.trace = trace;
    this.origin = origin;
    this.now = now;
  }
  /**
   * Runs one delivery and records it either way.
   *
   * Never rethrows. One broken wire must not take the other destinations down with it — that is
   * the difference between a report saying "three of four arrived" and an invocation that dies
   * on the first failure and tells you nothing about the rest.
   */
  async record(neighbor, itemId, deliver) {
    const started = this.now();
    try {
      await deliver();
      this.#push(neighbor, started, true);
      return true;
    } catch (err) {
      this.#push(neighbor, started, false, reason(err));
      if (itemId !== void 0)
        this.#failed.add(itemId);
      return false;
    }
  }
  /** Notes an item that ran out of hops. Counted, never hidden. */
  drop() {
    this.#dropped += 1;
  }
  #push(neighbor, started, ok, err) {
    this.#hops.push({
      n: this.#hops.length + 1,
      to: displayName(neighbor),
      type: neighbor.type,
      label: neighbor.label,
      ok,
      ms: this.now() - started,
      at: started,
      ...err === void 0 ? {} : { err }
    });
  }
  done() {
    return {
      trace: this.trace,
      origin: this.origin,
      hops: this.#hops,
      failed: [...this.#failed],
      dropped: this.#dropped
    };
  }
};
var seconds = (ms) => ms / 1e3;
function subsegment(hop, trace) {
  return {
    id: spanId(),
    name: hop.to,
    start_time: seconds(hop.at),
    end_time: seconds(hop.at + hop.ms),
    namespace: "remote",
    trace_id: trace.root,
    // The wire, so a red node in the console can be found in the drawing. `label` is the text on
    // the arrow and `n` its position in the fan-out; both are how the report already reads.
    annotations: { wire: hop.label, resource_type: hop.type, hop: hop.n },
    ...hop.ok ? {} : {
      error: true,
      cause: {
        exceptions: [{ id: spanId(), type: "DeliveryFailed", message: hop.err ?? "delivery failed" }]
      }
    }
  };
}
function segments(report, trace, self) {
  if (!trace.sampled || report.hops.length === 0)
    return [];
  if (trace.parent && !trace.opens) {
    return report.hops.map((hop) => JSON.stringify({ ...subsegment(hop, trace), type: "subsegment", parent_id: trace.parent }));
  }
  const starts = report.hops.map((hop) => hop.at);
  const ends = report.hops.map((hop) => hop.at + hop.ms);
  return [
    JSON.stringify({
      // The id the runtime already handed downstream, when it had one. Minting a fresh one here
      // would leave the next workload parented to a segment that was never written.
      id: trace.parent ?? spanId(),
      name: self,
      trace_id: trace.root,
      start_time: seconds(Math.min(...starts)),
      end_time: seconds(Math.max(...ends)),
      annotations: { origin: report.origin, dropped: report.dropped },
      ...report.hops.some((hop) => !hop.ok) ? { error: true } : {},
      subsegments: report.hops.map((hop) => subsegment(hop, trace))
    })
  ];
}

// dist/core/hub.js
async function normalize(raw) {
  for (const mod of receivers()) {
    const arrival = await mod.receive(raw);
    if (arrival)
      return arrival;
  }
  const body = typeof raw === "string" ? raw : JSON.stringify(raw ?? null);
  return { origin: "direct", describe: "direct invocation", items: [{ body }] };
}
async function handle(arrival, neighbors, ctx, opts = {}) {
  const chains = arrival.items.map((item) => read(item.body));
  const trace = opts.trace ?? chains.find((c) => c !== null)?.trace ?? traceId();
  const trail = new Trail(trace, arrival.origin, opts.now);
  const reachable = neighbors.filter((n) => get(n.type)?.send);
  for (const [index, item] of arrival.items.entries()) {
    const incoming = chains[index] ?? open(item.body, ctx.self, {
      trace,
      ...opts.at === void 0 ? {} : { at: opts.at },
      ...opts.hops === void 0 ? {} : { hops: opts.hops }
    });
    const outgoing = advance(incoming, ctx.self);
    if (!outgoing) {
      trail.drop();
      continue;
    }
    for (const neighbor of reachable) {
      const send2 = get(neighbor.type).send;
      await trail.record(neighbor, item.id, () => send2(neighbor, outgoing, ctx));
    }
  }
  return trail.done();
}

// node_modules/aws4fetch/dist/aws4fetch.esm.mjs
var encoder = new TextEncoder();
var HOST_SERVICES = {
  appstream2: "appstream",
  cloudhsmv2: "cloudhsm",
  email: "ses",
  marketplace: "aws-marketplace",
  mobile: "AWSMobileHubService",
  pinpoint: "mobiletargeting",
  queue: "sqs",
  "git-codecommit": "codecommit",
  "mturk-requester-sandbox": "mturk-requester",
  "personalize-runtime": "personalize"
};
var UNSIGNABLE_HEADERS = /* @__PURE__ */ new Set([
  "authorization",
  "content-type",
  "content-length",
  "user-agent",
  "presigned-expires",
  "expect",
  "x-amzn-trace-id",
  "range",
  "connection"
]);
var AwsClient = class {
  constructor({ accessKeyId, secretAccessKey, sessionToken, service, region, cache, retries, initRetryMs }) {
    if (accessKeyId == null) throw new TypeError("accessKeyId is a required option");
    if (secretAccessKey == null) throw new TypeError("secretAccessKey is a required option");
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.sessionToken = sessionToken;
    this.service = service;
    this.region = region;
    this.cache = cache || /* @__PURE__ */ new Map();
    this.retries = retries != null ? retries : 10;
    this.initRetryMs = initRetryMs || 50;
  }
  async sign(input, init) {
    if (input instanceof Request) {
      const { method, url, headers, body } = input;
      init = Object.assign({ method, url, headers }, init);
      if (init.body == null && headers.has("Content-Type")) {
        init.body = body != null && headers.has("X-Amz-Content-Sha256") ? body : await input.clone().arrayBuffer();
      }
      input = url;
    }
    const signer2 = new AwsV4Signer(Object.assign({ url: input.toString() }, init, this, init && init.aws));
    const signed = Object.assign({}, init, await signer2.sign());
    delete signed.aws;
    try {
      return new Request(signed.url.toString(), signed);
    } catch (e) {
      if (e instanceof TypeError) {
        return new Request(signed.url.toString(), Object.assign({ duplex: "half" }, signed));
      }
      throw e;
    }
  }
  async fetch(input, init) {
    for (let i = 0; i <= this.retries; i++) {
      const fetched = fetch(await this.sign(input, init));
      if (i === this.retries) {
        return fetched;
      }
      const res = await fetched;
      if (res.status < 500 && res.status !== 429) {
        return res;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.random() * this.initRetryMs * Math.pow(2, i)));
    }
    throw new Error("An unknown error occurred, ensure retries is not negative");
  }
};
var AwsV4Signer = class {
  constructor({ method, url, headers, body, accessKeyId, secretAccessKey, sessionToken, service, region, cache, datetime, signQuery, appendSessionToken, allHeaders, singleEncode }) {
    if (url == null) throw new TypeError("url is a required option");
    if (accessKeyId == null) throw new TypeError("accessKeyId is a required option");
    if (secretAccessKey == null) throw new TypeError("secretAccessKey is a required option");
    this.method = method || (body ? "POST" : "GET");
    this.url = new URL(url);
    this.headers = new Headers(headers || {});
    this.body = body;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.sessionToken = sessionToken;
    let guessedService, guessedRegion;
    if (!service || !region) {
      [guessedService, guessedRegion] = guessServiceRegion(this.url, this.headers);
    }
    this.service = service || guessedService || "";
    this.region = region || guessedRegion || "us-east-1";
    this.cache = cache || /* @__PURE__ */ new Map();
    this.datetime = datetime || (/* @__PURE__ */ new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
    this.signQuery = signQuery;
    this.appendSessionToken = appendSessionToken || this.service === "iotdevicegateway";
    this.headers.delete("Host");
    if (this.service === "s3" && !this.signQuery && !this.headers.has("X-Amz-Content-Sha256")) {
      this.headers.set("X-Amz-Content-Sha256", "UNSIGNED-PAYLOAD");
    }
    const params = this.signQuery ? this.url.searchParams : this.headers;
    params.set("X-Amz-Date", this.datetime);
    if (this.sessionToken && !this.appendSessionToken) {
      params.set("X-Amz-Security-Token", this.sessionToken);
    }
    this.signableHeaders = ["host", ...this.headers.keys()].filter((header) => allHeaders || !UNSIGNABLE_HEADERS.has(header)).sort();
    this.signedHeaders = this.signableHeaders.join(";");
    this.canonicalHeaders = this.signableHeaders.map((header) => header + ":" + (header === "host" ? this.url.host : (this.headers.get(header) || "").replace(/\s+/g, " "))).join("\n");
    this.credentialString = [this.datetime.slice(0, 8), this.region, this.service, "aws4_request"].join("/");
    if (this.signQuery) {
      if (this.service === "s3" && !params.has("X-Amz-Expires")) {
        params.set("X-Amz-Expires", "86400");
      }
      params.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
      params.set("X-Amz-Credential", this.accessKeyId + "/" + this.credentialString);
      params.set("X-Amz-SignedHeaders", this.signedHeaders);
    }
    if (this.service === "s3") {
      try {
        this.encodedPath = decodeURIComponent(this.url.pathname.replace(/\+/g, " "));
      } catch (e) {
        this.encodedPath = this.url.pathname;
      }
    } else {
      this.encodedPath = this.url.pathname.replace(/\/+/g, "/");
    }
    if (!singleEncode) {
      this.encodedPath = encodeURIComponent(this.encodedPath).replace(/%2F/g, "/");
    }
    this.encodedPath = encodeRfc3986(this.encodedPath);
    const seenKeys = /* @__PURE__ */ new Set();
    this.encodedSearch = [...this.url.searchParams].filter(([k]) => {
      if (!k) return false;
      if (this.service === "s3") {
        if (seenKeys.has(k)) return false;
        seenKeys.add(k);
      }
      return true;
    }).map((pair) => pair.map((p) => encodeRfc3986(encodeURIComponent(p)))).sort(([k1, v1], [k2, v2]) => k1 < k2 ? -1 : k1 > k2 ? 1 : v1 < v2 ? -1 : v1 > v2 ? 1 : 0).map((pair) => pair.join("=")).join("&");
  }
  async sign() {
    if (this.signQuery) {
      this.url.searchParams.set("X-Amz-Signature", await this.signature());
      if (this.sessionToken && this.appendSessionToken) {
        this.url.searchParams.set("X-Amz-Security-Token", this.sessionToken);
      }
    } else {
      this.headers.set("Authorization", await this.authHeader());
    }
    return {
      method: this.method,
      url: this.url,
      headers: this.headers,
      body: this.body
    };
  }
  async authHeader() {
    return [
      "AWS4-HMAC-SHA256 Credential=" + this.accessKeyId + "/" + this.credentialString,
      "SignedHeaders=" + this.signedHeaders,
      "Signature=" + await this.signature()
    ].join(", ");
  }
  async signature() {
    const date = this.datetime.slice(0, 8);
    const cacheKey = [this.secretAccessKey, date, this.region, this.service].join();
    let kCredentials = this.cache.get(cacheKey);
    if (!kCredentials) {
      const kDate = await hmac("AWS4" + this.secretAccessKey, date);
      const kRegion = await hmac(kDate, this.region);
      const kService = await hmac(kRegion, this.service);
      kCredentials = await hmac(kService, "aws4_request");
      this.cache.set(cacheKey, kCredentials);
    }
    return buf2hex(await hmac(kCredentials, await this.stringToSign()));
  }
  async stringToSign() {
    return [
      "AWS4-HMAC-SHA256",
      this.datetime,
      this.credentialString,
      buf2hex(await hash(await this.canonicalString()))
    ].join("\n");
  }
  async canonicalString() {
    return [
      this.method.toUpperCase(),
      this.encodedPath,
      this.encodedSearch,
      this.canonicalHeaders + "\n",
      this.signedHeaders,
      await this.hexBodyHash()
    ].join("\n");
  }
  async hexBodyHash() {
    let hashHeader = this.headers.get("X-Amz-Content-Sha256") || (this.service === "s3" && this.signQuery ? "UNSIGNED-PAYLOAD" : null);
    if (hashHeader == null) {
      if (this.body && typeof this.body !== "string" && !("byteLength" in this.body)) {
        throw new Error("body must be a string, ArrayBuffer or ArrayBufferView, unless you include the X-Amz-Content-Sha256 header");
      }
      hashHeader = buf2hex(await hash(this.body || ""));
    }
    return hashHeader;
  }
};
async function hmac(key, string) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? encoder.encode(key) : key,
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(string));
}
async function hash(content) {
  return crypto.subtle.digest("SHA-256", typeof content === "string" ? encoder.encode(content) : content);
}
var HEX_CHARS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"];
function buf2hex(arrayBuffer) {
  const buffer = new Uint8Array(arrayBuffer);
  let out = "";
  for (let idx = 0; idx < buffer.length; idx++) {
    const n = buffer[idx];
    out += HEX_CHARS[n >>> 4 & 15];
    out += HEX_CHARS[n & 15];
  }
  return out;
}
function encodeRfc3986(urlEncodedStr) {
  return urlEncodedStr.replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
function guessServiceRegion(url, headers) {
  const { hostname, pathname } = url;
  if (hostname.endsWith(".on.aws")) {
    const match2 = hostname.match(/^[^.]{1,63}\.lambda-url\.([^.]{1,63})\.on\.aws$/);
    return match2 != null ? ["lambda", match2[1] || ""] : ["", ""];
  }
  if (hostname.endsWith(".r2.cloudflarestorage.com")) {
    return ["s3", "auto"];
  }
  if (hostname.endsWith(".backblazeb2.com")) {
    const match2 = hostname.match(/^(?:[^.]{1,63}\.)?s3\.([^.]{1,63})\.backblazeb2\.com$/);
    return match2 != null ? ["s3", match2[1] || ""] : ["", ""];
  }
  const match = hostname.replace("dualstack.", "").match(/([^.]{1,63})\.(?:([^.]{0,63})\.)?amazonaws\.com(?:\.cn)?$/);
  let service = match && match[1] || "";
  let region = match && match[2];
  if (region === "us-gov") {
    region = "us-gov-west-1";
  } else if (region === "s3" || region === "s3-accelerate") {
    region = "us-east-1";
    service = "s3";
  } else if (service === "iot") {
    if (hostname.startsWith("iot.")) {
      service = "execute-api";
    } else if (hostname.startsWith("data.jobs.iot.")) {
      service = "iot-jobs-data";
    } else {
      service = pathname === "/mqtt" ? "iotdevicegateway" : "iotdata";
    }
  } else if (service === "autoscaling") {
    const targetPrefix = (headers.get("X-Amz-Target") || "").split(".")[0];
    if (targetPrefix === "AnyScaleFrontendService") {
      service = "application-autoscaling";
    } else if (targetPrefix === "AnyScaleScalingPlannerFrontendService") {
      service = "autoscaling-plans";
    }
  } else if (region == null && service.startsWith("s3-")) {
    region = service.slice(3).replace(/^fips-|^external-1/, "");
    service = "s3";
  } else if (service.endsWith("-fips")) {
    service = service.slice(0, -5);
  } else if (region && /-\d$/.test(service) && !/-\d$/.test(region)) {
    [service, region] = [region, service];
  }
  return [HOST_SERVICES[service] || service, region || ""];
}

// dist/providers/aws.js
var client;
function credentials(creds) {
  client = new AwsClient({ ...creds });
}
function signer() {
  if (client)
    return client;
  const env = typeof process === "undefined" ? {} : process.env;
  const accessKeyId = env["AWS_ACCESS_KEY_ID"];
  const secretAccessKey = env["AWS_SECRET_ACCESS_KEY"];
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("no AWS credentials: none in the environment and none supplied through credentials()");
  }
  const sessionToken = env["AWS_SESSION_TOKEN"];
  client = new AwsClient({
    accessKeyId,
    secretAccessKey,
    ...sessionToken === void 0 ? {} : { sessionToken }
  });
  return client;
}
var outgoingTrace;
function setTraceHeader(header) {
  outgoingTrace = header;
}
var endpoint = (service, region) => `https://${service}.${region}.amazonaws.com`;
async function fail(res, what) {
  const body = await res.text().catch(() => "");
  if (body.startsWith("{")) {
    try {
      const json2 = JSON.parse(body);
      const code2 = String(json2["__type"] ?? json2["code"] ?? res.status).split("#").pop();
      const message = json2["message"] ?? json2["Message"] ?? "";
      throw new Error(`${code2}: ${message || what}`);
    } catch (err) {
      if (err instanceof Error && err.message.includes(":"))
        throw err;
    }
  }
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
  if (code) {
    const message = /<Message>([^<]+)<\/Message>/.exec(body)?.[1];
    throw new Error(`${code}: ${message ?? what}`);
  }
  throw new Error(`HTTP ${res.status} on ${what}`);
}
async function send(url, service, region, init, what, fetchImpl) {
  const headers = new Headers(init.headers);
  if (outgoingTrace)
    headers.set("x-amzn-trace-id", outgoingTrace);
  const signed = await signer().sign(url, { ...init, headers, aws: { service, region } });
  const res = await fetchImpl(signed);
  if (!res.ok)
    await fail(res, what);
  return res;
}
var JSON_DIALECT = {
  dynamodb: "1.0",
  sqs: "1.0",
  kinesis: "1.1",
  firehose: "1.1",
  logs: "1.1",
  ssm: "1.1",
  secretsmanager: "1.1",
  events: "1.1"
};
async function json(service, region, target, body, fetchImpl = fetch) {
  const dialect = JSON_DIALECT[service];
  if (!dialect) {
    throw new Error(`unknown JSON dialect for service ${service}: add it to JSON_DIALECT in providers/aws.ts`);
  }
  const res = await send(endpoint(service, region), service, region, {
    method: "POST",
    headers: { "content-type": `application/x-amz-json-${dialect}`, "x-amz-target": target },
    body: JSON.stringify(body)
  }, target, fetchImpl);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
async function query(service, region, params, fetchImpl = fetch) {
  await send(endpoint(service, region), service, region, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString()
  }, params["Action"] ?? service, fetchImpl);
}
var rest = (url, service, region, init, what, fetchImpl = fetch) => send(url, service, region, init, what, fetchImpl);
async function plain(url, init, what, fetchImpl = fetch) {
  const res = await fetchImpl(url, init);
  if (!res.ok)
    throw new Error(`HTTP ${res.status} on ${what}`);
  return res;
}
var b64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes)
    binary += String.fromCharCode(byte);
  return btoa(binary);
};
var unb64 = (encoded) => {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};
var SEGMENT_BATCH = 50;
async function putTraceSegments(region, documents, fetchImpl = fetch) {
  const unprocessed = [];
  for (let i = 0; i < documents.length; i += SEGMENT_BATCH) {
    const res = await rest(`${endpoint("xray", region)}/TraceSegments`, "xray", region, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ TraceSegmentDocuments: documents.slice(i, i + SEGMENT_BATCH) })
    }, "PutTraceSegments", fetchImpl);
    const answer = await res.json().catch(() => null);
    for (const bad of answer?.UnprocessedTraceSegments ?? []) {
      unprocessed.push(`${bad.ErrorCode ?? "rejected"}: ${bad.Message ?? bad.Id ?? "no reason given"}`);
    }
  }
  return unprocessed;
}
async function emitTrace(report, trace, self, region, fetchImpl = fetch) {
  if (!trace || !region)
    return;
  const documents = segments(report, trace, self);
  if (documents.length === 0)
    return;
  try {
    const unprocessed = await putTraceSegments(region, documents, fetchImpl);
    if (unprocessed.length > 0) {
      console.error(JSON.stringify({ hub: "trace rejected", trace: trace.root, reasons: unprocessed }));
    }
  } catch (err) {
    console.error(JSON.stringify({
      hub: "trace not sent",
      trace: trace.root,
      error: err instanceof Error ? err.message : String(err)
    }));
  }
}

// dist/runtimes/container.js
var CREDENTIAL_HOST = "http://169.254.170.2";
var REFRESH_MARGIN_MS = 5 * 6e4;
var ASSUMED_LIFETIME_MS = 15 * 6e4;
var MAX_BODY_BYTES = 1024 * 1024;
var POLL_BACKOFF_MS = 5e3;
var LOADTEST_PATH = "/loadtest";
var LOADTEST_MAX_MS = 1e4;
var LOADTEST_DEFAULT_MS = 100;
var onish = (value) => {
  const v = (value ?? "").trim().toLowerCase();
  return v === "on" || v === "true" || v === "1" || v === "yes";
};
var loadtestEnabled = (env) => onish(env["HUB_LOADTEST"]);
var tracingEnabled = (env) => onish(env["HUB_TRACE"]);
function burnCpu(ms) {
  const target = Math.min(Math.max(ms, 0), LOADTEST_MAX_MS);
  const started = Date.now();
  let x = 0;
  while (Date.now() - started < target) {
    x = (x * 1103515245 + 12345) % 2147483647;
  }
  void x;
  return Date.now() - started;
}
var environment = () => typeof process === "undefined" ? {} : process.env;
async function taskCredentials(opts = {}) {
  const env = opts.env ?? environment();
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const relative = env["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"];
  const url = relative ? `${CREDENTIAL_HOST}${relative}` : env["AWS_CONTAINER_CREDENTIALS_FULL_URI"];
  if (!url)
    return null;
  const token = authorizationToken(env);
  const res = await fetchImpl(url, {
    ...token === void 0 ? {} : { headers: { authorization: token } }
  });
  if (!res.ok) {
    throw new Error(`container credential endpoint answered ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  if (!body.AccessKeyId || !body.SecretAccessKey) {
    throw new Error("container credential endpoint answered without a key pair");
  }
  const expiry = body.Expiration === void 0 ? Number.NaN : Date.parse(body.Expiration);
  return {
    accessKeyId: body.AccessKeyId,
    secretAccessKey: body.SecretAccessKey,
    ...body.Token === void 0 ? {} : { sessionToken: body.Token },
    ...Number.isNaN(expiry) ? {} : { expiresAt: expiry }
  };
}
function authorizationToken(env) {
  const inline = env["AWS_CONTAINER_AUTHORIZATION_TOKEN"];
  if (inline)
    return inline;
  const file = env["AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE"];
  if (!file)
    return void 0;
  return readFileSync(file, "utf8").trim();
}
var expiresAt = 0;
var inflight;
async function ensureCredentials(env, fetchImpl) {
  if (Date.now() < expiresAt - REFRESH_MARGIN_MS)
    return;
  inflight ??= refreshCredentials(env, fetchImpl).finally(() => {
    inflight = void 0;
  });
  await inflight;
}
async function refreshCredentials(env, fetchImpl) {
  const creds = await taskCredentials({ env, fetch: fetchImpl });
  if (!creds) {
    expiresAt = Number.POSITIVE_INFINITY;
    return;
  }
  credentials(creds);
  expiresAt = creds.expiresAt ?? Date.now() + ASSUMED_LIFETIME_MS;
}
function selectSource(neighbors, want) {
  const candidates = neighbors.filter((n) => get(n.type)?.consume);
  if (candidates.length === 0) {
    const drawn = neighbors.map((n) => `${n.type}/${n.label}`).join(", ") || "nothing";
    throw new Error(`HUB_POLL is set but no wired neighbor can be consumed. Wired: ${drawn}. A queue must be wired FROM this workload for the generator to emit it \u2014 see CONTRACT.md section 8.1.`);
  }
  const wanted = want.trim().toUpperCase();
  const names = (n) => [n.label, n.type, n.props["NAME"] ?? ""].map((s) => s.toUpperCase());
  const named = candidates.filter((n) => names(n).includes(wanted));
  if (named.length === 1)
    return named[0];
  if (named.length === 0 && candidates.length === 1)
    return candidates[0];
  const listed = candidates.map((n) => `${n.type}/${n.label}`).join(", ");
  throw new Error(`HUB_POLL=${want} does not name exactly one source; candidates: ${listed}`);
}
async function consumeOnce(source, targets, ctx, opts = {}) {
  const consume = get(source.type)?.consume;
  if (!consume)
    throw new Error(`resource ${source.type} cannot be consumed`);
  const batch = await consume(source, ctx);
  if (batch.items.length === 0)
    return null;
  const report = await handle(batch, targets, ctx, opts.hops === void 0 ? {} : { hops: opts.hops });
  const failed = new Set(report.failed);
  const delivered = batch.items.filter((item) => item.id === void 0 || !failed.has(item.id));
  if (delivered.length > 0)
    await batch.ack(delivered);
  return report;
}
async function readBody(req, limit) {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit)
    throw new PayloadTooLarge(limit);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk;
    size += buffer.length;
    if (size > limit)
      throw new PayloadTooLarge(limit);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
var PayloadTooLarge = class extends Error {
  constructor(limit) {
    super(`body exceeds ${limit} bytes`);
    this.name = "PayloadTooLarge";
  }
};
function respond(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text)
  });
  res.end(text);
}
function container(opts = {}) {
  const env = environment();
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  let neighbors;
  const wired = () => neighbors ??= discover(env, vocabulary());
  const ownRegion = () => env["REGION"] ?? env["AWS_REGION"];
  const newTrace = () => tracingEnabled(env) ? { root: traceId(), parent: spanId(), opens: true, sampled: true } : void 0;
  const context = (trace) => ({
    // The generator writes NAME for every node it injects variables into, and on ECS it carries
    // the container's own logical name rather than the task's — which is the name the report
    // should show, because the container is what ran.
    self: env["NAME"] ?? env["HOSTNAME"] ?? "hub",
    fetch: fetchImpl,
    // REGION and ACCOUNT are written unconditionally by the generator, so unlike the Lambda
    // runtime there is no account to recover from an invocation ARN. When they are absent the
    // senders refuse with a reason naming the wire, which is the right failure.
    region: (n) => n?.props["REGION"] ?? env["REGION"] ?? env["AWS_REGION"],
    account: (n) => n?.props["ACCOUNT"] ?? env["ACCOUNT"],
    now: () => /* @__PURE__ */ new Date(),
    ...trace === void 0 ? {} : { trace }
  });
  const finish = async (report, trace) => {
    try {
      await emitTrace(report, trace, context(trace).self, ownRegion(), fetchImpl);
    } finally {
      setTraceHeader(void 0);
    }
  };
  const route = async (req, res) => {
    const path = new URL(req.url ?? "/", "http://local").pathname;
    if (path === LOADTEST_PATH) {
      if (!loadtestEnabled(env)) {
        respond(res, 404, { error: "not found" });
        return;
      }
      if (req.method !== "POST") {
        respond(res, 405, { error: `${req.method ?? "method"} not allowed; use POST` });
        return;
      }
      const requested = Number(new URL(req.url ?? "/", "http://local").searchParams.get("ms"));
      const ms = Number.isFinite(requested) ? requested : LOADTEST_DEFAULT_MS;
      const burned = burnCpu(ms);
      respond(res, 200, { loadtest: true, requestedMs: Number.isFinite(requested) ? requested : null, burnedMs: burned });
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      respond(res, 200, { ok: true, self: env["NAME"] ?? null });
      return;
    }
    if (req.method !== "POST") {
      respond(res, 405, { error: `${req.method ?? "method"} not allowed; use POST` });
      return;
    }
    const body = await readBody(req, opts.maxBodyBytes ?? MAX_BODY_BYTES);
    await ensureCredentials(env, fetchImpl);
    const trace = newTrace();
    if (trace)
      setTraceHeader(traceHeader(trace));
    const arrival = await normalize(body);
    let report;
    try {
      report = await handle(arrival, wired(), context(trace), opts.hops === void 0 ? {} : { hops: opts.hops });
    } finally {
      setTraceHeader(void 0);
    }
    console.log(JSON.stringify({ hub: report, describe: arrival.describe }));
    await finish(report, trace);
    respond(res, 200, report);
  };
  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      const status = err instanceof PayloadTooLarge ? 413 : 500;
      const error = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ hub: "request failed", error }));
      if (!res.headersSent)
        respond(res, status, { error });
      else
        res.end();
    });
  });
  server.listen(opts.port ?? Number(env["PORT"] ?? 8080), "0.0.0.0");
  let stopping = false;
  const want = opts.poll === void 0 ? env["HUB_POLL"] : opts.poll;
  const polling = want ? loop(String(want)).catch((err) => {
    console.error(JSON.stringify({ hub: "poll setup failed", error: err instanceof Error ? err.message : String(err) }));
    process.exitCode = 1;
    server.close(() => process.exit(1));
  }) : Promise.resolve();
  async function loop(want2) {
    const source = selectSource(wired(), want2);
    const targets = wired().filter((n) => n !== source);
    console.log(JSON.stringify({ hub: "polling", source: `${source.type}/${source.label}`, targets: targets.length }));
    while (!stopping) {
      try {
        await ensureCredentials(env, fetchImpl);
        const trace = newTrace();
        if (trace)
          setTraceHeader(traceHeader(trace));
        let report = null;
        try {
          report = await consumeOnce(source, targets, context(trace), opts.hops === void 0 ? {} : { hops: opts.hops });
        } finally {
          setTraceHeader(void 0);
        }
        if (report) {
          console.log(JSON.stringify({ hub: report }));
          await finish(report, trace);
        }
      } catch (err) {
        console.error(JSON.stringify({ hub: "poll failed", error: err instanceof Error ? err.message : String(err) }));
        await new Promise((resolve) => setTimeout(resolve, POLL_BACKOFF_MS));
      }
    }
  }
  const stop = () => {
    stopping = true;
    server.close(() => {
      void polling.finally(() => process.exit(0));
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return server;
}

// dist/resources/aws_api_gateway_rest_api/index.js
register({
  type: "aws_api_gateway_rest_api",
  capabilities: ["http"],
  /**
   * Receive only.
   *
   * An API Gateway in a diagram sits in *front* of the workload; it is a way in, never a
   * destination. A wire pointing the other way would mean calling one's own front door.
   */
  receive(raw) {
    const event = raw;
    const rc = event?.requestContext;
    if (!rc?.apiId)
      return null;
    if (rc.domainName?.includes(".lambda-url."))
      return null;
    const method = event?.httpMethod ?? rc.http?.method ?? "?";
    const path = event?.path ?? event?.rawPath ?? rc.http?.path ?? "/";
    const body = event?.isBase64Encoded ? unb64(event.body ?? "") : event?.body ?? "";
    return {
      origin: "aws:apigateway",
      describe: `API Gateway ${method} ${path}${rc.stage ? ` (${rc.stage})` : ""}`,
      items: [{ body }]
    };
  }
});

// dist/resources/aws_appsync_graphql_api/index.js
var PROBE = "{ __schema { queryType { name } } }";
register({
  type: "aws_appsync_graphql_api",
  capabilities: ["http"],
  async send(n, envelope, ctx) {
    const url = n.props["URL"] ?? n.props["ENDPOINT"];
    if (!url)
      throw new Error("no GraphQL URL on the wire");
    const region = ctx.region(n);
    if (!region)
      throw new Error("no region for the API and none for the workload");
    await rest(url, "appsync", region, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: PROBE, variables: { trace: envelope.trace } })
    }, "appsync:GraphQL", ctx.fetch);
  }
});

// dist/resources/aws_cloudfront_distribution/index.js
register({
  type: "aws_cloudfront_distribution",
  capabilities: ["http"],
  /**
   * Receive only, for Lambda@Edge.
   *
   * Two things about this source are unlike the others, and both are limits rather than choices.
   *
   * The function runs in whichever edge location served the request, not in the region the
   * diagram drew, so every destination it forwards to is a cross-region call. Expect the report
   * to show slower hops than the same wire would in a regional function.
   *
   * Lambda@Edge also forbids environment variables entirely. This receiver works, but a hub
   * deployed *as* an edge function discovers no neighbours at all — the wiring contract has no
   * way to reach it. Reading a CloudFront event in an ordinary regional function is the case
   * that works.
   */
  receive(raw) {
    const cf = raw?.Records?.[0]?.cf;
    if (!cf?.config)
      return null;
    const { distributionId = "?", eventType = "?" } = cf.config;
    const request = cf.request;
    return {
      origin: "aws:cloudfront",
      describe: `CloudFront ${eventType} on ${distributionId}`,
      items: [{ body: `${request?.method ?? "?"} ${request?.uri ?? "/"}` }]
    };
  }
});

// dist/resources/aws_cloudwatch_event_bus/index.js
var SOURCE = "struct8.hub";
var DETAIL_TYPE = "Hub Message";
register({
  type: "aws_cloudwatch_event_bus",
  capabilities: ["topic"],
  /**
   * Send only, and the mirror of the rule next door: a bus is where events are published, a rule
   * is how they come back out. `aws_cloudwatch_event_rule` receives and never sends; this one
   * sends and never receives.
   */
  async send(n, envelope, ctx) {
    const bus = n.props["ARN"] ?? n.props["NAME"];
    if (!bus)
      throw new Error("no bus name and no bus ARN on the wire");
    const region = ctx.region(n);
    if (!region)
      throw new Error("no region for the bus and none for the workload");
    const answer = await json("events", region, "AWSEvents.PutEvents", {
      Entries: [
        {
          EventBusName: bus,
          Source: SOURCE,
          DetailType: DETAIL_TYPE,
          // The sealed envelope IS the detail, so the chain survives the bus: a rule
          // hands its target the detail as an object, the Hub on the other side
          // serializes it back, and the marker, the trace and the remaining hops are
          // all still in it.
          Detail: seal(envelope),
          // EventBridge's equivalent of the queue's system attribute, and it matters for
          // the same reason: the publisher and the rule's target never speak to each
          // other, so no HTTP header can carry the trace across. Absent when nothing is
          // being recorded.
          ...ctx.trace === void 0 ? {} : { TraceHeader: traceHeader(ctx.trace) }
        }
      ]
    }, ctx.fetch);
    const rejected = answer?.Entries?.find((e) => e.ErrorCode);
    if (rejected || answer?.FailedEntryCount) {
      throw new Error(`${rejected?.ErrorCode ?? "rejected"}: ${rejected?.ErrorMessage ?? "the bus rejected the event"}`);
    }
  }
});

// dist/resources/aws_cloudwatch_event_rule/index.js
register({
  type: "aws_cloudwatch_event_rule",
  capabilities: ["topic"],
  /**
   * Receive only. A rule is a way in — it delivers to the workload and is never a destination.
   *
   * Both shapes are accepted: a schedule, which carries no payload of its own and whose whole
   * meaning is "the clock fired", and a pattern match, which carries the matched event.
   */
  receive(raw) {
    const event = raw;
    if (typeof event?.source !== "string" || typeof event["detail-type"] !== "string")
      return null;
    const rule = event.resources?.[0]?.split("/").pop() ?? "?";
    const scheduled = event.source === "aws.events" && event["detail-type"] === "Scheduled Event";
    return {
      origin: "aws.events",
      describe: `EventBridge ${rule} (${event["detail-type"]})`,
      items: [
        {
          body: scheduled ? `scheduled fire of ${rule} at ${event.time ?? "unknown time"}` : JSON.stringify(event.detail ?? {})
        }
      ]
    };
  }
});

// dist/resources/aws_cloudwatch_log_group/index.js
var created = /* @__PURE__ */ new Set();
register({
  type: "aws_cloudwatch_log_group",
  capabilities: ["stream"],
  async send(n, envelope, ctx) {
    const group = n.props["NAME"];
    if (!group)
      throw new Error("no log group name on the wire");
    const region = ctx.region(n);
    if (!region)
      throw new Error("no region for the log group and none for the workload");
    const stream = ctx.self;
    const key = `${region}/${group}/${stream}`;
    if (!created.has(key)) {
      try {
        await json("logs", region, "Logs_20140328.CreateLogStream", { logGroupName: group, logStreamName: stream }, ctx.fetch);
      } catch (err) {
        if (!/ResourceAlreadyExists/i.test(err instanceof Error ? err.message : String(err)))
          throw err;
      }
      created.add(key);
    }
    await json("logs", region, "Logs_20140328.PutLogEvents", {
      logGroupName: group,
      logStreamName: stream,
      logEvents: [{ timestamp: ctx.now().getTime(), message: seal(envelope) }]
    }, ctx.fetch);
  }
});

// dist/resources/aws_cognito_user_pool/index.js
register({
  type: "aws_cognito_user_pool",
  capabilities: ["function"],
  /**
   * Receive only, and with a caution the report cannot express on its own.
   *
   * A user pool trigger is *synchronous and in the critical path of somebody signing in*. Unlike
   * every other source here, what this workload returns decides whether the user gets in. Hub
   * fans out and reports; it does not modify the event, so the pool sees an unchanged response
   * and the sign-in proceeds as it would have.
   *
   * The forwarding is still real, so a slow destination slows down a login. Worth knowing before
   * wiring this one to a long chain.
   */
  receive(raw) {
    const event = raw;
    if (typeof event?.triggerSource !== "string" || typeof event.userPoolId !== "string")
      return null;
    return {
      origin: "aws:cognito",
      describe: `Cognito ${event.triggerSource} on ${event.userPoolId}`,
      items: [{ body: `${event.triggerSource} for ${event.userName ?? "unknown user"}` }]
    };
  }
});

// dist/resources/aws_dynamodb_table/index.js
var KEY = "ID";
var TTL_SECONDS = 24 * 60 * 60;
register({
  type: "aws_dynamodb_table",
  capabilities: ["table"],
  async send(n, envelope, ctx) {
    const table = n.props["NAME"];
    if (!table)
      throw new Error("no table name on the wire");
    const region = ctx.region(n);
    if (!region)
      throw new Error("no region for the table and none for the workload");
    const now = ctx.now();
    await json("dynamodb", region, "DynamoDB_20120810.PutItem", {
      TableName: table,
      Item: {
        [KEY]: { S: `${ctx.self}:${now.toISOString()}` },
        Message: { S: seal(envelope) },
        Trace: { S: envelope.trace },
        TTL: { N: String(Math.floor(now.getTime() / 1e3) + TTL_SECONDS) }
      }
    }, ctx.fetch);
  },
  receive(raw) {
    const records = raw?.Records;
    if (!Array.isArray(records) || records[0]?.eventSource !== "aws:dynamodb")
      return null;
    const arn = records[0]?.eventSourceARN ?? "";
    const table = arn.includes("/") ? arn.split("/")[1] : arn.split(":").pop();
    const items = records.map((r) => ({
      ...r.dynamodb?.SequenceNumber === void 0 ? {} : { id: r.dynamodb.SequenceNumber },
      body: `${r.eventName ?? "?"} on ${table ?? "?"}, key ${JSON.stringify(r.dynamodb?.Keys ?? {})}`
    }));
    return {
      origin: "aws:dynamodb",
      describe: `DynamoDB Stream ${table ?? "?"} (${items.length} record(s))`,
      items
    };
  }
});

// dist/resources/aws_kinesis_firehose_delivery_stream/index.js
register({
  type: "aws_kinesis_firehose_delivery_stream",
  capabilities: ["stream"],
  async send(n, envelope, ctx) {
    const stream = n.props["NAME"];
    if (!stream)
      throw new Error("no delivery stream name on the wire");
    const region = ctx.region(n);
    if (!region)
      throw new Error("no region for the delivery stream and none for the workload");
    await json("firehose", region, "Firehose_20150804.PutRecord", {
      DeliveryStreamName: stream,
      // The trailing newline is what separates records inside the object Firehose
      // eventually writes to its destination. Without it the delivered file is one
      // concatenated line and nothing downstream can split it back apart.
      Record: { Data: b64(seal(envelope) + "\n") }
    }, ctx.fetch);
  }
});

// dist/resources/aws_kinesis_stream/index.js
register({
  type: "aws_kinesis_stream",
  capabilities: ["stream"],
  async send(n, envelope, ctx) {
    const stream = n.props["NAME"];
    if (!stream)
      throw new Error("no stream name on the wire");
    const region = ctx.region(n);
    if (!region)
      throw new Error("no region for the stream and none for the workload");
    await json("kinesis", region, "Kinesis_20131202.PutRecord", {
      StreamName: stream,
      // The JSON protocol carries Data base64-encoded; the SDKs hide this and hand-written
      // callers routinely forget it, which produces a record that reads back as garbage.
      Data: b64(seal(envelope) + "\n"),
      // A fixed key keeps a test run in one shard and therefore in order. With several
      // shards and a varying key the records still arrive, just not in the order sent —
      // which looks like a bug when you are trying to prove a wire works.
      PartitionKey: ctx.self
    }, ctx.fetch);
  },
  receive(raw) {
    const records = raw?.Records;
    if (!Array.isArray(records) || records[0]?.eventSource !== "aws:kinesis")
      return null;
    const arn = records[0]?.eventSourceARN ?? "";
    const stream = arn.includes("/") ? arn.split("/")[1] : arn.split(":").pop();
    const items = records.map((r) => {
      let body;
      try {
        body = unb64(r.kinesis?.data ?? "").trimEnd();
      } catch {
        body = "<record is not valid base64>";
      }
      return {
        ...r.kinesis?.sequenceNumber === void 0 ? {} : { id: r.kinesis.sequenceNumber },
        body
      };
    });
    return {
      origin: "aws:kinesis",
      describe: `Kinesis ${stream ?? "?"} (${items.length} record(s))`,
      items
    };
  }
});

// dist/resources/aws_kinesis_video_stream/index.js
register({
  type: "aws_kinesis_video_stream",
  capabilities: ["stream"],
  /**
   * Describes the stream instead of writing to it, and the distinction is worth being clear
   * about.
   *
   * Ingesting into Kinesis Video means `PutMedia`: a long-lived chunked upload of MKV fragments
   * to a per-stream data endpoint. That is not a request, it is a session, and synthesising a
   * valid fragment out of a text message would prove nothing about anybody's pipeline.
   *
   * So this wire is exercised by resolving the stream. The report line means "the stream exists,
   * the name resolved, the permission is there" — not "media arrived". Anything stronger would
   * need the diagram to say what the media is, which no wire can.
   */
  async send(n, _envelope, ctx) {
    const stream = n.props["NAME"];
    if (!stream)
      throw new Error("no stream name on the wire");
    const region = ctx.region(n);
    if (!region)
      throw new Error("no region for the stream and none for the workload");
    await rest(`${endpoint("kinesisvideo", region)}/describeStream`, "kinesisvideo", region, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ StreamName: stream })
    }, "kinesisvideo:DescribeStream", ctx.fetch);
  }
});

// dist/resources/aws_lambda_function/index.js
register({
  type: "aws_lambda_function",
  capabilities: ["function"],
  async send(n, envelope, ctx) {
    const name = n.props["NAME"];
    if (!name)
      throw new Error("no function name on the wire");
    const region = ctx.region(n);
    if (!region)
      throw new Error("no region for the function and none for the workload");
    await rest(`${endpoint("lambda", region)}/2015-03-31/functions/${encodeURIComponent(name)}/invocations`, "lambda", region, {
      method: "POST",
      // Asynchronous on purpose. A synchronous invoke would hold this workload open for
      // the whole downstream chain, and a chain of four would time out before the report
      // could be written.
      headers: { "x-amz-invocation-type": "Event", "content-type": "application/json" },
      body: seal(envelope)
    }, "lambda:InvokeFunction", ctx.fetch);
  },
  /**
   * A hub invoked by another hub receives the envelope as the payload itself, already parsed.
   * Recognising it here keeps the chain intact; falling through to the generic arrival would
   * re-wrap it and reset the hop budget, and a cycle would then never terminate.
   */
  receive(raw) {
    if (!isEnvelope(raw))
      return null;
    return {
      origin: "aws:lambda",
      describe: "invoked by another workload",
      items: [{ body: JSON.stringify(raw) }]
    };
  }
});

// dist/resources/aws_lambda_function_url/index.js
register({
  type: "aws_lambda_function_url",
  capabilities: ["http"],
  async send(n, envelope, ctx) {
    const url = n.props["URL"] ?? n.props["ENDPOINT"];
    if (!url)
      throw new Error("no URL on the wire for the function URL");
    const region = ctx.region(n);
    if (!region)
      throw new Error("no region for the function URL and none for the workload");
    await rest(url, "lambda", region, { method: "POST", headers: { "content-type": "application/json" }, body: seal(envelope) }, "lambda function URL", ctx.fetch);
  },
  receive(raw) {
    const event = raw;
    const domain = event?.requestContext?.domainName;
    if (!domain?.includes(".lambda-url."))
      return null;
    const http = event?.requestContext?.http;
    const body = event?.isBase64Encoded ? unb64(event.body ?? "") : event?.body ?? "";
    return {
      origin: "aws:lambda_url",
      describe: `function URL ${http?.method ?? "?"} ${http?.path ?? "/"}`,
      items: [{ body }]
    };
  }
});

// dist/resources/aws_lb/index.js
register({
  type: "aws_lb",
  capabilities: ["http"],
  async send(n, envelope, ctx) {
    const host = n.props["URL"] ?? n.props["ENDPOINT"] ?? n.props["NAME"];
    if (!host)
      throw new Error("no DNS name on the wire for the load balancer");
    const url = /^https?:\/\//.test(host) ? host : `http://${host}/`;
    await plain(url, { method: "POST", headers: { "content-type": "application/json" }, body: seal(envelope) }, `POST ${url}`, ctx.fetch);
  },
  receive(raw) {
    const event = raw;
    const elb = event?.requestContext?.elb;
    if (!elb)
      return null;
    const target = elb.targetGroupArn?.split(":").pop() ?? "?";
    const body = event?.isBase64Encoded ? unb64(event.body ?? "") : event?.body ?? "";
    return {
      origin: "aws:elb",
      describe: `ALB ${event?.httpMethod ?? "?"} ${event?.path ?? "/"} \u2192 ${target}`,
      items: [{ body }]
    };
  }
});

// dist/resources/aws_s3_bucket/index.js
var stamp = () => (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
register({
  type: "aws_s3_bucket",
  capabilities: ["object-store"],
  async send(n, envelope, ctx) {
    const bucket = n.props["BUCKET"] ?? n.props["NAME"];
    if (!bucket)
      throw new Error("no bucket name on the wire");
    const region = ctx.region(n);
    if (!region)
      throw new Error("no region for the bucket and none for the workload");
    const key = `${ctx.self}/${stamp()}.json`;
    await rest(`https://${bucket}.s3.${region}.amazonaws.com/${key}`, "s3", region, { method: "PUT", headers: { "content-type": "application/json" }, body: seal(envelope) }, "s3:PutObject", ctx.fetch);
  },
  async receive(raw) {
    const records = raw?.Records;
    const first = Array.isArray(records) ? records[0] : void 0;
    if (!first?.s3)
      return null;
    const bucket = first.s3.bucket?.name ?? "?";
    const key = decodeURIComponent((first.s3.object?.key ?? "").replace(/\+/g, " "));
    const size = first.s3.object?.size ?? 0;
    const region = first.awsRegion ?? "";
    let body = `object ${key} (${size} bytes, not text)`;
    if (/\.(txt|json|csv|log|md)$/i.test(key) && region) {
      try {
        const res = await rest(`https://${bucket}.s3.${region}.amazonaws.com/${key}`, "s3", region, { method: "GET" }, "s3:GetObject");
        body = await res.text();
      } catch (err) {
        body = `object ${key} could not be read: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    return {
      origin: "aws:s3",
      describe: `S3 ${bucket}/${key} (${size} bytes)`,
      items: [{ body }]
    };
  }
});

// dist/resources/aws_secretsmanager_secret/index.js
register({
  type: "aws_secretsmanager_secret",
  keys: ["SECRET_ARN"],
  capabilities: ["secret"],
  /**
   * Writes the message as the secret's current value.
   *
   * Same reasoning as the parameter store: the wire leaving a workload is that workload's runtime
   * permission, and a destination that is only ever read produces a report line indistinguishable
   * from one that received something.
   *
   * Secrets Manager has no overwrite. `PutSecretValue` adds a version and moves the `AWSCURRENT`
   * label onto it, which from the reader's side is the same outcome — a read returns the last
   * write — with the previous value kept as `AWSPREVIOUS` because that is the service's model and
   * not a choice available here.
   *
   * `ClientRequestToken` is minted per call. The SDKs fill it in and the raw API does not, and
   * without it the service's idempotency check cannot tell two writes of the same message apart.
   *
   * Nothing about the value reaches the log or the report — the same rule as when this read, for
   * the same reason: a tool that prints what lives in a secret store is one nobody may run.
   */
  async send(n, envelope, ctx) {
    const id = n.props["SECRET_ARN"] ?? n.props["ARN"] ?? n.props["NAME"];
    if (!id)
      throw new Error("no secret identifier on the wire");
    const region = ctx.region(n);
    if (!region)
      throw new Error("no region for the secret and none for the workload");
    await json("secretsmanager", region, "secretsmanager.PutSecretValue", { SecretId: id, SecretString: seal(envelope), ClientRequestToken: crypto.randomUUID() }, ctx.fetch);
  }
});

// dist/resources/aws_sns_topic/index.js
register({
  type: "aws_sns_topic",
  capabilities: ["topic"],
  async send(n, envelope, ctx) {
    const region = ctx.region(n);
    if (!region)
      throw new Error("no region for the topic and none for the workload");
    let arn = n.props["ARN"];
    if (!arn) {
      const name = n.props["NAME"];
      const account = ctx.account(n);
      if (!name)
        throw new Error("no topic name and no topic ARN on the wire");
      if (!account)
        throw new Error(`no account for topic ${name}, and none for the workload`);
      arn = `arn:aws:sns:${region}:${account}:${name}`;
    }
    await query("sns", region, { Action: "Publish", Version: "2010-03-31", TopicArn: arn, Message: seal(envelope) }, ctx.fetch);
  },
  receive(raw) {
    const records = raw?.Records;
    const sns = Array.isArray(records) ? records[0]?.Sns : void 0;
    if (!sns)
      return null;
    const topic = sns.TopicArn?.split(":").pop() ?? "?";
    return {
      origin: "aws:sns",
      describe: `SNS ${topic}`,
      items: [{ body: sns.Message ?? "" }]
    };
  }
});

// dist/resources/aws_sqs_queue/index.js
var BATCH = 10;
var WAIT_SECONDS = 20;
function queueUrl(n, ctx, region) {
  const given = n.props["QUEUE_URL"] ?? n.props["URL"];
  if (given)
    return given;
  const name = n.props["NAME"];
  const account = ctx.account(n);
  if (!name)
    throw new Error("no queue name and no queue URL on the wire");
  if (!account)
    throw new Error(`no account for queue ${name}, and none for the workload`);
  return `https://sqs.${region}.amazonaws.com/${account}/${name}`;
}
function regionFor(n, ctx) {
  const region = ctx.region(n);
  if (!region)
    throw new Error("no region for the queue and none for the workload");
  return region;
}
register({
  type: "aws_sqs_queue",
  keys: ["QUEUE_URL"],
  capabilities: ["queue"],
  async send(n, envelope, ctx) {
    const region = regionFor(n, ctx);
    await json("sqs", region, "AmazonSQS.SendMessage", {
      QueueUrl: queueUrl(n, ctx, region),
      MessageBody: seal(envelope),
      // A SYSTEM attribute, and the only one SQS defines. It is what a consumer inherits the
      // trace from — a Lambda event source mapping reads it and opens its invocation under
      // the same trace, which is the one hop no HTTP header can carry, because the sender and
      // the consumer never speak to each other. Absent when nothing is being recorded, so a
      // queue that is not traced is sent exactly the request it was sent before.
      ...ctx.trace === void 0 ? {} : {
        MessageSystemAttributes: {
          AWSTraceHeader: { DataType: "String", StringValue: traceHeader(ctx.trace) }
        }
      }
    }, ctx.fetch);
  },
  receive(raw) {
    const records = raw?.Records;
    if (!Array.isArray(records) || records[0]?.eventSource !== "aws:sqs")
      return null;
    const queue = records[0]?.eventSourceARN?.split(":").pop() ?? "?";
    const items = records.map((r) => ({
      // Present because a queue accepts a partial-batch report: without the id, one failed
      // message forces the whole batch to be redelivered.
      ...r.messageId === void 0 ? {} : { id: r.messageId },
      body: r.body ?? ""
    }));
    return { origin: "aws:sqs", describe: `SQS ${queue} (${items.length} record(s))`, items };
  },
  /**
   * Reads the queue directly, for a runtime AWS does not poll on its behalf.
   *
   * This is the same work the Lambda event source mapping does invisibly. Nothing here is new
   * behaviour — it is the half of the queue that Lambda hid.
   */
  async consume(n, ctx) {
    const region = regionFor(n, ctx);
    const url = queueUrl(n, ctx, region);
    const answer = await json("sqs", region, "AmazonSQS.ReceiveMessage", { QueueUrl: url, MaxNumberOfMessages: BATCH, WaitTimeSeconds: WAIT_SECONDS }, ctx.fetch);
    const handles = /* @__PURE__ */ new Map();
    const items = [];
    for (const message of answer?.Messages ?? []) {
      if (message.MessageId === void 0 || message.ReceiptHandle === void 0)
        continue;
      handles.set(message.MessageId, message.ReceiptHandle);
      items.push({ id: message.MessageId, body: message.Body ?? "" });
    }
    const name = n.props["NAME"] ?? url.split("/").pop() ?? "?";
    return {
      origin: "aws:sqs",
      describe: `SQS ${name} (${items.length} message(s), polled)`,
      items,
      async ack(delivered) {
        const entries = delivered.map((item) => {
          const handle2 = item.id === void 0 ? void 0 : handles.get(item.id);
          return handle2 === void 0 ? void 0 : { Id: item.id, ReceiptHandle: handle2 };
        }).filter((entry) => entry !== void 0);
        if (entries.length === 0)
          return;
        await json("sqs", region, "AmazonSQS.DeleteMessageBatch", { QueueUrl: url, Entries: entries }, ctx.fetch);
      }
    };
  }
});

// dist/resources/aws_ssm_parameter/index.js
register({
  type: "aws_ssm_parameter",
  capabilities: ["parameter"],
  /**
   * Writes the message, replacing whatever was there.
   *
   * A parameter is a destination like any other here: the wire leaving a workload for it is that
   * workload's runtime permission, and an application keeping state in a parameter writes to it.
   * The bucket beside it gets `PutObject` and the table gets `PutItem`; this one used to get
   * reading alone, which produced a report line shaped exactly like theirs while nothing arrived.
   *
   * `Overwrite` rather than a version: a parameter holds one value, and a read returns the last
   * write. Nothing accumulates.
   *
   * `Type` is deliberately absent. AWS requires it only for a parameter that does not exist yet,
   * and sending it on an overwrite is how you get a refusal for changing the type of a
   * `SecureString` somebody chose on purpose. A parameter drawn on the diagram exists; if it does
   * not, AWS says exactly that and the report carries it.
   *
   * Standard-tier parameters cap at 4 KB, so a larger message is refused by AWS in its own words.
   */
  async send(n, envelope, ctx) {
    const name = n.props["NAME"];
    if (!name)
      throw new Error("no parameter name on the wire");
    const region = ctx.region(n);
    if (!region)
      throw new Error("no region for the parameter and none for the workload");
    await json("ssm", region, "AmazonSSM.PutParameter", { Name: name, Value: seal(envelope), Overwrite: true }, ctx.fetch);
  }
});

// .bundle-entry.mjs
container();
