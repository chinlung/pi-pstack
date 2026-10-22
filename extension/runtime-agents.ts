/**
 * Registers agents with pi-subagents as runtime agents, through its event bus.
 *
 * Runtime registration, rather than agent files in the package manifest, lets the extension put
 * the installed skills' absolute paths into each prompt. The two must not both exist: pi-subagents
 * checks runtime agents against discovered agents when it merges them for a launch, and a name
 * collision there fails agent discovery for every launch.
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
