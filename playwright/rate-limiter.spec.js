// @ts-check
// E2E test for the server-side rate limiter (see check_rate_limit in
// ggjh2027-multiplayer/src/server.ts), driving real jspaint pages so it's
// watchable in UI mode (`npm run pw:ui`).
//
// Run with: npx playwright test playwright/rate-limiter.spec.js
const { test, expect } = require("@playwright/test");
const path = require("path");
const { startLocalPartykitServer } = require("./helpers/local-partykit-server");

const JSPAINT_URL = process.env.JSPAINT_URL || "http://localhost:1999";
const PARTYKIT_TEST_PORT = 1998;
const PARTYKIT_TEST_HOST = process.env.PARTYKIT_HOST || `ws://127.0.0.1:${PARTYKIT_TEST_PORT}`;
const SPAWN_LOCAL_PARTYKIT_SERVER = !process.env.PARTYKIT_HOST;
const MULTIPLAYER_SERVER_DIR = path.join(__dirname, "..", "..", "ggjh2027-multiplayer");

/** @type {{ stop: () => void } | undefined} */
let localServer;

test.beforeAll(async () => {
	if (!SPAWN_LOCAL_PARTYKIT_SERVER) {
		console.log(`PARTYKIT_HOST set - connecting to ${PARTYKIT_TEST_HOST} directly.`);
		return;
	}
	localServer = await startLocalPartykitServer({ cwd: MULTIPLAYER_SERVER_DIR, port: PARTYKIT_TEST_PORT });
});

test.afterAll(async () => {
	localServer?.stop();
});

const freshRoomId = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * @param {import("@playwright/test").BrowserContext} context
 * @param {string} [roomId] - pass the same id to multiple contexts that need
 *   to share a room (e.g. sender/observer); omit for an isolated fresh room.
 */
async function pointAtTestServer(context, roomId = freshRoomId()) {
	await context.route("**/src/multiplayer-config.js", (route) =>
		route.fulfill({
			contentType: "application/javascript",
			body: `export const PARTYKIT_HOST = ${JSON.stringify(PARTYKIT_TEST_HOST)};\nexport const MULTIPLAYER_ROOM_ID = ${JSON.stringify(roomId)};`,
		})
	);
}

/** @param {import("@playwright/test").Page} page */
async function setUpRectangleTool(page) {
	await page.locator('.tool[title="Rectangle"]').click();
	await page.locator(".choose-shape-style .chooser-option").nth(2).click(); // fill-only style
}

/**
 * @param {import("@playwright/test").Page} page
 * @param {number} i
 */
async function drawOneRectangle(page, i) {
	const canvasBox = await page.evaluate(() => {
		const rect = document.querySelector("canvas.main-canvas").getBoundingClientRect();
		return { x: rect.x, y: rect.y };
	});
	const x = canvasBox.x + 20 + (i % 20) * 3;
	const y = canvasBox.y + 20 + (i % 20) * 3;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + 20, y + 20);
	await page.mouse.up();
}

test.describe("patch rate limiting", () => {
	test("drawing at a normal pace never shows a rate-limit warning", async ({ page, context }) => {
		test.setTimeout(30000);
		await pointAtTestServer(context);
		await page.goto(JSPAINT_URL, { waitUntil: "domcontentloaded" });
		await page.waitForFunction(() => "api_for_cypress_tests" in window);
		await page.waitForFunction(() => window.api_for_cypress_tests.is_multiplayer_connected === true, { timeout: 5000 });
		await setUpRectangleTool(page);

		for (let i = 0; i < 5; i++) {
			await drawOneRectangle(page, i);
			await page.waitForTimeout(300); // well under the bucket's 150ms refill
		}

		await expect(page.locator(".window:visible").filter({ hasText: "too fast" })).toHaveCount(0);
	});

	test("a quick burst within the bucket's capacity is never rejected", async ({ page, context }) => {
		test.setTimeout(30000);
		await pointAtTestServer(context);
		await page.goto(JSPAINT_URL, { waitUntil: "domcontentloaded" });
		await page.waitForFunction(() => "api_for_cypress_tests" in window);
		await page.waitForFunction(() => window.api_for_cypress_tests.is_multiplayer_connected === true, { timeout: 5000 });
		await setUpRectangleTool(page);

		for (let i = 0; i < 10; i++) {
			await drawOneRectangle(page, i); // bucket holds 12 tokens
		}

		await expect(page.locator(".window:visible").filter({ hasText: "too fast" })).toHaveCount(0);
	});

	test("a sustained flood gets a warning, then a disconnect", async ({ page, context }) => {
		test.setTimeout(45000);
		await pointAtTestServer(context);
		await page.goto(JSPAINT_URL, { waitUntil: "domcontentloaded" });
		await page.waitForFunction(() => "api_for_cypress_tests" in window);
		await page.waitForFunction(() => window.api_for_cypress_tests.is_multiplayer_connected === true, { timeout: 5000 });
		await setUpRectangleTool(page);

		// Outruns the 150ms refill / 12-token capacity, and crosses the
		// 30-violation disconnect threshold.
		for (let i = 0; i < 60; i++) {
			await drawOneRectangle(page, i);
		}

		await expect(
			page.locator(".window:visible").filter({ hasText: "You're making changes too fast" }).first()
		).toBeVisible({ timeout: 10000 });

		await expect(
			page.locator(".window:visible").filter({ hasText: "Disconnected for sending changes too fast for too long" })
		).toBeVisible({ timeout: 10000 });

		await expect
			.poll(() => page.evaluate(() => window.api_for_cypress_tests.is_multiplayer_connected), { timeout: 5000 })
			.toBe(false);
	});
});

test.describe("cursor rate limiting", () => {
	/**
	 * Counts style changes on the remote cursor <img> via MutationObserver
	 * inside the page (not polling from the test side, which would be paced
	 * by IPC round-trips rather than the page's actual update rate).
	 * @param {import("@playwright/test").Page} page
	 */
	async function countRemoteCursorMoves(page) {
		return page.evaluate(() => {
			return new Promise((resolve) => {
				const start = () => {
					const img = document.querySelector("img[style*='position: fixed']");
					if (!img) {
						setTimeout(start, 50);
						return;
					}
					let moves = 0;
					const observer = new MutationObserver(() => { moves++; });
					observer.observe(img, { attributes: true, attributeFilter: ["style"] });
					window.__stopCountingRemoteCursorMoves = () => {
						observer.disconnect();
						resolve(moves);
					};
				};
				start();
			});
		});
	}

	test("normal cursor movement is reflected on the other page", async ({ browser }) => {
		test.setTimeout(30000);
		const senderContext = await browser.newContext();
		const observerContext = await browser.newContext();
		const roomId = freshRoomId();
		await Promise.all([pointAtTestServer(senderContext, roomId), pointAtTestServer(observerContext, roomId)]);
		const sender = await senderContext.newPage();
		const observer = await observerContext.newPage();

		await sender.goto(JSPAINT_URL, { waitUntil: "domcontentloaded" });
		await sender.waitForFunction(() => "api_for_cypress_tests" in window);
		await sender.waitForFunction(() => window.api_for_cypress_tests.is_multiplayer_connected === true, { timeout: 5000 });
		await observer.goto(JSPAINT_URL, { waitUntil: "domcontentloaded" });
		await observer.waitForFunction(() => "api_for_cypress_tests" in window);
		await observer.waitForFunction(() => window.api_for_cypress_tests.is_multiplayer_connected === true, { timeout: 5000 });

		const canvasBox = await sender.evaluate(() => {
			const rect = document.querySelector("canvas.main-canvas").getBoundingClientRect();
			return { x: rect.x, y: rect.y };
		});

		const movesPromise = countRemoteCursorMoves(observer);
		// Slower than the client's 50ms throttle and the server's 40ms
		// refill, so every move should land.
		for (let i = 0; i < 10; i++) {
			await sender.mouse.move(canvasBox.x + 100 + i * 5, canvasBox.y + 100 + i * 5);
			await sender.waitForTimeout(60);
		}
		await observer.waitForTimeout(300);
		const moves = await observer.evaluate(() => window.__stopCountingRemoteCursorMoves());
		expect(await movesPromise).toBe(moves);
		expect(moves).toBeGreaterThanOrEqual(8); // allow a little slack

		await senderContext.close();
		await observerContext.close();
	});

	// No cursor-flood test here: the real client self-throttles to one send
	// per 50ms (see BROADCAST_INTERVAL_MS in multiplayer-cursors.js), already
	// slower than the server's 40ms limit, so driving the real UI can never
	// exceed it. That needs raw protocol messages instead - see the
	// ggjh2027-multiplayer repo's own API-level tests for that.
});
