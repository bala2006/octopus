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
  colors: { "editor.background": "#1F1E1D", "editor.lineHighlightBackground": "#2C2C2C", "editorGutter.background": "#1F1E1D" },
});
monaco.editor.defineTheme("octopus-light", {
  base: "vs", inherit: true, rules: [],
  colors: { "editor.background": "#FCFCFC", "editor.lineHighlightBackground": "#F0EEE6", "editorGutter.background": "#FAF9F5" },
});

export { monaco };
