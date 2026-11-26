import test from "node:test";
import assert from "node:assert/strict";
import { isSessionVersionCurrent } from "../auth-session.js";

test("accepts a token issued for the current session version", () => {
  assert.equal(isSessionVersionCurrent(0, 0), true);
  assert.equal(isSessionVersionCurrent(3, 3), true);
});

test("revokes tokens issued before a password-reset version increment", () => {
  assert.equal(isSessionVersionCurrent(0, 1), false);
  assert.equal(isSessionVersionCurrent(2, 3), false);
});

test("keeps legacy tokens valid only while the account remains at version zero", () => {
  assert.equal(isSessionVersionCurrent(undefined, 0), true);
  assert.equal(isSessionVersionCurrent(undefined, 1), false);
});

test("rejects malformed or negative session versions", () => {
  assert.equal(isSessionVersionCurrent("not-a-number", 0), false);
  assert.equal(isSessionVersionCurrent(-1, 0), false);
  assert.equal(isSessionVersionCurrent(0, -1), false);
});
