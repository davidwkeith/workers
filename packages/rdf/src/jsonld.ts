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
  if (opts.vocab && term) return term.id ?? value;

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

  private nodeSubject(
    node: JsonObject,
    active: ActiveContext,
  ): NamedNode | BlankNode {
    if ("@id" in node && node["@id"] != null) {
      const id = expandIri(active, String(node["@id"]));
      return id.startsWith("_:")
        ? this.blankFor(id)
        : DataFactory.namedNode(id);
    }
    return this.fresh();
  }

  private processNode(
    node: JsonObject,
    context: ActiveContext,
    graph: Quad_Graph,
  ): NamedNode | BlankNode {
    const active =
      "@context" in node ? processContext(context, node["@context"]) : context;
    const subject = this.nodeSubject(node, active);

    for (const type of arrayify(node["@type"])) {
      const iri = expandIri(active, String(type), { vocab: true });
      if (iri && !isKeyword(iri)) {
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
      if (!predicateIri || isKeyword(predicateIri)) continue;
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
          this.emit(object as Quad_Subject, predicate, subject, graph);
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
      if (!predicateIri || isKeyword(predicateIri)) continue;
      const predicate = DataFactory.namedNode(predicateIri);
      const def = active.terms.get(key);
      for (const item of arrayify(value)) {
        const object = this.valueToObject(item, def, active, graph);
        if (object)
          this.emit(object as Quad_Subject, predicate, subject, graph);
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
        const id = expandIri(active, value);
        return id.startsWith("_:")
          ? this.blankFor(id)
          : DataFactory.namedNode(id);
      }
      if (def?.type === "@vocab") {
        return DataFactory.namedNode(expandIri(active, value, { vocab: true }));
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
      const id = expandIri(active, String(value["@id"]));
      return id.startsWith("_:")
        ? this.blankFor(id)
        : DataFactory.namedNode(id);
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
        : Number.isInteger(value)
          ? XSD_INTEGER
          : XSD_DOUBLE;
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
  ): Literal {
    const raw = valueObject["@value"];
    const lexical =
      typeof raw === "boolean"
        ? raw
          ? "true"
          : "false"
        : typeof raw === "number"
          ? numberToLexical(
              raw,
              Number.isInteger(raw) ? XSD_INTEGER : XSD_DOUBLE,
            )
          : String(raw);

    if ("@type" in valueObject && valueObject["@type"] != null) {
      const datatype = expandIri(active, String(valueObject["@type"]), {
        vocab: true,
      });
      return DataFactory.literal(lexical, DataFactory.namedNode(datatype));
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
        DataFactory.namedNode(Number.isInteger(raw) ? XSD_INTEGER : XSD_DOUBLE),
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

function numberToLexical(value: number, datatype: string): string {
  if (datatype === XSD_INTEGER) return String(Math.trunc(value));
  return String(value);
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

/**
 * Serialize quads into JSON-LD in **expanded / flattened** form (node objects,
 * no `@context`). This form round-trips losslessly through {@link parseJsonLd}.
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
