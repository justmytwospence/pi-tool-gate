import { homedir } from "node:os";
import path from "node:path";

/** Programs that only read, whatever their arguments (special cases are checked below). */
const READ_ONLY_PROGRAMS = new Set([
  "ls", "cat", "head", "tail", "less", "more", "wc", "rg", "grep", "egrep", "fgrep", "ag", "fd", "find",
  "tree", "pwd", "echo", "printf", "which", "type", "whoami", "id", "date", "uname", "hostname", "env",
  "printenv", "stat", "file", "du", "df", "diff", "cmp", "sort", "uniq", "cut", "tr", "column", "nl", "jq",
  "yq", "basename", "dirname", "realpath", "readlink", "sha256sum", "shasum", "md5", "md5sum", "true",
  "false", "test", "ps", "uptime", "sed", "awk", "comm", "tac", "rev", "xxd", "od", "strings", "man",
  "tldr", "history", "lsof", "cd",
]);

/** `git <sub>` subcommands that only read. */
const READ_ONLY_GIT = new Set([
  "status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "ls-tree", "blame", "describe",
  "shortlog", "reflog", "cat-file", "grep", "remote", "tag", "config", "worktree", "stash", "merge-base",
  "name-rev", "for-each-ref", "show-ref", "rev-list", "whatchanged", "check-ignore",
]);

/** `<pm> <sub>` subcommands of package managers that only read. */
const READ_ONLY_PM: Record<string, Set<string>> = {
  npm: new Set(["ls", "list", "view", "info", "outdated", "explain", "why", "root", "prefix", "config", "help", "search"]),
  pnpm: new Set(["ls", "list", "why", "outdated", "root"]),
  yarn: new Set(["list", "why", "info", "outdated"]),
  cargo: new Set(["tree", "metadata", "search"]),
  pip: new Set(["list", "show", "freeze"]),
  uv: new Set(["tree"]),
  brew: new Set(["list", "info", "search", "outdated", "deps", "--prefix"]),
};

/**
 * Split a shell command into simple commands at `;`, `&&`, `||`, `|`, `&` and newlines, keeping
 * quoted text intact. Each part is tokenized with quotes removed.
 */
export function splitCommand(command: string): string[][] {
  const parts: string[][] = [];
  let tokens: string[] = [];
  let token = "";
  let inToken = false;
  let quote: '"' | "'" | undefined;
  const endToken = () => {
    if (inToken) tokens.push(token);
    token = "";
    inToken = false;
  };
  const endPart = () => {
    endToken();
    if (tokens.length) parts.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) token += command[++i];
      else token += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inToken = true;
    } else if (c === "\\" && i + 1 < command.length) {
      token += command[++i];
      inToken = true;
    } else if (c === ";" || c === "\n" || c === "|" || c === "&") {
      // `2>&1` and `&>` stay inside the token stream as redirects, not separators.
      if (c === "&" && (command[i - 1] === ">" || command[i + 1] === ">")) {
        token += c;
        inToken = true;
        continue;
      }
      endPart();
      if ((c === "|" || c === "&") && command[i + 1] === c) i++;
    } else if (c === " " || c === "\t") {
      endToken();
    } else {
      token += c;
      inToken = true;
    }
  }
  endPart();
  return parts;
}

/** Leading `FOO=bar` assignments and wrappers like `time`/`nice` are skipped. */
function program(tokens: string[]): { name: string; args: string[] } | undefined {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[i] as string)) i++;
  while (i < tokens.length && ["time", "nice", "command", "builtin"].includes(tokens[i] as string)) i++;
  const name = tokens[i];
  return name === undefined ? undefined : { name: path.basename(name), args: tokens.slice(i + 1) };
}

/** Output redirects other than to /dev/null or fd duplication, e.g. `> out.txt`, `>> log`. */
export function writeRedirects(command: string): string[] {
  const targets: string[] = [];
  const re = /(?:^|[^<>&0-9])(?:[0-9]|&)?>>?\s*(?!&)([^\s;|&]+)/gu;
  for (const match of command.matchAll(re)) {
    const target = match[1] as string;
    if (target !== "/dev/null" && !/^&?\d$/u.test(target)) targets.push(target);
  }
  return targets;
}

/** True when every simple command in `command` only reads. */
export function isReadOnlyBash(command: string, extra: readonly string[] = []): boolean {
  if (/\$\(|`|<\(|>\(/u.test(command)) return false;
  if (writeRedirects(command).length) return false;
  const parts = splitCommand(command);
  if (parts.length === 0) return false;
  return parts.every((tokens) => {
    const p = program(tokens);
    if (!p) return true;
    const { name, args } = p;
    if (extra.includes(name)) return true;
    if (name === "git") {
      const sub = args.find((a) => !a.startsWith("-"));
      if (!sub || !READ_ONLY_GIT.has(sub)) return false;
      if (sub === "branch" && args.some((a) => /^-(d|D|m|M|c|C|-delete|-move|-copy)$/u.test(a))) return false;
      if (sub === "remote" && args.some((a) => ["add", "remove", "rm", "rename", "set-url", "prune"].includes(a))) return false;
      if (sub === "tag" && args.some((a) => /^-(d|a|s|f)$/u.test(a) || a === "--delete")) return false;
      if (sub === "config" && !args.some((a) => ["--get", "--list", "-l", "--get-all", "--show-origin"].includes(a))) return false;
      if (sub === "stash" && !args.some((a) => ["list", "show"].includes(a))) return false;
      if (sub === "worktree" && !args.includes("list")) return false;
      return true;
    }
    const pm = READ_ONLY_PM[name];
    if (pm) {
      const sub = args.find((a) => !a.startsWith("-"));
      return sub !== undefined && pm.has(sub);
    }
    if (!READ_ONLY_PROGRAMS.has(name)) return false;
    if (name === "sed" && args.some((a) => /^-[a-zA-Z]*i/u.test(a) || a.startsWith("--in-place"))) return false;
    if (name === "find" && args.some((a) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fls"].includes(a))) return false;
    if (name === "awk" && args.some((a) => /system\(|>\s*"/u.test(a))) return false;
    if (name === "env" && args.some((a) => !a.startsWith("-") && !a.includes("="))) return false;
    return true;
  });
}

const CREDENTIAL_PATTERNS = [
  /(^|\/)\.env(\.[^/]*)?$/u,
  /(^|\/)\.ssh(\/|$)/u,
  /(^|\/)auth\.json$/u,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/u,
  /(^|\/)\.aws\/credentials$/u,
  /(^|\/)\.netrc$/u,
  /(^|\/)\.npmrc$/u,
  /(^|\/)\.pypirc$/u,
  /(^|\/)credentials(\.json)?$/u,
  /\.(pem|key|p12|pfx)$/u,
];

export function isCredentialPath(file: string): boolean {
  return CREDENTIAL_PATTERNS.some((re) => re.test(file));
}

export function expandHome(file: string): string {
  if (file === "~" || file === "$HOME") return homedir();
  if (file.startsWith("~/")) return path.join(homedir(), file.slice(2));
  if (file.startsWith("$HOME/")) return path.join(homedir(), file.slice(6));
  return file;
}

/** Whether `file` (relative to `cwd`) is inside `cwd` or a temp directory. */
export function isInsideWorkspace(file: string, cwd: string): boolean {
  const resolved = path.resolve(cwd, expandHome(file));
  const roots = [cwd, "/tmp", "/private/tmp", "/var/folders", process.env.TMPDIR ?? "/tmp"].map((r) => path.resolve(r));
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

/**
 * Reasons this bash command must be put to the user whatever Jev says, or [] when none apply.
 * `branch` is the current git branch, for force-pushes without an explicit refspec.
 */
export function alwaysAskBash(command: string, cwd: string, branch?: string): string[] {
  const reasons: string[] = [];
  const parts = splitCommand(command);
  for (const tokens of parts) {
    const p = program(tokens);
    if (!p) continue;
    const { name, args } = p;
    if (name === "sudo" || name === "doas") reasons.push("runs as root (sudo)");
    if (name === "rm" || name === "rmdir" || name === "trash") {
      for (const target of args.filter((a) => !a.startsWith("-"))) {
        const resolved = path.resolve(cwd, expandHome(target));
        if (resolved === "/" || resolved === homedir() || resolved === path.resolve(cwd) || !isInsideWorkspace(target, cwd)) {
          reasons.push(`deletes ${target}, the project itself or outside it`);
          break;
        }
      }
    }
    if (name === "git" && args.find((a) => !a.startsWith("-")) === "push") {
      const force = args.some((a) => a === "-f" || a === "--force" || a.startsWith("--force-with-lease") || a === "--mirror" || /^\+/u.test(a));
      const refs = args.filter((a) => !a.startsWith("-")).slice(1);
      const mentionsMain = refs.some((a) => /(^|[:+/])(main|master)$/u.test(a));
      const onMain = refs.length <= 1 && (branch === "main" || branch === "master");
      if (force && (mentionsMain || onMain)) reasons.push("force-pushes main/master");
    }
  }
  if (/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/u.test(command)) reasons.push("pipes a download into a shell");
  for (const tokens of parts) {
    for (const token of tokens) {
      if (isCredentialPath(expandHome(token))) {
        reasons.push(`touches credentials (${token})`);
        break;
      }
    }
  }
  for (const target of writeRedirects(command)) {
    if (!isInsideWorkspace(target, cwd)) reasons.push(`writes ${target} outside the project`);
  }
  return [...new Set(reasons)];
}

/** Reasons a write/edit to `file` must be put to the user, or []. */
export function alwaysAskPath(file: string, cwd: string): string[] {
  const reasons: string[] = [];
  if (isCredentialPath(expandHome(file))) reasons.push(`touches credentials (${file})`);
  if (!isInsideWorkspace(file, cwd)) reasons.push(`writes ${file} outside the project`);
  return reasons;
}

/** A key for "allow similar for this session": the first two words of a bash command. */
export function bashKey(command: string): string {
  const first = splitCommand(command)[0] ?? [];
  const p = program(first);
  if (!p) return command.trim().slice(0, 40);
  const sub = p.args.find((a) => !a.startsWith("-"));
  return sub ? `${p.name} ${sub}` : p.name;
}
