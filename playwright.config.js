// @ts-check
const path = require("path");

/** @type {import("@playwright/test").PlaywrightTestConfig} */
module.exports = {
	testDir: "./playwright",
	// Outside the project dir: jspaint's dev server live-reloads on any file
	// change here, which would kill the WebSocket connections mid-test.
	outputDir: path.join(require("os").tmpdir(), "jspaint-playwright-results"),
};
