import { DataFactory } from "n3";
import type {
  BlankNode,
  Literal,
  NamedNode,
  Quad,
  Quad_Graph,
  Quad_Object,
  Quad_Subject,
} from "n3";

/**
 * JSON-LD ⇄ RDF for the edge.
 *
 * N3.js does not handle JSON-LD, and `jsonld.js` is too large for the Worker
 * script-size budget. This is a **dependency-free** JSON-LD ↔ quads converter
 * covering the subset `@dwk/solid-pod` content negotiation needs. See
 * `spec/open-questions.md` §4 and the README for the exact supported subset and
 * its known limitations.
 */

/** A parsed JSON value. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON object. */
export type JsonObject = { [key: string]: JsonValue };

/** Error raised for malformed or unsupported JSON-LD input. */
export class JsonLdError extends Error {
  constructor(message: string) {
    super(`@dwk/rdf: ${message}`);
    this.name = "JsonLdError";
  }
}

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const XSD = "http://www.w3.org/2001/XMLSchema#";
const RDF_TYPE = `${RDF}type`;
const RDF_FIRST = `${RDF}first`;
const RDF_REST = `${RDF}rest`;
const RDF_NIL = `${RDF}nil`;
const RDF_LIST = `${RDF}List`;
const RDF_LANGSTRING = `${RDF}langString`;
const XSD_STRING = `${XSD}string`;
const XSD_BOOLEAN = `${XSD}boolean`;
const XSD_INTEGER = `${XSD}integer`;
const XSD_DOUBLE = `${XSD}double`;

// --- Active context -------------------------------------------------------

interface TermDefinition {
  /** IRI mapping, or `null` when the term is explicitly disabled. */
  id: string | null;
  /** Type coercion: an IRI datatype, or the keywords `"@id"` / `"@vocab"`. */
  type?: string;
  /** Language coercion (`null` clears the default language). */
  language?: string | null;
  /** Container mapping (`"@list"`, `"@set"`, …). */
  container?: string;
  /** Whether the term is a reverse property. */
  reverse?: boolean;
}

interface ActiveContext {
  base?: string;
  vocab?: string;
  language?: string;
  terms: Map<string, TermDefinition>;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayify(value: JsonValue | undefined): JsonValue[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function isKeyword(value: string): boolean {
  return value.startsWith("@");
}

function isIriType(type: string | undefined): type is string {
  return type !== undefined && type !== "@id" && type !== "@vocab";
}

// An absolute IRI begins with a scheme (`http:`, `urn:`, …). A value without a
// scheme is a relative reference; JSON-LD 1.0 drops it (rather than emitting a
// bogus RDF term) when no base resolves it to an absolute IRI.
const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:/;
function isAbsoluteIri(value: string): boolean {
  return ABSOLUTE_IRI.test(value);
}

function resolveIri(base: string | undefined, value: string): string {
  if (base === undefined) return value;
  try {
    return new URL(value, base).href;
  } catch {
    return value;
  }
}

/**
 * Expand a term, CURIE, or IRI against the active context. With `vocab`, terms
 * and `@vocab` apply (property / `@type` position); otherwise relative IRIs are
 * resolved against `@base` (`@id` position).
 */
function expandIri(
  active: ActiveContext,
  value: string,
  opts: { vocab?: boolean } = {},
): string {
  if (isKeyword(value)) return value;

  const term = active.terms.get(value);
  // A term whose definition is `null` is explicitly disabled: it expands to
  // nothing (callers drop empty results) rather than to a bogus IRI.
  if (opts.vocab && term) return term.id ?? "";

  const colon = value.indexOf(":");
  if (colon > 0) {
    const prefix = value.slice(0, colon);
    const suffix = value.slice(colon + 1);
    if (prefix === "_" || suffix.startsWith("//")) return value;
    const prefixDef = active.terms.get(prefix);
    if (prefixDef?.id) return prefixDef.id + suffix;
    return value;
  }

  if (opts.vocab) {
    return active.vocab !== undefined ? active.vocab + value : value;
  }
  return resolveIri(active.base, value);
}

function createTermDefinition(
  active: ActiveContext,
  term: string,
  definition: JsonValue,
): TermDefinition {
  if (definition === null) return { id: null };

  if (typeof definition === "string") {
    return { id: expandIri(active, definition, { vocab: true }) };
  }
  if (!isObject(definition)) {
    throw new JsonLdError(`invalid term definition for "${term}"`);
  }

  const def: TermDefinition = { id: null };
  if ("@reverse" in definition && definition["@reverse"] != null) {
    def.reverse = true;
    def.id = expandIri(active, String(definition["@reverse"]), { vocab: true });
  } else if ("@id" in definition) {
    const id = definition["@id"];
    def.id = id == null ? null : expandIri(active, String(id), { vocab: true });
  } else {
    def.id = expandIri(active, term, { vocab: true });
  }

  if ("@type" in definition && definition["@type"] != null) {
    const type = String(definition["@type"]);
    def.type =
      type === "@id" || type === "@vocab"
        ? type
        : expandIri(active, type, { vocab: true });
  }
  if ("@language" in definition) {
    const language = definition["@language"];
    def.language = language == null ? null : String(language).toLowerCase();
  }
  if ("@container" in definition && definition["@container"] != null) {
    const container = definition["@container"];
    def.container = String(Array.isArray(container) ? container[0] : container);
  }
  return def;
}

function processContext(
  active: ActiveContext,
  local: JsonValue,
): ActiveContext {
  const result: ActiveContext = { ...active, terms: new Map(active.terms) };

  for (const entry of arrayify(local)) {
    if (entry === null) {
      result.terms = new Map();
      delete result.vocab;
      delete result.language;
      continue;
    }
    if (typeof entry === "string") {
      throw new JsonLdError(
        `remote @context (${JSON.stringify(entry)}) is not supported; inline the context`,
      );
    }
    if (!isObject(entry)) {
      throw new JsonLdError("invalid @context entry");
    }
    for (const [key, value] of Object.entries(entry)) {
      switch (key) {
        case "@base":
          result.base = value == null ? undefined : String(value);
          break;
        case "@vocab":
          result.vocab = value == null ? undefined : String(value);
          break;
        case "@language":
          result.language =
            value == null ? undefined : String(value).toLowerCase();
          break;
        case "@version":
        case "@protected":
        case "@import":
          break;
        default:
          result.terms.set(key, createTermDefinition(result, key, value));
      }
    }
  }
  return result;
}

// --- Expansion to RDF -----------------------------------------------------

class RdfEmitter {
  readonly quads: Quad[] = [];
  private counter = 0;
  private readonly blanks = new Map<string, BlankNode>();

  private blankFor(label: string): BlankNode {
    let blank = this.blanks.get(label);
    if (!blank) {
      blank = DataFactory.blankNode(`b${this.counter++}`);
      this.blanks.set(label, blank);
    }
    return blank;
  }

  private fresh(): BlankNode {
    return DataFactory.blankNode(`b${this.counter++}`);
  }

  private emit(
    subject: Quad_Subject,
    predicate: NamedNode,
    object: Quad_Object,
    graph: Quad_Graph,
  ): void {
    this.quads.push(DataFactory.quad(subject, predicate, object, graph));
  }

  /** Process a top-level document (node, array of nodes, or default-graph wrapper). */
  toRdf(input: JsonValue, active: ActiveContext): void {
    for (const item of arrayify(input)) {
      if (!isObject(item)) continue;
      const ctx =
        "@context" in item ? processContext(active, item["@context"]) : active;

      if ("@graph" in item && !("@id" in item)) {
        for (const node of arrayify(item["@graph"])) {
          if (isObject(node)) {
            this.processNode(node, ctx, DataFactory.defaultGraph());
          }
        }
        continue;
      }
      this.processNode(item, ctx, DataFactory.defaultGraph());
    }
  }

  /**
   * Resolve an already-expanded `@id` to a subject/object term, or `null` when
   * it is still a relative reference (JSON-LD 1.0 drops such terms rather than
   * minting an invalid NamedNode).
   */
  private idToTerm(id: string): NamedNode | BlankNode | null {
    if (id.startsWith("_:")) return this.blankFor(id);
    return isAbsoluteIri(id) ? DataFactory.namedNode(id) : null;
  }

  private nodeSubject(
    node: JsonObject,
    active: ActiveContext,
  ): NamedNode | BlankNode | null {
    if ("@id" in node && node["@id"] != null) {
      return this.idToTerm(expandIri(active, String(node["@id"])));
    }
    return this.fresh();
  }

  private processNode(
    node: JsonObject,
    context: ActiveContext,
    graph: Quad_Graph,
  ): NamedNode | BlankNode | null {
    const active =
      "@context" in node ? processContext(context, node["@context"]) : context;
    const subject = this.nodeSubject(node, active);
    // An explicit but unresolvable (relative) @id drops the whole node.
    if (!subject) return null;

    for (const type of arrayify(node["@type"])) {
      const iri = expandIri(active, String(type), { vocab: true });
      if (iri && !isKeyword(iri) && isAbsoluteIri(iri)) {
        this.emit(
          subject,
          DataFactory.namedNode(RDF_TYPE),
          DataFactory.namedNode(iri),
          graph,
        );
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "@context" || key === "@id" || key === "@type") continue;

      if (key === "@graph") {
        for (const inner of arrayify(value)) {
          if (isObject(inner)) this.processNode(inner, active, subject);
        }
        continue;
      }
      if (key === "@reverse") {
        if (isObject(value)) this.processReverse(value, subject, active, graph);
        continue;
      }
      if (isKeyword(key)) continue; // @index, @included, … unsupported — skip

      const predicateIri = expandIri(active, key, { vocab: true });
      if (
        !predicateIri ||
        isKeyword(predicateIri) ||
        !isAbsoluteIri(predicateIri)
      ) {
        continue;
      }
      const predicate = DataFactory.namedNode(predicateIri);
      const def = active.terms.get(key);

      if (def?.container === "@list") {
        const head = this.buildList(arrayify(value), def, active, graph);
        this.emit(subject, predicate, head, graph);
        continue;
      }

      for (const item of arrayify(value)) {
        if (isObject(item) && "@list" in item) {
          const head = this.buildList(
            arrayify(item["@list"]),
            def,
            active,
            graph,
          );
          this.emit(subject, predicate, head, graph);
          continue;
        }
        const object = this.valueToObject(item, def, active, graph);
        if (!object) continue;
        if (def?.reverse) {
          // A literal cannot be the subject of a triple — drop reverse literals.
          if (object.termType !== "Literal") {
            this.emit(object as Quad_Subject, predicate, subject, graph);
          }
        } else {
          this.emit(subject, predicate, object, graph);
        }
      }
    }
    return subject;
  }

  private processReverse(
    reverse: JsonObject,
    subject: NamedNode | BlankNode,
    active: ActiveContext,
    graph: Quad_Graph,
  ): void {
    for (const [key, value] of Object.entries(reverse)) {
      const predicateIri = expandIri(active, key, { vocab: true });
      if (
        !predicateIri ||
        isKeyword(predicateIri) ||
        !isAbsoluteIri(predicateIri)
      ) {
        continue;
      }
      const predicate = DataFactory.namedNode(predicateIri);
      const def = active.terms.get(key);
      for (const item of arrayify(value)) {
        const object = this.valueToObject(item, def, active, graph);
        // A literal cannot be the subject of a triple — drop reverse literals.
        if (object && object.termType !== "Literal") {
          this.emit(object as Quad_Subject, predicate, subject, graph);
        }
      }
    }
  }

  private valueToObject(
    value: JsonValue,
    def: TermDefinition | undefined,
    active: ActiveContext,
    graph: Quad_Graph,
  ): Quad_Object | null {
    if (value === null) return null;

    if (typeof value === "string") {
      if (def?.type === "@id") {
        return this.idToTerm(expandIri(active, value));
      }
      if (def?.type === "@vocab") {
        const id = expandIri(active, value, { vocab: true });
        return isAbsoluteIri(id) ? DataFactory.namedNode(id) : null;
      }
      return this.literalFor(value, def, active);
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return this.literalFor(value, def, active);
    }
    if (Array.isArray(value)) return null; // nested arrays are not valid here

    if ("@value" in value) return this.valueObjectToLiteral(value, active);
    if ("@list" in value) {
      return this.buildList(arrayify(value["@list"]), def, active, graph);
    }
    if ("@id" in value && Object.keys(value).length === 1) {
      return this.idToTerm(expandIri(active, String(value["@id"])));
    }
    return this.processNode(value, active, graph);
  }

  private literalFor(
    value: string | number | boolean,
    def: TermDefinition | undefined,
    active: ActiveContext,
  ): Literal {
    if (typeof value === "boolean") {
      const datatype = isIriType(def?.type) ? def.type : XSD_BOOLEAN;
      return DataFactory.literal(
        value ? "true" : "false",
        DataFactory.namedNode(datatype),
      );
    }
    if (typeof value === "number") {
      const datatype = isIriType(def?.type)
        ? def.type
        : isJsonLdDouble(value)
          ? XSD_DOUBLE
          : XSD_INTEGER;
      return DataFactory.literal(
        numberToLexical(value, datatype),
        DataFactory.namedNode(datatype),
      );
    }
    if (isIriType(def?.type)) {
      return DataFactory.literal(value, DataFactory.namedNode(def.type));
    }
    const language =
      def?.language !== undefined ? def.language : active.language;
    if (language) return DataFactory.literal(value, language);
    return DataFactory.literal(value);
  }

  private valueObjectToLiteral(
    valueObject: JsonObject,
    active: ActiveContext,
  ): Literal | null {
    const raw = valueObject["@value"];
    // JSON-LD 1.0: a value object whose @value is null (or absent) produces no
    // triple — drop it rather than emit a bogus "null" literal.
    if (raw === null || raw === undefined) return null;

    // Resolve the explicit datatype first so a numeric @value coerced to
    // xsd:double uses the canonical double lexical form.
    const explicitType =
      "@type" in valueObject && valueObject["@type"] != null
        ? expandIri(active, String(valueObject["@type"]), { vocab: true })
        : undefined;

    const lexical =
      typeof raw === "boolean"
        ? raw
          ? "true"
          : "false"
        : typeof raw === "number"
          ? numberToLexical(
              raw,
              explicitType ?? (isJsonLdDouble(raw) ? XSD_DOUBLE : XSD_INTEGER),
            )
          : String(raw);

    if (explicitType !== undefined) {
      return DataFactory.literal(lexical, DataFactory.namedNode(explicitType));
    }
    if ("@language" in valueObject && valueObject["@language"] != null) {
      return DataFactory.literal(
        lexical,
        String(valueObject["@language"]).toLowerCase(),
      );
    }
    if (typeof raw === "boolean") {
      return DataFactory.literal(lexical, DataFactory.namedNode(XSD_BOOLEAN));
    }
    if (typeof raw === "number") {
      return DataFactory.literal(
        lexical,
        DataFactory.namedNode(isJsonLdDouble(raw) ? XSD_DOUBLE : XSD_INTEGER),
      );
    }
    if (active.language) return DataFactory.literal(lexical, active.language);
    return DataFactory.literal(lexical);
  }

  private buildList(
    items: JsonValue[],
    def: TermDefinition | undefined,
    active: ActiveContext,
    graph: Quad_Graph,
  ): NamedNode | BlankNode {
    // Strip the list container so list members aren't re-wrapped as lists.
    const itemDef = def?.container ? { ...def, container: undefined } : def;
    const objects = items
      .map((item) => this.valueToObject(item, itemDef, active, graph))
      .filter((object): object is Quad_Object => object !== null);

    if (objects.length === 0) return DataFactory.namedNode(RDF_NIL);

    let rest: NamedNode | BlankNode = DataFactory.namedNode(RDF_NIL);
    for (let i = objects.length - 1; i >= 0; i--) {
      const node = this.fresh();
      this.emit(node, DataFactory.namedNode(RDF_FIRST), objects[i]!, graph);
      this.emit(node, DataFactory.namedNode(RDF_REST), rest, graph);
      rest = node;
    }
    return rest;
  }
}

/**
 * Whether a JSON number maps to `xsd:double` rather than `xsd:integer`. Matches
 * conformant processors: a number is a double when it has a fractional part or
 * its magnitude is `>= 1e21` (the point past which decimal integer notation is
 * no longer used); otherwise it is an integer.
 */
function isJsonLdDouble(value: number): boolean {
  return !Number.isInteger(value) || Math.abs(value) >= 1e21;
}

function numberToLexical(value: number, datatype: string): string {
  // xsd:double/float canonical forms for the non-finite values; reachable only
  // via pre-parsed object input since JSON itself has no NaN/Infinity.
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "INF";
  if (value === -Infinity) return "-INF";
  // Canonical xsd:double lexical form — a mantissa with a decimal point and no
  // trailing zeros, an uppercase "E", and a signed exponent (100 → "1.0E2",
  // 1e-7 → "1.0E-7"). Used when the datatype is xsd:double, the value has a
  // fractional part, or (when not explicitly typed xsd:integer) its magnitude is
  // >= 1e21. An explicit xsd:integer is kept in integer form so it never lands
  // outside that datatype's lexical space.
  if (
    datatype === XSD_DOUBLE ||
    !Number.isInteger(value) ||
    (datatype !== XSD_INTEGER && Math.abs(value) >= 1e21)
  ) {
    return value.toExponential(15).replace(/(\d)0*e\+?/, "$1E");
  }
  // Canonical xsd:integer form. `toFixed(0)` renders magnitudes >= 1e21 in
  // exponential notation (invalid for xsd:integer), so fall back to BigInt for
  // those — only reachable when a value is explicitly typed xsd:integer.
  return Math.abs(value) < 1e21 ? value.toFixed(0) : BigInt(value).toString();
}

/** Options for {@link parseJsonLd}. */
export interface ParseJsonLdOptions {
  /** Base IRI used to resolve relative `@id` / `@base` references. */
  readonly base?: string;
}

/**
 * Parse a JSON-LD document (string or already-parsed value) into quads.
 *
 * Supports the subset documented in the package README: inline contexts only —
 * no remote (URL) contexts.
 */
export async function parseJsonLd(
  input: string | JsonValue,
  options?: ParseJsonLdOptions,
): Promise<Quad[]> {
  let document: JsonValue;
  try {
    document =
      typeof input === "string" ? (JSON.parse(input) as JsonValue) : input;
  } catch (error) {
    throw new JsonLdError(
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const active: ActiveContext = { terms: new Map(), base: options?.base };
  const emitter = new RdfEmitter();
  emitter.toRdf(document, active);
  return emitter.quads;
}

// --- Serialization from RDF -----------------------------------------------

function termId(term: { termType: string; value: string }): string {
  return term.termType === "BlankNode" ? `_:${term.value}` : term.value;
}

function literalToValueObject(literal: Literal): JsonObject {
  const datatype = literal.datatype.value;
  if (datatype === RDF_LANGSTRING) {
    return { "@value": literal.value, "@language": literal.language };
  }
  if (datatype === XSD_STRING) {
    return { "@value": literal.value };
  }
  return { "@value": literal.value, "@type": datatype };
}

function objectToValue(object: Quad_Object): JsonValue {
  switch (object.termType) {
    case "NamedNode":
      return { "@id": object.value };
    case "BlankNode":
      return { "@id": `_:${object.value}` };
    case "Literal":
      return literalToValueObject(object);
    default:
      return { "@id": object.value };
  }
}

function pushValue(node: JsonObject, key: string, value: JsonValue): void {
  const existing = node[key];
  if (Array.isArray(existing)) existing.push(value);
  else node[key] = [value];
}

/** Where a blank node is referenced as an object value within a graph. */
interface ListUsage {
  node: JsonObject;
  property: string;
  value: JsonObject;
}

function isBlankId(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.startsWith("_:");
}

/**
 * A node that is a well-formed list cell: exactly one `rdf:first` and one
 * `rdf:rest`, and at most a `@type` of `rdf:List`.
 */
function isListNode(node: JsonObject): boolean {
  const first = node[RDF_FIRST];
  const rest = node[RDF_REST];
  if (!Array.isArray(first) || first.length !== 1) return false;
  if (!Array.isArray(rest) || rest.length !== 1) return false;
  for (const key of Object.keys(node)) {
    if (key === "@id" || key === RDF_FIRST || key === RDF_REST) continue;
    if (key === "@type") {
      const type = node["@type"];
      if (Array.isArray(type) && type.length === 1 && type[0] === RDF_LIST) {
        continue;
      }
    }
    return false;
  }
  return true;
}

/**
 * Collapse well-formed `rdf:first`/`rdf:rest`/`rdf:nil` chains in a graph back
 * into JSON-LD `@list` value objects (the fromRDF list-conversion step), so
 * lists round-trip through their `@list` abstraction rather than as a raw cell
 * chain. An empty list is `rdf:nil`, which — per the JSON-LD data model — is
 * indistinguishable from a property whose value is literally `rdf:nil`, so it is
 * left as a node reference.
 */
function convertLists(nodes: Map<string, JsonObject>): void {
  // Record, for every blank-node object reference, the single place it is used
  // (`false` once referenced more than once), plus every use of `rdf:nil`.
  const referencedOnce = new Map<string, ListUsage | false>();
  const nilUsages: ListUsage[] = [];

  for (const node of nodes.values()) {
    for (const [property, values] of Object.entries(node)) {
      if (property === "@id" || !Array.isArray(values)) continue;
      for (const value of values) {
        if (!isObject(value)) continue;
        const ref = value["@id"];
        if (ref === RDF_NIL) {
          nilUsages.push({ node, property, value });
        } else if (isBlankId(ref)) {
          referencedOnce.set(
            ref,
            referencedOnce.has(ref) ? false : { node, property, value },
          );
        }
      }
    }
  }

  // Walk each `rdf:nil` terminator back up the `rdf:rest` chain, gathering a
  // list whose cells are each referenced exactly once.
  for (const nilUsage of nilUsages) {
    let { node, property, value: head } = nilUsage;
    const list: JsonValue[] = [];
    const listNodes: string[] = [];

    while (property === RDF_REST) {
      const id = node["@id"];
      if (!isBlankId(id)) break;
      const usage = referencedOnce.get(id);
      if (!usage || !isListNode(node)) break;
      list.push((node[RDF_FIRST] as JsonValue[])[0] as JsonValue);
      listNodes.push(id);
      ({ node, property, value: head } = usage);
    }

    if (listNodes.length === 0) continue;
    // `head` is the reference that points at the list head; rewrite it in place.
    delete head["@id"];
    list.reverse();
    head["@list"] = list;
    for (const id of listNodes) nodes.delete(id);
  }
}

/**
 * Serialize quads into JSON-LD in **expanded / flattened** form (node objects,
 * no `@context`). Lists are re-emitted as `@list`. This form round-trips
 * through {@link parseJsonLd} at the RDF (quad) level; note an empty list and a
 * literal `rdf:nil` reference share one representation (see {@link convertLists}).
 */
function quadsToJsonLd(quads: Quad[]): JsonValue[] {
  interface GraphBucket {
    nodes: Map<string, JsonObject>;
  }
  const graphs = new Map<string, GraphBucket>();
  const order: string[] = [];

  for (const quad of quads) {
    const graphKey =
      quad.graph.termType === "DefaultGraph" ? "" : termId(quad.graph);
    let bucket = graphs.get(graphKey);
    if (!bucket) {
      bucket = { nodes: new Map() };
      graphs.set(graphKey, bucket);
      order.push(graphKey);
    }

    const subjectKey = termId(quad.subject);
    let node = bucket.nodes.get(subjectKey);
    if (!node) {
      node = { "@id": subjectKey };
      bucket.nodes.set(subjectKey, node);
    }

    if (
      quad.predicate.value === RDF_TYPE &&
      quad.object.termType === "NamedNode"
    ) {
      pushValue(node, "@type", quad.object.value);
    } else {
      pushValue(node, quad.predicate.value, objectToValue(quad.object));
    }
  }

  for (const bucket of graphs.values()) convertLists(bucket.nodes);

  const output: JsonValue[] = [];
  const defaultBucket = graphs.get("");
  if (defaultBucket) {
    for (const node of defaultBucket.nodes.values()) output.push(node);
  }
  for (const graphKey of order) {
    if (graphKey === "") continue;
    const bucket = graphs.get(graphKey)!;
    output.push({
      "@id": graphKey,
      "@graph": [...bucket.nodes.values()],
    });
  }
  return output;
}

/** Options for {@link writeJsonLd}. */
export interface WriteJsonLdOptions {
  /** `JSON.stringify` indentation width (default `2`). */
  readonly space?: number;
}

/**
 * Serialize quads into a JSON-LD document string (expanded / flattened form).
 */
export async function writeJsonLd(
  quads: Quad[],
  options?: WriteJsonLdOptions,
): Promise<string> {
  return JSON.stringify(quadsToJsonLd(quads), null, options?.space ?? 2);
}
