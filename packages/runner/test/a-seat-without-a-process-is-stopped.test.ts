import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import type { Work } from "../src/ports.js";
import { holderOf, processFault, processRefusal, stopWithoutProcess } from "../src/worker.js";

const work = (over: Partial<Work> = {}): Work => ({
  id: 41,
  objective_type: "task",
  objective_id: 7,
  instruction: "split the label out of the tree cell",
  scope: { paths: [] } as unknown as Work["scope"],
  budget: { tokens: 1000, seconds: 60 },
  worktree: "/tmp",
  session: null,
  history: null,
  ...over,
});

/** A process of our own that does nothing but stay up, and its holder as the beat writes
 *  it. Killing it and waiting for the exit reaps it, so the pid is gone rather than a
 *  zombie that a bare signal would still find. */
const opened = async (): Promise<{ holder: string; pid: number; end: () => Promise<void> }> => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const pid = child.pid as number;
  return {
    pid,
    holder: `${hostname()}/${pid}`,
    end: async () => {
      child.kill("SIGKILL");
      await once(child, "exit");
    },
  };
};

describe("a seat without a process is stopped", () => {
  // The story. A seat is opened by a live process, and while that process is there the seat
  // reads as running however old the beat is; the moment the process ends, the next look
  // reports it stopped and says which pid it lost.
  it("reads a seat as running until its process ends, then as stopped with the pid", async () => {
    const seat = await opened();

    expect(stopWithoutProcess(work(), seat.holder)).toBeNull();
    expect(processFault(seat.holder)).toBeNull();

    await seat.end();

    const seen = stopWithoutProcess(work(), seat.holder);
    expect(seen?.phase).toBe("failed");
    expect(seen?.phase === "failed" && seen.reason).toBe("lost");
    expect(seen?.phase === "failed" && seen.lesson).toContain(`pid ${seat.pid}`);
  });

  it("names the assignment and its objective, because the stop is what a person reads", async () => {
    const seat = await opened();
    await seat.end();
    const said = processRefusal(work({ objective_type: "acceptance_test", objective_id: 12 }), seat.holder);
    expect(said).toContain("assignment 41");
    expect(said).toContain("acceptance_test 12");
    expect(said).toContain(`pid ${seat.pid}`);
  });

  it("stops a seat whose beat names no process at all, which is the fault itself", () => {
    expect(processFault(null)).toBe("its beat names no process");
    expect(processFault("   ")).toBe("its beat names no process");
    expect(stopWithoutProcess(work(), null)).not.toBeNull();
  });

  it("stops a seat whose beat cannot be read as a process, and quotes what it said", () => {
    for (const said of ["nobody", `${hostname()}/0`, `${hostname()}/-4`, `${hostname()}/abc`, "/9"]) {
      expect(processFault(said)).toContain("no process it could find");
      expect(processFault(said)).toContain(said);
    }
  });

  it("says nothing about a seat held on another machine, where a pid means nothing", async () => {
    const seat = await opened();
    await seat.end();
    expect(processFault(`elsewhere/${seat.pid}`)).toBeNull();
    expect(stopWithoutProcess(work(), `elsewhere/${seat.pid}`)).toBeNull();
    // ...and the host it compares against is the one it was given, not a guess.
    expect(processFault(`elsewhere/${seat.pid}`, "elsewhere")).toContain(`pid ${seat.pid}`);
  });

  it("reads the process out of a holder shaped as the runner names itself", () => {
    expect(holderOf("box/1234")).toEqual({ host: "box", pid: 1234 });
    // A host with a slash in it still belongs to the host: the pid is the last field.
    expect(holderOf("box/one/1234")).toEqual({ host: "box/one", pid: 1234 });
    expect(holderOf("1234")).toBeNull();
    expect(holderOf(null)).toBeNull();
  });

  it("keeps the session and spends nothing, because nothing was run to find this out", async () => {
    const seat = await opened();
    await seat.end();
    const seen = stopWithoutProcess(work({ session: "sess-9" }), seat.holder);
    expect(seen?.session).toBe("sess-9");
    expect(seen?.spent).toEqual({ tokens: 0, seconds: 0 });
  });

  it("holds a seat whose process is this one, which is as alive as a process gets", () => {
    expect(processFault(`${hostname()}/${process.pid}`)).toBeNull();
    expect(stopWithoutProcess(work(), `${hostname()}/${process.pid}`)).toBeNull();
  });
});
