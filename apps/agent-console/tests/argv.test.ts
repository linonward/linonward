import { describe, expect, it } from "vitest";

import { parseAllowedArgvLines, splitArgv } from "../src/lib/argv.js";

describe("splitArgv", () => {
  it("按空白切分，保留引号内的空格", () => {
    expect(splitArgv("node --version")).toEqual(["node", "--version"]);
    expect(splitArgv('  node   -e  "console.log(1)"  ')).toEqual(["node", "-e", "console.log(1)"]);
    expect(splitArgv("echo 'a b'")).toEqual(["echo", "a b"]);
  });

  it("空行与只有空白的行不产生 argv", () => {
    expect(splitArgv("")).toEqual([]);
    expect(splitArgv("   \t ")).toEqual([]);
    expect(parseAllowedArgvLines(["", "  ", "node --version"])).toEqual([["node", "--version"]]);
  });

  it("不做任何 shell 展开：$ 与 * 原样保留", () => {
    expect(splitArgv("echo $HOME")).toEqual(["echo", "$HOME"]);
    expect(splitArgv("rm *.ts")).toEqual(["rm", "*.ts"]);
  });
});
