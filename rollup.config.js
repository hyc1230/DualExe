import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import typescript from "rollup-plugin-typescript2";

export default {
    input: "index.ts",
    output: {
        file: "dist/bundle.js",
        format: "cjs"
    },
    plugins: [
        resolve(),
        commonjs(),
        typescript()
    ]
};