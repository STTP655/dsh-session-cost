/**
 * dsh-session-cost — show the estimated DeepSeek API cost of the current
 * session in the web GUI stats strip.
 *
 * Host face: v1 needs no host behavior — the computation lives in the client
 * face, which reads the durable `tokenUsage` session projection (the same
 * source the shipped stats strip uses) and multiplies by the official
 * DeepSeek pricing, peak/off-peak aware. This entry exists so the bundle row
 * loads cleanly on the host plane and the package's `./client` face joins the
 * browser roster through its `dsh.client` manifest.
 */

/** Stable Cordis plugin name. */
const name = "session-cost";

/** No host services required in v1. */
const inject = [];

/** Host body is intentionally a no-op; see the module doc. */
function apply() {}

export { apply, inject, name };
