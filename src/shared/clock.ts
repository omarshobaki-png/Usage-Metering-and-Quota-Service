export type Clock = () => Date;

// Internal services can replace this clock in tests; HTTP callers cannot set it.
export const systemClock: Clock = () => new Date();
