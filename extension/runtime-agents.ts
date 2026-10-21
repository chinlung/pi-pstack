/**
 * Registers pstack's two agents with pi-subagents as runtime agents.
 *
 * Upstream pstack ships `agents/poteto-agent.md` and `agents/comment-sicko.md` as Cursor
 * subagent files. Pi's equivalent is a pi-subagents agent, which can be a file in the package's
 * `agents/` directory. Registering them as runtime agents instead lets the package resolve the
 * skill path at load time, so a delegate can always find the installed `poteto-mode` skill
 * without depending on a hard-coded install location.
 */
const RUNTIME_REGISTER_EVENT = "pi-subagents:runtime-agent-register:v1";
/**
 * The part of the extension API that runtime agent registration needs.
 *
 * Narrowing to this keeps the registration testable with a small stub, and it documents that
 * registration talks to pi-subagents only through the event bus.
 */
export interface RuntimeAgentHost {
	readonly events: { emit(event: string, payload: unknown): void };
}

export interface RuntimeRegistration {
	dispose(): void;
}

/**
 * Registers a runtime agent with pi-subagents. The registry rejects unknown fields and
 * colliding names loudly, so an upstream rename fails at load instead of silently dropping the
 * agent.
 */
export function registerRuntimeAgent(
	pi: RuntimeAgentHost,
	name: string,
	definition: Record<string, unknown>,
): RuntimeRegistration {
	const request: {
		version: 1;
		name: string;
		definition: Record<string, unknown>;
		result?: { ok: true; registration: RuntimeRegistration } | { ok: false; error: Error };
	} = { version: 1, name, definition };
	pi.events.emit(RUNTIME_REGISTER_EVENT, request);
	if (!request.result) throw new Error("pi-subagents is not installed or not ready");
	if (!request.result.ok) throw request.result.error;
	return request.result.registration;
}

/** True when pi-subagents is loaded and can accept runtime agents. */
export function hasSubagents(pi: RuntimeAgentHost): boolean {
	const request: {
		version: 1;
		name: string;
		definition: Record<string, unknown>;
		result?: { ok: true; registration: RuntimeRegistration } | { ok: false; error: Error };
	} = {
		version: 1,
		name: "pi-pstack-probe",
		definition: {
			description: "probe",
			systemPrompt: "probe",
			tools: ["read"],
		},
	};
	try {
		pi.events.emit(RUNTIME_REGISTER_EVENT, request);
	} catch {
		return false;
	}
	if (!request.result) return false;
	if (!request.result.ok) return false;
	request.result.registration.dispose();
	return true;
}
