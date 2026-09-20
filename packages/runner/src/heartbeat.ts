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

/** The same argument one level down, about the work rather than about the process.
 *
 *  An assignment's `last_seen` is the operator's only evidence that an attempt is working
 *  rather than wedged, and it is written where the foreman observes — between phases. An
 *  attempt that spends twenty minutes inside one phase therefore reads as twenty minutes
 *  silent, and the board cannot tell it from an agent that died. So the work gets the same
 *  treatment as the lease: `live` answers the assignments whose processes are still there,
 *  and every one of them is marked seen on the clock, whatever phase it is in. */
export interface WorkHeartbeatPort {
  readonly everyMs: number;
  /** The assignments still believed to be working, asked afresh each beat: one that ended
   *  between beats must not go on being claimed alive. */
  readonly live: () => readonly number[];
  readonly seen: (id: number, at: string) => void;
  /** The clock the timestamps are written from. Injected so a test can fake it. */
  readonly now?: () => string;
  /** One assignment that could not be written. Told, not thrown: a row that fails is a
   *  fault for the doctor to name, and never a reason to stop claiming life for the
   *  attempts beside it — or to take the process down from inside a timer. */
  readonly onError?: (id: number, err: unknown) => void;
  readonly signal?: AbortSignal;
}

/** Start marking live work seen. Every `everyMs`, regardless of which phase it is in. */
export function startWorkHeartbeat(port: WorkHeartbeatPort): Heartbeat {
  const at = port.now ?? ((): string => new Date().toISOString());
  return startHeartbeat({
    everyMs: port.everyMs,
    ...(port.signal === undefined ? {} : { signal: port.signal }),
    renew: () => {
      for (const id of port.live()) {
        try {
          port.seen(id, at());
        } catch (err) {
          port.onError?.(id, err);
        }
      }
      // There is no lease to lose here: the work stops being beaten by leaving `live`.
      return true;
    },
  });
}
