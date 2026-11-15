import { isSensitivePath, tierOf, type Footprint } from "../src/engine/risk";

const part = (over: Partial<Footprint> = {}): Footprint => ({ files: ["src/app.ts"], lines: 5, specialists: 0, requirements: 0, revised: false, ...over });

describe("risk tiers", () => {
  test("a one-line edit to one file is trivial: nothing a second reviewer would find", () => {
    expect(tierOf(part({ lines: 2 }))).toBe("trivial");
  });

  test("a few lines in one file, or a few files, is small", () => {
    expect(tierOf(part({ lines: 30 }))).toBe("small");
    expect(tierOf(part({ files: ["src/a.ts", "src/b.ts"], lines: 10 }))).toBe("small");
  });

  test("a part that review sent back is at least small, however little the fix changes", () => {
    expect(tierOf(part({ lines: 1, revised: true }))).toBe("small");
  });

  test("requirements, dependency or build configuration, or a larger change is normal", () => {
    expect(tierOf(part({ requirements: 1 }))).toBe("normal");
    for (const file of ["package.json", "packages/api/package.json", "requirements.txt", "tsconfig.json", "vite.config.ts", "Makefile"]) {
      expect(tierOf(part({ files: [file], lines: 1 })), file).toBe("normal");
    }
    expect(tierOf(part({ files: ["a.ts", "b.ts", "c.ts"], lines: 3 }))).toBe("normal");
    expect(tierOf(part({ lines: 120 }))).toBe("normal");
  });

  test("specialists, a sensitive path, or a very large change is high", () => {
    expect(tierOf(part({ specialists: 1 }))).toBe("high");
    expect(tierOf(part({ files: ["src/auth/session.ts"], lines: 1 }))).toBe("high");
    expect(tierOf(part({ lines: 500 }))).toBe("high");
    expect(tierOf(part({ files: Array.from({ length: 9 }, (_, i) => `f${i}.ts`), lines: 3 }))).toBe("high");
  });
});

describe("sensitive paths", () => {
  test("they match whole words, so an author's name does not", () => {
    expect(isSensitivePath("src/auth/login.ts")).toBe(true);
    expect(isSensitivePath("server/secrets.json")).toBe(true);
    expect(isSensitivePath(".env")).toBe(true);
    expect(isSensitivePath(".github/workflows/ci.yml")).toBe(true);
    expect(isSensitivePath("docs/authors.md")).toBe(false);
    expect(isSensitivePath("src/tokenizer.ts")).toBe(false);
  });
});
