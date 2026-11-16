import { checksCanBeSkipped, type SourceFile } from "../src/engine/checkScope";

const src = (path: string, text: string): SourceFile => ({ path, text });

describe("skipping the project's checks for a change", () => {
  test("a document nothing in the project refers to can skip them", () => {
    expect(checksCanBeSkipped(["README.md"], [src("src/app.ts", "export const x = 1;")])).toBe(true);
    expect(checksCanBeSkipped(["docs/guide.md"], [src("src/app.ts", "export const x = 1;")])).toBe(true);
  });

  test("an image or font nothing imports can skip them", () => {
    expect(checksCanBeSkipped(["public/logo.svg"], [src("src/app.ts", "const a = 1;")])).toBe(true);
  });

  test("a fixture that a source reads by name is not skipped", () => {
    const script = src("check.js", "const data = fs.readFileSync('fixtures/data.txt', 'utf8');");
    expect(checksCanBeSkipped(["fixtures/data.txt"], [script])).toBe(false);
  });

  test("an asset a component imports by name is not skipped", () => {
    expect(checksCanBeSkipped(["src/logo.svg"], [src("src/App.tsx", "import logo from './logo.svg';")])).toBe(false);
  });

  test("a document that a source reads through its folder is not skipped", () => {
    expect(checksCanBeSkipped(["content/post.md"], [src("test/build.test.ts", "readdirSync('content/')")])).toBe(false);
  });

  test("a dependency manifest is never a document, whatever its extension", () => {
    expect(checksCanBeSkipped(["requirements.txt"], [])).toBe(false);
    expect(checksCanBeSkipped(["server/requirements-dev.txt"], [])).toBe(false);
  });

  test("a change that touches code is never skipped", () => {
    expect(checksCanBeSkipped(["README.md", "src/index.ts"], [])).toBe(false);
  });

  test("no change means nothing to skip", () => {
    expect(checksCanBeSkipped([], [])).toBe(false);
  });
});
