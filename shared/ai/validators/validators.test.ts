// Run: node --test shared/ai/validators/validators.test.ts   (Node >= 22.18 strips types natively)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateBillScan } from "./bill_scan.ts";
import { validateVoiceIntent } from "./voice_intent.ts";

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")).cases;

for (const c of load("bill_cases.json")) {
  test(`bill: ${c.name}`, () => {
    const r = validateBillScan(c.input);
    assert.equal(r.valid, c.expect.valid, JSON.stringify(r));
    if (r.valid) {
      assert.equal(r.accepted, c.expect.accepted, JSON.stringify(r.flags));
      assert.deepEqual(r.flags.map((f) => f.field).sort(), [...c.expect.flag_fields].sort());
    } else {
      assert.equal(r.fallback, "manual_entry");
    }
  });
}

for (const c of load("voice_cases.json")) {
  test(`voice: ${c.name}`, () => {
    const r = validateVoiceIntent(c.input);
    assert.equal(r.valid, c.expect.valid, JSON.stringify(r));
    if (r.valid) {
      assert.equal(r.can_write, c.expect.can_write);
      assert.equal(r.intent.needs_clarification, c.expect.needs_clarification);
    }
  });
}
