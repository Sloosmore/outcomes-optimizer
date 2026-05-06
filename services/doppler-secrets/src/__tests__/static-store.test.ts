import { describe, it, expect } from "vitest";
import { createStaticStore, SecretNotFoundError } from "../index.js";

describe("createStaticStore", () => {
  it("get(existing key) returns value", () => {
    const store = createStaticStore({ KEY: "val" });
    expect(store.get("KEY")).toBe("val");
  });

  it("get(missing key) throws SecretNotFoundError", () => {
    const store = createStaticStore({});
    expect(() => store.get("KEY")).toThrow(SecretNotFoundError);
    expect(() => store.get("KEY")).toThrow('Secret "KEY" not found in Doppler config');
  });

  it("getOptional(missing key) returns undefined", () => {
    const store = createStaticStore({});
    expect(store.getOptional("KEY")).toBeUndefined();
  });

  it("getOptional(existing key) returns value", () => {
    const store = createStaticStore({ FOO: "bar" });
    expect(store.getOptional("FOO")).toBe("bar");
  });

  it("SecretNotFoundError has correct name", () => {
    const store = createStaticStore({});
    try {
      store.get("MISSING");
    } catch (e) {
      expect(e).toBeInstanceOf(SecretNotFoundError);
      expect((e as Error).name).toBe("SecretNotFoundError");
    }
  });

  it("handles multiple keys correctly", () => {
    const store = createStaticStore({ A: "1", B: "2", C: "3" });
    expect(store.get("A")).toBe("1");
    expect(store.get("B")).toBe("2");
    expect(store.get("C")).toBe("3");
  });
});
