import { expect, test } from "@playwright/test";
import { reviewedVersionFromTitle } from "../src/metadata/versionDesignation";

test("extracts reviewed mix designations with complex names", () => {
  const examples = [
    ["Souvenirs (Industrial Badgers House Radio Mix)", "Industrial Badgers House Radio Mix"],
    ["Be Mine (M's Disco Heaven Knows Tribute Mix)", "M's Disco Heaven Knows Tribute Mix"],
    ["Be Mine (ChP MAlfuNctioN Mix)", "ChP MAlfuNctioN Mix"],
    ["Yo Nikki No (Bye Bitch Bye House Mix)", "Bye Bitch Bye House Mix"]
  ];

  for (const [title, expected] of examples) {
    expect(reviewedVersionFromTitle(title)).toBe(expected);
  }
});

test("does not treat non-mix parenthetical suffixes as versions", () => {
  expect(reviewedVersionFromTitle("Song (1)")).toBeNull();
  expect(reviewedVersionFromTitle("Song (Explicit)")).toBeNull();
});
