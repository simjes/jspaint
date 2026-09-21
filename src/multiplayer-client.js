// @ts-check
/* global main_ctx */
import { initMultiplayerBridge, noteExternalCanvasChange } from "./multiplayer-bridge.js";
import { is_multiplayer_mode, set_is_admin_connection } from "./helpers.js";
import { show_error_message, update_helper_layer } from "./functions.js";
import { updateOnlineCount } from "./multiplayer-user-count.js";
import { hideRemoteCursor, showRemoteCursor, startBroadcastingCursor } from "./multiplayer-cursors.js";
// Generated from the PARTYKIT_HOST env var at dev/install time - see
// scripts/generate-multiplayer-config.js. Not checked in (per .gitignore);
// run `npm install` or `npm run dev` at the repo root if this import 404s.
import { PARTYKIT_HOST, MULTIPLAYER_ROOM_ID } from "./multiplayer-config.js";

// Every visitor connects to this one room - see MULTIPLAYER_ROOM_ID in
// generate-multiplayer-config.js.
const ROOM_ID = MULTIPLAYER_ROOM_ID;

// Test-only (see window.api_for_cypress_tests in app.js): true once the
// handshake completes - unlike is_admin_connection, which starts false for
// both "not connected" and "connected but not admin".
export let is_connected = false;

/**
 * @param {Blob} blob
 * @returns {Promise<string>} base64, no "data:...;base64," prefix
 */
async function blob_to_base64(blob) {
	const buffer = await blob.arrayBuffer();
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

/**
 * @param {string} base64
 * @param {string} mimeType
 * @returns {Promise<ImageBitmap>}
 */
async function base64_to_image_bitmap(base64, mimeType) {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return createImageBitmap(new Blob([bytes], { type: mimeType }));
}

/**
 * Draws a patch directly, bypassing undoable()/history - a remote patch
 * shouldn't become a history node, and drawing it as one would re-trigger
 * multiplayer-bridge.js and echo it back out.
 * @param {{rect: {x: number, y: number, w: number, h: number}, image: {mimeType: string, data: string}}} patch
 */
async function apply_patch_to_canvas(patch) {
	const bitmap = await base64_to_image_bitmap(patch.image.data, patch.image.mimeType);
	main_ctx.drawImage(bitmap, patch.rect.x, patch.rect.y);
	bitmap.close();
}

function initMultiplayerClient() {
	if (!is_multiplayer_mode) { return; }

	// Admins set this manually via the console - localStorage.multiplayer_admin_secret
	// = "..." - never passed through the URL. See server.ts in the separate
	// ggjh2027-multiplayer repo for the actual check.
	const admin_token = localStorage.multiplayer_admin_secret;

	const url = new URL(`${PARTYKIT_HOST}/parties/main/${ROOM_ID}`);
	if (admin_token) {
		url.searchParams.set("admin", admin_token);
	}
	const ws = new WebSocket(url);
	/** @type {string[]} */
	const send_queue = [];

	/** @param {object} message */
	const send = (message) => {
		const json = JSON.stringify(message);
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(json);
		} else {
			send_queue.push(json);
		}
	};

	ws.addEventListener("open", () => {
		for (const message of send_queue) {
			ws.send(message);
		}
		send_queue.length = 0;
	});

	// Each "message" event spawns an independent async handler, and
	// apply_patch_to_canvas() awaits a variable-duration createImageBitmap() -
	// without chaining, two patches can decode out of order and draw the
	// older one on top. Queue keeps handling strictly in arrival order.
	let message_queue = Promise.resolve();
	ws.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		message_queue = message_queue
			.then(() => handle_message(message))
			.catch((error) => console.error("Failed to handle multiplayer message:", error));
	});

	/** @param {object} message */
	async function handle_message(message) {
		if (message.type === "welcome") {
			is_connected = true;
			set_is_admin_connection(message.isAdmin);
		} else if (message.type === "history") {
			for (const patch of message.patches) {
				await apply_patch_to_canvas(patch);
			}
			// Once, after the whole batch - not per patch, since it's a full-canvas
			// snapshot and nothing reads it again until a local edit is made.
			noteExternalCanvasChange();
			// Otherwise the helper layer (and thumbnail window, if open) only
			// redraw on local pointer activity - a remote patch would sit
			// invisible in the thumbnail until the next local mousemove.
			update_helper_layer();
		} else if (message.type === "patch") {
			await apply_patch_to_canvas(message.patch);
			noteExternalCanvasChange();
			update_helper_layer();
		} else if (message.type === "patch-rejected") {
			show_error_message(message.reason);
		} else if (message.type === "presence") {
			updateOnlineCount(message.count);
		} else if (message.type === "cursors") {
			for (const [id, cursor] of Object.entries(message.cursors)) {
				showRemoteCursor(id, cursor.x, cursor.y, cursor.image);
			}
		} else if (message.type === "cursor") {
			showRemoteCursor(message.id, message.x, message.y, message.image);
		} else if (message.type === "cursor-left") {
			hideRemoteCursor(message.id);
		}
	}

	ws.addEventListener("error", () => {
		show_error_message("Couldn't connect to the shared canvas server. Your changes aren't being saved or shared right now.");
	});

	initMultiplayerBridge(async (patch) => {
		const data = await blob_to_base64(patch.imageBlob);
		send({
			type: "patch",
			patch: {
				id: patch.id,
				toolId: patch.toolId,
				toolLabel: patch.toolLabel,
				timestamp: patch.timestamp,
				rect: patch.rect,
				canvasSize: patch.canvasSize,
				image: { mimeType: "image/png", data },
			},
		});
	});

	startBroadcastingCursor(send);
}

initMultiplayerClient();
