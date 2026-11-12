/**
 * The subscription handle every host capability hands back, whichever client
 * answered, and a way to hand one out before the client has loaded.
 */

/** A host subscription, in the shape both clients return. */
export interface HostSub {
  unsubscribe(): void;
  onInterrupt?(callback: (payload?: unknown) => void): unknown;
}

/**
 * A subscription handle that exists before the subscription does. Interrupt
 * listeners registered early are forwarded once the real one is live; an
 * unsubscribe that races ahead of it is honoured the moment it resolves. A
 * start that throws reports through the interrupt listeners, which is what
 * every caller already does with a host that dropped them.
 */
export function deferredSubscription(start: () => Promise<HostSub>): HostSub {
  let real: HostSub | null = null;
  let stopped = false;
  const interruptListeners: Array<(payload?: unknown) => void> = [];

  void start().then(
    (sub) => {
      if (stopped) {
        sub.unsubscribe();
        return;
      }
      real = sub;
      for (const cb of interruptListeners) sub.onInterrupt?.(cb);
    },
    (error) => {
      if (stopped) return;
      for (const cb of interruptListeners) cb(error);
    },
  );

  return {
    unsubscribe() {
      stopped = true;
      real?.unsubscribe();
    },
    onInterrupt(callback) {
      interruptListeners.push(callback);
      if (real) real.onInterrupt?.(callback);
      return () => {};
    },
  };
}
