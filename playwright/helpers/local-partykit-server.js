// @ts-check
// Spins up (and tears down) a throw-away local `partykit dev` process, so
// tests never touch a developer's own manually-started server/room.
const { spawn } = require("child_process");

/**
 * @param {object} options
 * @param {string} options.cwd - the multiplayer server project's directory
 *   (where its partykit.json lives).
 * @param {number} options.port
 * @param {number} [options.readyTimeoutMs]
 * @returns {Promise<{ process: import("child_process").ChildProcess, stop: () => void }>}
 */
async function startLocalPartykitServer({ cwd, port, readyTimeoutMs = 20000 }) {
	const partykitProcess = spawn("npx", ["partykit", "dev", "--port", String(port)], {
		cwd,
		stdio: "pipe",
	});

	await new Promise((resolve, reject) => {
		let output = "";
		const onData = (data) => {
			output += data.toString();
			if (output.includes("Ready on")) {
				partykitProcess.stdout.off("data", onData);
				resolve(undefined);
			}
		};
		partykitProcess.stdout.on("data", onData);
		partykitProcess.stderr.on("data", (data) => { output += data.toString(); });
		partykitProcess.on("error", reject);
		setTimeout(() => reject(new Error(`Test PartyKit server didn't start in time. Output so far:\n${output}`)), readyTimeoutMs);
	});

	// "Ready on" fires slightly before it can actually accept WebSocket
	// upgrades - a short settle buffer avoids that race.
	await new Promise((resolve) => setTimeout(resolve, 2000));

	return {
		process: partykitProcess,
		stop: () => partykitProcess.kill(),
	};
}

module.exports = { startLocalPartykitServer };
