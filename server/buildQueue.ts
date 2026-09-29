import os from "os";

/**
 * How many builds run at the same moment.
 *
 * A build uses every core it can get and up to about a gigabyte of memory
 * (an ESP32 build most of all). Started all at once, a rush of them runs the
 * server out of memory and fails for everyone. So builds take turns: a few
 * run, the rest wait in line, first come first served, and nobody's compile
 * is refused unless the wait grows absurd.
 *
 * The number comes from the machine: one per core, as long as memory allows
 * about a gigabyte each after a gigabyte for the app itself. On a 2-core,
 * 4 GB server that is 2. BUILD_SLOTS overrides it.
 */

const GB = 1024 * 1024 * 1024;
/** Past this, a waiting build gives up and the user is asked to try again. */
export const MAX_WAIT_MS = 10 * 60 * 1000;
/** More waiting than this and new builds are turned away at once. */
export const MAX_WAITING = 60;

export function defaultBuildSlots(cores = os.cpus().length, totalMemBytes = os.totalmem()): number {
  const byMemory = Math.floor(totalMemBytes / GB - 1);
  return Math.max(1, Math.min(Math.max(1, cores), byMemory));
}

function configuredSlots(): number {
  const n = Number(process.env.BUILD_SLOTS);
  return Number.isInteger(n) && n >= 1 && n <= 64 ? n : defaultBuildSlots();
}

export class ServerBusyError extends Error {
  constructor() {
    super("The build server is very busy right now. Try again in a minute.");
    this.name = "ServerBusyError";
  }
}

interface Waiter {
  start: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BuildQueue {
  private running = 0;
  private waiting: Waiter[] = [];
  /** Builds that had to wait, and for how long, since the server started. */
  waitedCount = 0;
  waitedTotalMs = 0;
  longestWaitMs = 0;

  constructor(public readonly slots: number, private maxWaitMs = MAX_WAIT_MS, private maxWaiting = MAX_WAITING) {}

  get runningNow() { return this.running; }
  get waitingNow() { return this.waiting.length; }

  /**
   * Run `job` when a slot is free. Resolves or rejects with the job's own
   * result; rejects with ServerBusyError if the line is too long, or the
   * wait too long, to be worth it.
   */
  async run<T>(job: () => Promise<T>, onWaited?: (ms: number) => void): Promise<T> {
    if (this.running >= this.slots) {
      if (this.waiting.length >= this.maxWaiting) throw new ServerBusyError();
      const queuedAt = Date.now();
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          start: () => { clearTimeout(waiter.timer); resolve(); },
          timer: setTimeout(() => {
            this.waiting = this.waiting.filter((w) => w !== waiter);
            reject(new ServerBusyError());
          }, this.maxWaitMs),
        };
        this.waiting.push(waiter);
      });
      // The slot was handed over by the build that finished (see release).
      const waited = Date.now() - queuedAt;
      this.waitedCount += 1;
      this.waitedTotalMs += waited;
      this.longestWaitMs = Math.max(this.longestWaitMs, waited);
      onWaited?.(waited);
    } else {
      this.running += 1;
    }
    try {
      return await job();
    } finally {
      this.release();
    }
  }

  private release() {
    const next = this.waiting.shift();
    // The slot passes straight to the next in line, so it can't be taken
    // by a build that arrives in between.
    if (next) next.start();
    else this.running -= 1;
  }
}

export const buildQueue = new BuildQueue(configuredSlots());
