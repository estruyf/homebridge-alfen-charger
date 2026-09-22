import { Backoff, Mutex, delay } from '../src/charger/mutex';

describe('Mutex', () => {
  it('runs queued work one at a time, in order', async () => {
    const mutex = new Mutex();
    const events: string[] = [];

    const task = (name: string, ms: number) =>
      mutex.runExclusive(async () => {
        events.push(`start ${name}`);
        await delay(ms);
        events.push(`end ${name}`);
      });

    await Promise.all([task('a', 20), task('b', 1), task('c', 5)]);

    expect(events).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('keeps the queue moving after a task throws', async () => {
    const mutex = new Mutex();
    const failing = mutex.runExclusive(async () => {
      throw new Error('boom');
    });
    const following = mutex.runExclusive(async () => 'ok');

    await expect(failing).rejects.toThrow('boom');
    await expect(following).resolves.toBe('ok');
  });

  it('returns each task\'s own result', async () => {
    const mutex = new Mutex();
    const results = await Promise.all([
      mutex.runExclusive(async () => 1),
      mutex.runExclusive(async () => 2),
    ]);
    expect(results).toEqual([1, 2]);
  });
});

describe('Backoff', () => {
  it('waits longer after each consecutive failure', () => {
    const backoff = new Backoff(1000, 60_000);
    const waits = [backoff.fail(0), backoff.fail(0), backoff.fail(0), backoff.fail(0)];

    expect(backoff.failureCount).toBe(4);
    // Full jitter means each wait is at least the base and within the growing ceiling.
    expect(waits.every((w) => w >= 1000)).toBe(true);
    expect(waits[0]).toBeLessThanOrEqual(1000);
    expect(waits[3]).toBeLessThanOrEqual(8000);
  });

  it('never waits longer than the cap', () => {
    const backoff = new Backoff(1000, 5000);
    for (let i = 0; i < 20; i++) {
      expect(backoff.fail(0)).toBeLessThanOrEqual(5000);
    }
  });

  it('blocks until the wait has elapsed', () => {
    const backoff = new Backoff(1000, 60_000);
    const wait = backoff.fail(0);

    expect(backoff.isBlocked(0)).toBe(true);
    expect(backoff.remainingMs(0)).toBe(wait);
    expect(backoff.isBlocked(wait)).toBe(false);
    expect(backoff.remainingMs(wait + 100)).toBe(0);
  });

  it('clears on success', () => {
    const backoff = new Backoff(1000, 60_000);
    backoff.fail(0);
    backoff.fail(0);
    backoff.reset();

    expect(backoff.failureCount).toBe(0);
    expect(backoff.isBlocked(0)).toBe(false);
  });
});
