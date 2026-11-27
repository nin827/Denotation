// Operator precedence: ^ binds tighter than unary minus and is right-associative.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evalExpression } from "../../source/app/js/formula.js";

const ev = (s, env) => evalExpression(s, env).value;

test("unary minus vs ^", () => {
  const cases = {
    "-2^2": -4, "(-2)^2": 4, "-(-2)^2": -4, "2^-2": 0.25, "2^+2": 4, "2^-+-2": 4,
    "2^3^2": 512, "(2^3)^2": 64, "-2^3^2": -512, "2*-3^2": -18, "1--2^2": 5, "-50%^2": -0.25,
    "--2": 2, "+-2": -2, "-+2": -2, "+2^2": 4, "-2*3": -6, "2^2*3": 12, "-SQRT(16)^2": -16, "-ABS(-3)^2": -9,
  };
  for (const [src, want] of Object.entries(cases)) assert.equal(ev(src), want, src);
});
