import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("password visibility toggle includes open-eye and crossed-out-eye states", () => {
  assert.match(html, /function passwordEyeIcon\(hidden\)/);
  assert.match(html, /<path d="M3 3l18 18"\/>/);
  assert.match(html, /function syncPasswordToggle\(/);
  assert.match(html, /aria-pressed/);
  assert.match(html, /function togglePassword\(/);
});

test("both password and confirmation fields have independent visibility controls", () => {
  assert.match(html, /togglePassword\('password',this\)/);
  assert.match(html, /togglePassword\('passwordConfirm',this\)/);
});
