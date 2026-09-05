import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReference, resolve, ReferenceSyntaxError, type Json } from "../src/reference.ts";

const data: Json = {
  taxpayer: { name: "Dana", "odd/key": 1, "tilde~key": 2 },
  w2: [{ wages: 100 }, { wages: 250.5 }, { wages: 0 }],
  businesses: [
    { id: "biz-1", active: true, gross: 5000 },
    { id: "biz-2", active: false, gross: 900 },
  ],
};

test("resolves an RFC 6901 pointer", () => {
  assert.deepEqual(resolve("/taxpayer/name", { root: data }), ["Dana"]);
  assert.deepEqual(resolve("$/w2/1/wages", { root: data }), [250.5]);
});

test("unescapes ~1 and ~0 in pointer tokens", () => {
  assert.deepEqual(resolve("/taxpayer/odd~1key", { root: data }), [1]);
  assert.deepEqual(resolve("/taxpayer/tilde~0key", { root: data }), [2]);
});

test("resolves dotted paths and wildcards", () => {
  assert.deepEqual(resolve("$.taxpayer.name", { root: data }), ["Dana"]);
  assert.deepEqual(resolve("$.w2[*].wages", { root: data }), [100, 250.5, 0]);
});

test("supports negative indexes and bracketed names", () => {
  assert.deepEqual(resolve("$.w2[-1].wages", { root: data }), [0]);
  assert.deepEqual(resolve("$['taxpayer']['name']", { root: data }), ["Dana"]);
});

test("filters on equality and inequality", () => {
  assert.deepEqual(resolve("$.businesses[?(@.id == 'biz-1')].gross", { root: data }), [5000]);
  assert.deepEqual(resolve("$.businesses[?(@.id != 'biz-1')].gross", { root: data }), [900]);
  assert.deepEqual(resolve("$.businesses[?(@.active == true)].gross", { root: data }), [5000]);
});

test("'@' resolves against the current binding, '$' against the root", () => {
  const current = (data as any).businesses[1];
  assert.deepEqual(resolve("@.gross", { root: data, current }), [900]);
  assert.deepEqual(resolve("$.taxpayer.name", { root: data, current }), ["Dana"]);
  assert.deepEqual(resolve("@", { root: data, current }), [current]);
});

test("a reference that selects nothing returns an empty list rather than throwing", () => {
  assert.deepEqual(resolve("$.missing.deeply.nested", { root: data }), []);
  assert.deepEqual(resolve("/w2/99/wages", { root: data }), []);
});

test("reports which references can select more than one node", () => {
  assert.equal(parseReference("$.w2[*].wages").multi, true);
  assert.equal(parseReference("$.businesses[?(@.id == 'x')]").multi, true);
  assert.equal(parseReference("$.taxpayer.name").multi, false);
});

test("rejects syntax outside the documented subset", () => {
  for (const bad of ["taxpayer.name", "$..wages", "$.w2[0:2]", "$.w2[?(@.wages > 5)]", "$.w2[", "$#"]) {
    assert.throws(() => parseReference(bad), ReferenceSyntaxError, `expected ${bad} to be rejected`);
  }
});

test("does not walk the prototype chain", () => {
  assert.deepEqual(resolve("$.constructor", { root: data }), []);
  assert.deepEqual(resolve("/__proto__", { root: data }), []);
});
