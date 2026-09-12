import { execFileSync } from "node:child_process";

export function assertBranchMayCommit(branch) {
  if (branch === "main") {
    throw new Error(
      "Commits on main are prohibited. Create a topic branch and open a pull request.",
    );
  }
}

const branch = execFileSync("git", ["branch", "--show-current"], {
  encoding: "utf8",
}).trim();

assertBranchMayCommit(branch);
