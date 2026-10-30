/**
 * Lightweight event bus for plugin-internal communication.
 * Replaces window.dispatchEvent(new CustomEvent(...)) / window.addEventListener(...)
 * with a typed, self-contained emitter that doesn't pollute the global scope.
 */

type Listener = (...args: any[]) => void;

class EventBus {
    private listeners = new Map<string, Set<Listener>>();

    /** Subscribe to an event. Returns an unsubscribe function. */
    on(event: string, fn: Listener): () => void {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event)!.add(fn);
        return () => this.listeners.get(event)?.delete(fn);
    }

    /** Emit an event with optional payload arguments. */
    emit(event: string, ...args: any[]): void {
        this.listeners.get(event)?.forEach((fn) => {
            try {
                fn(...args);
            } catch (e) {
                console.warn('File Tree Alternative: eventBus listener failed for', event, e);
            }
        });
    }
}

export const eventBus = new EventBus();
