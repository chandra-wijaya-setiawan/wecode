/** The heartbeat is the runner saying it is alive. It is not the runner saying it finished a
 *  tick, and the two are only the same while every tick is short.
 *
 *  Renewed at the end of a tick, the beat inherits the tick's duration: one attempt that runs
 *  a worker for a few minutes holds the renewal for a few minutes, the lease passes three
 *  intervals, and a second runner takes a workspace away from a process that is working
 *  perfectly. So the beat gets its own clock — a timer that fires whether or not the tick
 *  that started beside it has come back.
 *
 *  What that costs is the wedge detector: a tick stuck forever no longer goes stale by
 *  itself. That is the trade — a lease says the *process* is alive, and a stuck tick inside a
 *  live process is a different fault, for the doctor to name rather than for another runner
 *  to seize the workspace over. */

/** How the beat reaches the lease. `renew` returns false when the lease has been taken from
 *  under this holder; `onLost` is called once for that, and the beat stops. */
export interface HeartbeatPort {
  readonly everyMs: number;
  readonly renew: () => boolean;
  readonly onLost?: () => void;
  readonly signal?: AbortSignal;
}

export interface Heartbeat {
  /** Beat now, out of turn — on the way in, so the lease is fresh before the first tick. */
  readonly beat: () => void;
  readonly stop: () => void;
  /** True until the lease is lost or the beat is stopped. */
  readonly running: () => boolean;
}

/** Start beating. Every `everyMs`, regardless of what the caller is doing. */
export function startHeartbeat(port: HeartbeatPort): Heartbeat {
  let alive = true;

  const stop = (): void => {
    if (!alive) return;
    alive = false;
    clearInterval(timer);
  };

  const beat = (): void => {
    if (!alive) return;
    if (port.renew()) return;
    // Lost: stop before telling anyone, so an `onLost` that itself stops us, or that throws,
    // cannot leave a timer beating for a lease this process no longer holds.
    stop();
    port.onLost?.();
  };

  // A beat must never be the reason the process stays up: it is a claim about a process that
  // has work of its own, not work in itself.
  const timer = setInterval(beat, port.everyMs);
  timer.unref?.();

  port.signal?.addEventListener("abort", stop, { once: true });
  if (port.signal?.aborted === true) stop();

  return { beat, stop, running: () => alive };
}
