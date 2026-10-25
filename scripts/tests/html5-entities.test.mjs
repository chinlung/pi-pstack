import assert from "node:assert/strict";
import { test } from "node:test";
import { HTML5_ENTITIES } from "../html5-entities.mjs";

test("checked-in HTML5 table includes terminated and legacy names", () => {
	assert.equal(Object.keys(HTML5_ENTITIES).length, 2231);
	assert.equal(HTML5_ENTITIES["NotEqualTilde;"], "≂̸");
	assert.equal(HTML5_ENTITIES["amp;"], "&");
	assert.equal(HTML5_ENTITIES.amp, "&");
});
