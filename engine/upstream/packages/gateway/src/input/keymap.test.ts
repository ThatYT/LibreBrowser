import { Mod } from "@mirror/protocol";
import { describe, expect, it } from "vitest";
import { describeKey } from "./keymap";

describe("US keyboard layout", () => {
  it("maps printable, shifted, navigation, and keypad physical codes", () => {
    expect(describeKey("KeyA", "a", 0)).toMatchObject({
      keyCode: 65,
      key: "a",
      text: "a",
      location: 0,
    });
    expect(describeKey("Digit1", "!", Mod.Shift)).toMatchObject({
      keyCode: 49,
      key: "!",
      text: "!",
    });
    expect(describeKey("ArrowLeft", "ArrowLeft", 0)).toMatchObject({
      keyCode: 37,
      text: "",
    });
    expect(describeKey("NumpadEnter", "Enter", 0)).toMatchObject({
      keyCode: 13,
      text: "\r",
      location: 3,
    });
  });

  it("suppresses text when non-shift modifiers are active", () => {
    expect(describeKey("KeyA", "a", Mod.Ctrl).text).toBe("");
    expect(describeKey("KeyA", "A", Mod.Meta | Mod.Shift).text).toBe("");
  });

  it("preserves the observed key while falling back safely for an unknown code", () => {
    expect(describeKey("IntlRo", "ろ", 0)).toEqual({
      keyCode: 0,
      key: "ろ",
      code: "IntlRo",
      text: "ろ",
      location: 0,
    });
  });
});
