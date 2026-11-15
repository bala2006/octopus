/**
 * Which changes can skip the project's checks. A document or an image cannot break a test suite, but only when nothing
 * in the project reads it. A fixture a test loads, an icon a component imports, or a manifest such as requirements.txt
 * does affect the checks, whatever its extension, so the skip is decided from the project's own files.
 */
import path from "node:path";

/** Files that are not code: documents and images, fonts and media. */
export const DOC_OR_ASSET = /\.(md|mdx|txt|rst|adoc|png|jpe?g|gif|webp|ico|bmp|svg|pdf|woff2?|ttf|otf|mp3|mp4|webm|wav)$/i;
/** Document-shaped files that a tool reads as input. */
const MANIFEST = /(^|\/)(requirements[^/]*\.txt|constraints[^/]*\.txt|Pipfile|CODEOWNERS)$/i;

/** A text file of the project that is not a document or an asset: anything that could read one. */
export interface SourceFile { path: string; text: string }

/**
 * True when every changed file is a document or an asset that no source file refers to. A source refers to a file when it
 * names the file, or the folder it sits in (`fixtures/`), so a glob-free reference to a folder of documents is caught too.
 */
export function checksCanBeSkipped(changed: string[], sources: SourceFile[]): boolean {
  if (!changed.length) return false;
  if (!changed.every((f) => DOC_OR_ASSET.test(f) && !MANIFEST.test(f))) return false;
  const mentions = changed.flatMap((f) => {
    const dir = path.posix.dirname(f);
    return [path.posix.basename(f).toLowerCase(), dir === "." ? null : `${dir.toLowerCase()}/`];
  }).filter((m): m is string => !!m);
  return !sources.some((s) => {
    const text = s.text.toLowerCase();
    return mentions.some((m) => text.includes(m));
  });
}
