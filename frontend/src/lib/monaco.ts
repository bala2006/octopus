/** Use the locally bundled monaco-editor (no CDN) so Octopus works fully offline. */
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-workers/editor/editor.worker.js?worker";
import jsonWorker from "monaco-workers/language/json/json.worker.js?worker";
import cssWorker from "monaco-workers/language/css/css.worker.js?worker";
import htmlWorker from "monaco-workers/language/html/html.worker.js?worker";
import tsWorker from "monaco-workers/language/typescript/ts.worker.js?worker";

self.MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });

monaco.editor.defineTheme("octopus-dark", {
  base: "vs-dark", inherit: true, rules: [],
  colors: { "editor.background": "#0f1320", "editor.lineHighlightBackground": "#171c2c", "editorGutter.background": "#0f1320" },
});

export { monaco };
