import globals from "globals";
import pluginJs from "@eslint/js";

export default [
  { ignores: ['coverage/**', 'dist/**'] },
  { files: ["**/*.js"], languageOptions: { sourceType: "commonjs" } },
  { languageOptions: { globals: globals.node } },
  { languageOptions: { globals: globals.jest } },
  pluginJs.configs.recommended,
];
