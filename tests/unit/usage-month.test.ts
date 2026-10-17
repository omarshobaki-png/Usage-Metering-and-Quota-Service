import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { getUtcMonth } from "../../src/modules/usage/month.js";
import type { Clock } from "../../src/shared/clock.js";

describe("UTC usage month", () => {
  it.each([
    ["2026-10-31T23:59:59.999Z", "2026-10-01"],
    ["2026-11-01T00:00:00.000Z", "2026-11-01"],
    ["2026-11-01T01:30:00+02:00", "2026-10-01"],
    ["2026-10-31T23:30:00-02:00", "2026-11-01"],
    ["2026-12-31T23:59:59.999Z", "2026-12-01"],
    ["2027-01-01T00:00:00.000Z", "2027-01-01"],
    ["2028-02-29T12:00:00.000Z", "2028-02-01"],
    ["0001-01-01T00:00:00.000Z", "0001-01-01"],
    ["9999-12-31T23:59:59.999Z", "9999-12-01"]
  ])("maps %s to %s without changing the instant", (instant, expected) => {
    const date = new Date(instant);
    const original = date.getTime();

    expect(getUtcMonth(date)).toBe(expected);
    expect(date.getTime()).toBe(original);
  });

  it.each(["invalid", "0000-01-01T00:00:00Z", "+010000-01-01T00:00:00Z"])(
    "rejects unsupported processing time %s",
    (instant) => {
      expect(() => getUtcMonth(new Date(instant))).toThrow(RangeError);
    }
  );

  it.each(["America/Los_Angeles", "Asia/Hebron"])(
    "keeps UTC boundaries when the process timezone is %s",
    (timezone) => {
      const script = `
        import { getUtcMonth } from './src/modules/usage/month.ts';
        console.log(JSON.stringify([
          getUtcMonth(new Date('2026-10-31T23:59:59.999Z')),
          getUtcMonth(new Date('2026-11-01T00:00:00.000Z'))
        ]));
      `;
      const output = execFileSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        { encoding: "utf8", env: { ...process.env, TZ: timezone } }
      );

      expect(JSON.parse(output)).toEqual(["2026-10-01", "2026-11-01"]);
    }
  );

  it("lets an internal test clock cross midnight without waiting", () => {
    let instant = "2026-10-31T23:59:59.999Z";
    const clock: Clock = () => new Date(instant);

    expect(getUtcMonth(clock())).toBe("2026-10-01");
    instant = "2026-11-01T00:00:00.000Z";
    expect(getUtcMonth(clock())).toBe("2026-11-01");
  });
});
