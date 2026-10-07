// herdr shows a pi agent as blocked while any extension holds `herdr:blocked` on pi's event bus
// (its pi integration counts `{ active: true, label }` / `{ active: false }` pairs). Every dialog
// that waits on the user holds it for as long as it is open. Outside herdr nothing listens, so the
// events are inert.
export const HERDR_BLOCKED = "herdr:blocked";

interface EventBus {
  emit(channel: string, data: unknown): void;
}

function emit(events: EventBus | undefined, data: unknown): void {
  try {
    events?.emit(HERDR_BLOCKED, data);
  } catch {
    // A failing listener must not break the dialog.
  }
}

/** Run `run` (a dialog) while holding `herdr:blocked`, released however it ends. */
export async function whileBlocked<T>(events: EventBus | undefined, label: string, run: () => Promise<T>): Promise<T> {
  emit(events, { active: true, label });
  try {
    return await run();
  } finally {
    emit(events, { active: false });
  }
}
