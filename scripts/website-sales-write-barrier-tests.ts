import assert from "node:assert/strict";
import test from "node:test";
import { assertSalesWriteBarrier } from "../src/lib/website-sales-write-barrier";

test("an unresolved Sales write blocks every other area and retains actor/workspace boundaries", () => {
  const values = new Map<string, string>(), previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { sessionStorage: { getItem: (key: string) => values.get(key) ?? null } } });
  try {
    for (const [area, prefix] of [["workflow", "website-sales"], ["studio", "website-studio"], ["lifecycle", "website-sales-lifecycle"]] as const) {
      values.clear(); values.set(`novalure.${prefix}.pending.v1:actor:workspace`, "malformed recovery also stays closed");
      assert.doesNotThrow(() => assertSalesWriteBarrier(area, "workspace", "actor"));
      for (const other of ["workflow", "studio", "lifecycle"] as const) if (other !== area)
        assert.throws(() => assertSalesWriteBarrier(other, "workspace", "actor"), /RECONCILIATION_REQUIRED/);
      assert.doesNotThrow(() => assertSalesWriteBarrier("studio", "other-workspace", "actor"));
      assert.doesNotThrow(() => assertSalesWriteBarrier("studio", "workspace", "other-actor"));
    }
    values.clear(); assert.doesNotThrow(() => assertSalesWriteBarrier("workflow", "workspace", "actor"));
  } finally { if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); }
});
