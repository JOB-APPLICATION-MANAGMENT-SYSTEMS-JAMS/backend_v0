/**
 * Regression guard for the live `value.toFixed is not a function` 500:
 * node-postgres returns `int8` (count/sum) and `numeric` (avg) as strings, while
 * sqlite returns numbers. `castRows` must coerce those two OIDs to JS numbers and
 * leave text columns (even numeric-looking ones) untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { castRows } from "../src/core/db";

test("castRows coerces int8/numeric to numbers, leaves text alone", () => {
  const result = {
    fields: [
      { name: "applied", dataTypeID: 20 }, // count(*) → int8 → string "3"
      { name: "rate", dataTypeID: 1700 }, // avg/percent → numeric → string "66.7"
      { name: "email", dataTypeID: 25 }, // text that looks numeric — must stay a string
      { name: "id", dataTypeID: 2950 }, // uuid
    ],
    rows: [{ applied: "3", rate: "66.7", email: "12345", id: "01a0eebb-e224-49aa-9020-619c619b4c8" }],
  } as any;

  const [row] = castRows<any>(result);

  // the exact expression that threw in production:
  assert.equal(row.applied.toFixed(0), "3");
  assert.equal(row.rate.toFixed(1), "66.7");
  assert.equal(row.applied + 1, 4); // arithmetic, not string concat
  assert.equal(typeof row.email, "string");
  assert.equal(row.email, "12345");
});

test("castRows tolerates already-numeric values and nulls", () => {
  const result = {
    fields: [
      { name: "n", dataTypeID: 20 },
      { name: "m", dataTypeID: 1700 },
      { name: "z", dataTypeID: 20 },
    ],
    rows: [{ n: 42, m: 1.5, z: null }],
  } as any;

  const [row] = castRows<any>(result);
  assert.equal(row.n, 42);
  assert.equal(row.m, 1.5);
  assert.equal(row.z, null);
});
