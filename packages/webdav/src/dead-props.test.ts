import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { PropertyStore } from "./dead-props.js";
import type { WebdavTestObject } from "./test-harness.js";

interface HarnessEnv {
  readonly WEBDAV_DO: DurableObjectNamespace<WebdavTestObject>;
}
const harness = env as unknown as HarnessEnv;

/** Run `fn` against a fresh DO's real SQLite store. */
async function withSql<T>(fn: (sql: SqlStorage) => T | Promise<T>): Promise<T> {
  const id = harness.WEBDAV_DO.idFromName(crypto.randomUUID());
  const stub = harness.WEBDAV_DO.get(id);
  return runInDurableObject(stub, (instance) => fn(instance.sql));
}

const NS = "http://example.com/neon/litmus/";

describe("PropertyStore", () => {
  it("sets, lists, and removes a property", async () => {
    await withSql((sql) => {
      const props = new PropertyStore(sql);
      props.set("/a.txt", { ns: NS, local: "foo", valueXml: "value" });
      expect(props.list("/a.txt")).toEqual([
        { ns: NS, local: "foo", valueXml: "value" },
      ]);
      props.remove("/a.txt", NS, "foo");
      expect(props.list("/a.txt")).toEqual([]);
    });
  });

  it("replaces the value on a repeated set (litmus propreplace)", async () => {
    await withSql((sql) => {
      const props = new PropertyStore(sql);
      props.set("/a", { ns: NS, local: "p", valueXml: "old" });
      props.set("/a", { ns: NS, local: "p", valueXml: "new" });
      expect(props.list("/a")).toEqual([
        { ns: NS, local: "p", valueXml: "new" },
      ]);
    });
  });

  it("keys no-namespace properties distinctly (litmus propnullns)", async () => {
    await withSql((sql) => {
      const props = new PropertyStore(sql);
      props.set("/a", { ns: null, local: "p", valueXml: "bare" });
      props.set("/a", { ns: NS, local: "p", valueXml: "spaced" });
      const listed = props.list("/a");
      expect(listed).toHaveLength(2);
      expect(listed.find((p) => p.ns === null)?.valueXml).toBe("bare");
      props.remove("/a", null, "p");
      expect(props.list("/a")).toEqual([
        { ns: NS, local: "p", valueXml: "spaced" },
      ]);
    });
  });

  it("removing an absent property is a no-op", async () => {
    await withSql((sql) => {
      const props = new PropertyStore(sql);
      expect(() => props.remove("/a", NS, "ghost")).not.toThrow();
    });
  });

  it("keeps distinct namespaces with the same local name (propmanyns)", async () => {
    await withSql((sql) => {
      const props = new PropertyStore(sql);
      for (let n = 0; n < 10; n++) {
        props.set("/a", {
          ns: `http://example.com/ns${n}`,
          local: "somename",
          valueXml: `v${n}`,
        });
      }
      expect(props.list("/a")).toHaveLength(10);
    });
  });

  it("copies a single resource's properties (COPY / litmus propmove)", async () => {
    await withSql((sql) => {
      const props = new PropertyStore(sql);
      props.set("/prop", { ns: NS, local: "foo", valueXml: "v" });
      props.copyTree("/prop", "/prop2", true);
      expect(props.list("/prop2")).toEqual([
        { ns: NS, local: "foo", valueXml: "v" },
      ]);
      // The source keeps its rows; MOVE drops them with removeTree.
      expect(props.list("/prop")).toHaveLength(1);
    });
  });

  it("copies a collection subtree, rewriting the prefix", async () => {
    await withSql((sql) => {
      const props = new PropertyStore(sql);
      props.set("/dir/", { ns: NS, local: "onDir", valueXml: "d" });
      props.set("/dir/a.txt", { ns: NS, local: "onChild", valueXml: "c" });
      props.copyTree("/dir/", "/dest/", true);
      expect(props.list("/dest/")).toHaveLength(1);
      expect(props.list("/dest/a.txt")).toEqual([
        { ns: NS, local: "onChild", valueXml: "c" },
      ]);
    });
  });

  it("shallow-copies only the named collection when deep is false", async () => {
    await withSql((sql) => {
      const props = new PropertyStore(sql);
      props.set("/dir/", { ns: NS, local: "onDir", valueXml: "d" });
      props.set("/dir/a.txt", { ns: NS, local: "onChild", valueXml: "c" });
      props.copyTree("/dir/", "/dest/", false);
      expect(props.list("/dest/")).toHaveLength(1);
      expect(props.list("/dest/a.txt")).toEqual([]);
    });
  });

  it("overwrites stale destination rows on copy", async () => {
    await withSql((sql) => {
      const props = new PropertyStore(sql);
      props.set("/src", { ns: NS, local: "p", valueXml: "fresh" });
      props.set("/dest", { ns: NS, local: "p", valueXml: "stale" });
      props.copyTree("/src", "/dest", true);
      expect(props.list("/dest")).toEqual([
        { ns: NS, local: "p", valueXml: "fresh" },
      ]);
    });
  });

  it("removes a subtree without touching prefix-sharing siblings", async () => {
    await withSql((sql) => {
      const props = new PropertyStore(sql);
      props.set("/dir/", { ns: NS, local: "p", valueXml: "d" });
      props.set("/dir/a", { ns: NS, local: "p", valueXml: "a" });
      props.set("/dirty", { ns: NS, local: "p", valueXml: "sibling" });
      props.removeTree("/dir/");
      expect(props.list("/dir/")).toEqual([]);
      expect(props.list("/dir/a")).toEqual([]);
      expect(props.list("/dirty")).toHaveLength(1);
    });
  });

  it("treats % and _ in a subtree prefix as literals, not LIKE wildcards", async () => {
    await withSql((sql) => {
      const props = new PropertyStore(sql);
      const pd = { ns: NS, local: "p", valueXml: "v" };
      // Paths are percent-encoded (`ResourceStat.path`), so a stored path can
      // legitimately contain a literal `%` — e.g. a collection named `x%`
      // stores as `/x%25/`. Without `likeEscape`, the subtree pattern
      // `/x%25/%` would also swallow `/xa25/kid` (`%` as wildcard), and
      // `/a_b/%` would swallow `/acb/kid` (`_` as wildcard).
      props.set("/x%25/", pd);
      props.set("/x%25/kid", pd);
      props.set("/xa25/kid", pd);
      props.set("/a_b/", pd);
      props.set("/a_b/kid", pd);
      props.set("/acb/kid", pd);

      // copyTree's descendant scan uses the same escaping: the real child is
      // found, and only it lands under the destination.
      props.copyTree("/x%25/", "/dest/", true);
      expect(props.list("/dest/")).toHaveLength(1);
      expect(props.list("/dest/kid")).toHaveLength(1);

      props.removeTree("/x%25/");
      props.removeTree("/a_b/");
      expect(props.list("/x%25/")).toEqual([]);
      expect(props.list("/x%25/kid")).toEqual([]);
      expect(props.list("/a_b/kid")).toEqual([]);
      // The prefix-sharing siblings survive both removals.
      expect(props.list("/xa25/kid")).toHaveLength(1);
      expect(props.list("/acb/kid")).toHaveLength(1);
    });
  });

  it("removeTree of a plain resource path drops only that resource", async () => {
    await withSql((sql) => {
      const props = new PropertyStore(sql);
      props.set("/a", { ns: NS, local: "p", valueXml: "x" });
      props.set("/a2", { ns: NS, local: "p", valueXml: "y" });
      props.removeTree("/a");
      expect(props.list("/a")).toEqual([]);
      expect(props.list("/a2")).toHaveLength(1);
    });
  });
});
