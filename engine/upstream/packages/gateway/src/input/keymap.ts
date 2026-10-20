/**
 * US keyboard layout table.
 *
 * Adapted from Puppeteer's `USKeyboardLayout.ts` at puppeteer-core 24.43.1.
 * Copyright 2017 Google Inc. SPDX-License-Identifier: Apache-2.0.
 *
 * The wire already carries the browser-observed `key`, so the vendored physical-code table is
 * used for the Windows virtual key code, location, and US-layout fallback. Keeping the observed
 * key preserves CapsLock and other state that is deliberately absent from the wire modifier mask.
 */
import { Mod } from "@mirror/protocol";

export interface KeyDescription {
  keyCode: number;
  key: string;
  code: string;
  text: string;
  location: number;
}

interface KeyDefinition {
  keyCode?: number;
  shiftKeyCode?: number;
  key: string;
  shiftKey?: string;
  text?: string;
  shiftText?: string;
  location?: number;
}

const LETTERS = Object.fromEntries(
  [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((letter) => [
    `Key${letter}`,
    { keyCode: letter.charCodeAt(0), key: letter.toLowerCase(), shiftKey: letter },
  ]),
) as Record<string, KeyDefinition>;

const FUNCTION_KEYS = Object.fromEntries(
  Array.from({ length: 24 }, (_, index) => {
    const number = index + 1;
    return [`F${number}`, { keyCode: 111 + number, key: `F${number}` }];
  }),
) as Record<string, KeyDefinition>;

/** Physical KeyboardEvent.code -> the vendored US layout definition. */
const US_KEYBOARD_LAYOUT: Readonly<Record<string, KeyDefinition>> = {
  Power: { key: "Power" },
  Eject: { key: "Eject" },
  Abort: { keyCode: 3, key: "Cancel" },
  Help: { keyCode: 6, key: "Help" },
  Backspace: { keyCode: 8, key: "Backspace" },
  Tab: { keyCode: 9, key: "Tab" },
  Numpad5: { keyCode: 12, shiftKeyCode: 101, key: "Clear", shiftKey: "5", location: 3 },
  NumpadEnter: { keyCode: 13, key: "Enter", text: "\r", location: 3 },
  Enter: { keyCode: 13, key: "Enter", text: "\r" },
  ShiftLeft: { keyCode: 16, key: "Shift", location: 1 },
  ShiftRight: { keyCode: 16, key: "Shift", location: 2 },
  ControlLeft: { keyCode: 17, key: "Control", location: 1 },
  ControlRight: { keyCode: 17, key: "Control", location: 2 },
  AltLeft: { keyCode: 18, key: "Alt", location: 1 },
  AltRight: { keyCode: 18, key: "Alt", location: 2 },
  Pause: { keyCode: 19, key: "Pause" },
  CapsLock: { keyCode: 20, key: "CapsLock" },
  Escape: { keyCode: 27, key: "Escape" },
  Convert: { keyCode: 28, key: "Convert" },
  NonConvert: { keyCode: 29, key: "NonConvert" },
  Space: { keyCode: 32, key: " " },
  Numpad9: { keyCode: 33, shiftKeyCode: 105, key: "PageUp", shiftKey: "9", location: 3 },
  PageUp: { keyCode: 33, key: "PageUp" },
  Numpad3: { keyCode: 34, shiftKeyCode: 99, key: "PageDown", shiftKey: "3", location: 3 },
  PageDown: { keyCode: 34, key: "PageDown" },
  End: { keyCode: 35, key: "End" },
  Numpad1: { keyCode: 35, shiftKeyCode: 97, key: "End", shiftKey: "1", location: 3 },
  Home: { keyCode: 36, key: "Home" },
  Numpad7: { keyCode: 36, shiftKeyCode: 103, key: "Home", shiftKey: "7", location: 3 },
  ArrowLeft: { keyCode: 37, key: "ArrowLeft" },
  Numpad4: { keyCode: 37, shiftKeyCode: 100, key: "ArrowLeft", shiftKey: "4", location: 3 },
  Numpad8: { keyCode: 38, shiftKeyCode: 104, key: "ArrowUp", shiftKey: "8", location: 3 },
  ArrowUp: { keyCode: 38, key: "ArrowUp" },
  ArrowRight: { keyCode: 39, key: "ArrowRight" },
  Numpad6: { keyCode: 39, shiftKeyCode: 102, key: "ArrowRight", shiftKey: "6", location: 3 },
  Numpad2: { keyCode: 40, shiftKeyCode: 98, key: "ArrowDown", shiftKey: "2", location: 3 },
  ArrowDown: { keyCode: 40, key: "ArrowDown" },
  Select: { keyCode: 41, key: "Select" },
  Open: { keyCode: 43, key: "Execute" },
  PrintScreen: { keyCode: 44, key: "PrintScreen" },
  Insert: { keyCode: 45, key: "Insert" },
  Numpad0: { keyCode: 45, shiftKeyCode: 96, key: "Insert", shiftKey: "0", location: 3 },
  Delete: { keyCode: 46, key: "Delete" },
  NumpadDecimal: { keyCode: 46, shiftKeyCode: 110, key: "\u0000", shiftKey: ".", location: 3 },
  Digit0: { keyCode: 48, key: "0", shiftKey: ")" },
  Digit1: { keyCode: 49, key: "1", shiftKey: "!" },
  Digit2: { keyCode: 50, key: "2", shiftKey: "@" },
  Digit3: { keyCode: 51, key: "3", shiftKey: "#" },
  Digit4: { keyCode: 52, key: "4", shiftKey: "$" },
  Digit5: { keyCode: 53, key: "5", shiftKey: "%" },
  Digit6: { keyCode: 54, key: "6", shiftKey: "^" },
  Digit7: { keyCode: 55, key: "7", shiftKey: "&" },
  Digit8: { keyCode: 56, key: "8", shiftKey: "*" },
  Digit9: { keyCode: 57, key: "9", shiftKey: "(" },
  ...LETTERS,
  MetaLeft: { keyCode: 91, key: "Meta", location: 1 },
  MetaRight: { keyCode: 92, key: "Meta", location: 2 },
  ContextMenu: { keyCode: 93, key: "ContextMenu" },
  NumpadMultiply: { keyCode: 106, key: "*", location: 3 },
  NumpadAdd: { keyCode: 107, key: "+", location: 3 },
  NumpadSubtract: { keyCode: 109, key: "-", location: 3 },
  NumpadDivide: { keyCode: 111, key: "/", location: 3 },
  ...FUNCTION_KEYS,
  NumLock: { keyCode: 144, key: "NumLock" },
  ScrollLock: { keyCode: 145, key: "ScrollLock" },
  AudioVolumeMute: { keyCode: 173, key: "AudioVolumeMute" },
  AudioVolumeDown: { keyCode: 174, key: "AudioVolumeDown" },
  AudioVolumeUp: { keyCode: 175, key: "AudioVolumeUp" },
  MediaTrackNext: { keyCode: 176, key: "MediaTrackNext" },
  MediaTrackPrevious: { keyCode: 177, key: "MediaTrackPrevious" },
  MediaStop: { keyCode: 178, key: "MediaStop" },
  MediaPlayPause: { keyCode: 179, key: "MediaPlayPause" },
  Semicolon: { keyCode: 186, key: ";", shiftKey: ":" },
  Equal: { keyCode: 187, key: "=", shiftKey: "+" },
  NumpadEqual: { keyCode: 187, key: "=", location: 3 },
  Comma: { keyCode: 188, key: ",", shiftKey: "<" },
  Minus: { keyCode: 189, key: "-", shiftKey: "_" },
  Period: { keyCode: 190, key: ".", shiftKey: ">" },
  Slash: { keyCode: 191, key: "/", shiftKey: "?" },
  Backquote: { keyCode: 192, key: "`", shiftKey: "~" },
  BracketLeft: { keyCode: 219, key: "[", shiftKey: "{" },
  Backslash: { keyCode: 220, key: "\\", shiftKey: "|" },
  BracketRight: { keyCode: 221, key: "]", shiftKey: "}" },
  Quote: { keyCode: 222, key: "'", shiftKey: '"' },
  AltGraph: { keyCode: 225, key: "AltGraph" },
  Props: { keyCode: 247, key: "CrSel" },
  SoftLeft: { key: "SoftLeft", location: 4 },
  SoftRight: { key: "SoftRight", location: 4 },
  Camera: { keyCode: 44, key: "Camera", location: 4 },
  Call: { key: "Call", location: 4 },
  EndCall: { keyCode: 95, key: "EndCall", location: 4 },
  VolumeDown: { keyCode: 182, key: "VolumeDown", location: 4 },
  VolumeUp: { keyCode: 183, key: "VolumeUp", location: 4 },
};

export function describeKey(code: string, observedKey: string, mods: number): KeyDescription {
  const definition = US_KEYBOARD_LAYOUT[code];
  const shifted = (mods & Mod.Shift) !== 0;
  const fallbackKey = shifted && definition?.shiftKey ? definition.shiftKey : definition?.key;
  const key = observedKey || fallbackKey || "Unidentified";
  const keyCode =
    (shifted ? definition?.shiftKeyCode : undefined) ??
    definition?.keyCode ??
    inferredKeyCode(code);

  let text = key.length === 1 ? key : "";
  if (definition?.text !== undefined) text = definition.text;
  if (shifted && definition?.shiftText !== undefined) text = definition.shiftText;
  if ((mods & ~Mod.Shift) !== 0) text = "";

  return {
    keyCode,
    key,
    code,
    text,
    location: definition?.location ?? 0,
  };
}

function inferredKeyCode(code: string): number {
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  if (letter !== undefined) return letter.charCodeAt(0);
  const digit = /^Digit([0-9])$/.exec(code)?.[1];
  if (digit !== undefined) return digit.charCodeAt(0);
  return 0;
}
