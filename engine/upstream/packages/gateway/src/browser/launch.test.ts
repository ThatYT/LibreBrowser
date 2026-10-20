import { describe, expect, it } from "vitest";
import { defaultArgs as puppeteerDefaultArgs } from "puppeteer-core";

import { chromiumLaunchArgs } from "./launch";

describe("Chromium launch arguments", () => {
  it("merges BackForwardCache with Puppeteer's disabled features in one switch", async () => {
    const puppeteerFeatureArg = (await puppeteerDefaultArgs({ headless: false })).find((arg) =>
      arg.startsWith("--disable-features="),
    );
    expect(puppeteerFeatureArg).toBeDefined();

    const args = await chromiumLaunchArgs(
      [
        "--disable-dev-shm-usage",
        "--enable-automation=caller",
        "--disable-features=CallerFeature",
        "--disable-blink-features=CallerBlinkFeature",
      ],
      { headful: true, userDataDir: "/tmp/mirror-launch-test" },
    );
    const featureArgs = args.filter((arg) => arg.startsWith("--disable-features="));
    const blinkFeatureArgs = args.filter((arg) => arg.startsWith("--disable-blink-features="));
    const disabledFeatures = new Set(
      featureArgs[0]?.slice("--disable-features=".length).split(","),
    );
    const puppeteerFeatures = puppeteerFeatureArg!.slice("--disable-features=".length).split(",");

    expect(featureArgs).toHaveLength(1);
    expect(blinkFeatureArgs).toEqual([
      "--disable-blink-features=CallerBlinkFeature,AutomationControlled",
    ]);
    expect(disabledFeatures).toEqual(
      new Set([...puppeteerFeatures, "CallerFeature", "BackForwardCache"]),
    );
    expect(args).toContain("--no-first-run");
    expect(args).toContain("--password-store=basic");
    expect(args).not.toContain("--disable-dev-shm-usage");
    expect(args).toContain("--user-data-dir=/tmp/mirror-launch-test");
    expect(
      args.filter((arg) =>
        [
          "--enable-unsafe-swiftshader",
          "--ignore-gpu-blocklist",
          "--enable-gpu-rasterization",
        ].includes(arg),
      ),
    ).toEqual(["--enable-unsafe-swiftshader"]);
    expect(args.some((arg) => arg.startsWith("--enable-automation"))).toBe(false);
  });
});
