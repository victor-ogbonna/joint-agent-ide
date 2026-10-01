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
 * 4 GB server that is 2. BUILD_SLOTS overrides it; docker-compose.yml sets 5
 * unless .env says otherwise.
 *
 * Each account has one build running at a time (PER_ACCOUNT_RUNNING): its
 * next one waits in line like anyone else's, so one account can never take
 * every slot while others wait. A person clicking Compile, Flash or Smart
 * Flash never has more than one or two in flight; more than
 * PER_ACCOUNT_WAITING waiting from one account is turned away.
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
  constructor(message = "The build server is very busy right now. Try again in a minute.") {
    super(message);
    this.name = "ServerBusyError";
  }
}

/** One account's builds at once: the rest of its builds wait their turn. */
export const PER_ACCOUNT_RUNNING = 1;
/** One account's builds waiting at once. A person has one or two at most; more is a script. */
export const PER_ACCOUNT_WAITING = 3;

interface Waiter {
  owner: string | null;
  start: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BuildQueue {
  private running = 0;
  private runningByOwner = new Map<string, number>();
  private waiting: Waiter[] = [];
  /** Builds that had to wait, and for how long, since the server started. */
  waitedCount = 0;
  waitedTotalMs = 0;
  longestWaitMs = 0;

  constructor(
    public readonly slots: number,
    private maxWaitMs = MAX_WAIT_MS,
    private maxWaiting = MAX_WAITING,
    private perOwnerRunning = PER_ACCOUNT_RUNNING,
    private perOwnerWaiting = PER_ACCOUNT_WAITING,
  ) {}

  get runningNow() { return this.running; }
  get waitingNow() { return this.waiting.length; }

  /** A free slot, and the owner (an account) not already at its own limit. */
  private canStart(owner: string | null): boolean {
    if (this.running >= this.slots) return false;
    return owner === null || (this.runningByOwner.get(owner) ?? 0) < this.perOwnerRunning;
  }

  private take(owner: string | null) {
    this.running += 1;
    if (owner !== null) this.runningByOwner.set(owner, (this.runningByOwner.get(owner) ?? 0) + 1);
  }

  /**
   * Run `job` when a slot is free and its owner has no other build running.
   * Resolves or rejects with the job's own result; rejects with
   * ServerBusyError if the line is too long, or the wait too long, to be
   * worth it. `owner` is the account; without one, only the slots count.
   */
  async run<T>(job: () => Promise<T>, onWaited?: (ms: number) => void, owner: string | null = null): Promise<T> {
    if (this.canStart(owner)) {
      this.take(owner);
    } else {
      if (this.waiting.length >= this.maxWaiting) throw new ServerBusyError();
      if (owner !== null && this.waiting.filter((w) => w.owner === owner).length >= this.perOwnerWaiting) {
        throw new ServerBusyError("You already have compiles waiting their turn. Try again when they finish.");
      }
      const queuedAt = Date.now();
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          owner,
          start: () => { clearTimeout(waiter.timer); resolve(); },
          timer: setTimeout(() => {
            this.waiting = this.waiting.filter((w) => w !== waiter);
            reject(new ServerBusyError());
          }, this.maxWaitMs),
        };
        this.waiting.push(waiter);
      });
      // The slot was taken for this build by the one that finished (see release).
      const waited = Date.now() - queuedAt;
      this.waitedCount += 1;
      this.waitedTotalMs += waited;
      this.longestWaitMs = Math.max(this.longestWaitMs, waited);
      onWaited?.(waited);
    }
    try {
      return await job();
    } finally {
      this.release(owner);
    }
  }

  private release(owner: string | null) {
    this.running -= 1;
    if (owner !== null) {
      const left = (this.runningByOwner.get(owner) ?? 1) - 1;
      if (left > 0) this.runningByOwner.set(owner, left);
      else this.runningByOwner.delete(owner);
    }
    // Every build in line that can start now does, oldest first. The slot is
    // taken here, at once, so a build arriving in between can't jump the line.
    // One whose account already has a build running stays put, keeping its
    // place, and the next one in line goes ahead of it.
    for (let i = 0; i < this.waiting.length && this.running < this.slots; ) {
      const w = this.waiting[i];
      if (this.canStart(w.owner)) {
        this.waiting.splice(i, 1);
        this.take(w.owner);
        w.start();
      } else {
        i++;
      }
    }
  }
}

export const buildQueue = new BuildQueue(configuredSlots());
