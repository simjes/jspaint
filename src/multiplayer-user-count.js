// @ts-check
/* global $bottom */
import { E } from "./helpers.js";

/** @type {JQuery<HTMLDivElement> | null} */
let $count_display = null;

/**
 * Shows how many people are currently connected to the shared canvas, in the
 * bottom-right corner of the color box's row - styled with the same
 * inset-shallow status-field look as the real status bar, so it fits the
 * rest of the (deliberately janky) Paint chrome instead of looking bolted on.
 * @param {number} count
 */
export function updateOnlineCount(count) {
	if (!$count_display) {
		$count_display = $(E("div")).addClass("multiplayer-user-count status-field inset-shallow").appendTo($bottom);
	}
	$count_display.text(count === 1 ? "1 user online" : `${count} users online`);
}
