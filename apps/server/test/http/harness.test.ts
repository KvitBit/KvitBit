import { expect, test } from "bun:test";
import { json } from "./harness";

test("omits a request body when JSON serialization produces no value", () => {
  const body = {
    toJSON: (key: string) => {
      expect(key).toBe("");
    },
  };

  expect(json(body).body).toBeUndefined();
  expect(json(Symbol("absent")).body).toBeUndefined();
  expect(json(() => "absent").body).toBeUndefined();
});

test("still rejects a request body that JSON serialization cannot encode", () => {
  expect(() => json(1n)).toThrow(TypeError);
});
