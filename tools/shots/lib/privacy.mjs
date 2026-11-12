// The privacy gate: a shot whose page shows text from this machine's real identity fails the run.
// Fixtures (fake HOME, demo project, renamed machine) are what keeps shots clean; this catches a
// leak. It reads the page's text, not the pixels, so text drawn inside an image is not checked.
import { execFileSync } from "node:child_process";
import { homedir, hostname, userInfo } from "node:os";

function quiet(file, args) {
  try {
    return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/**
 * Terms that must not appear in a shot, read from this machine at run time so that no real name is
 * written into the repository: the home folder (and any `/Users/` path), the user and machine names,
 * git's global identity, and whatever SHOTS_DENY lists (comma-separated; use it for other machines'
 * names or real project names).
 */
export function denyList(env = process.env) {
  const terms = ["/Users/", homedir()];
  const user = userInfo().username;
  if (user.length >= 4) terms.push(user); // a two-letter user name matches ordinary words
  terms.push(hostname().replace(/\.local$/, ""));
  if (process.platform === "darwin") {
    terms.push(quiet("scutil", ["--get", "ComputerName"]), quiet("scutil", ["--get", "LocalHostName"]));
  }
  terms.push(quiet("git", ["config", "--global", "user.name"]), quiet("git", ["config", "--global", "user.email"]));
  terms.push(...(env.SHOTS_DENY ?? "").split(","));
  return [...new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 3))];
}

/** The deny-list terms found in `text`, case-insensitively. */
export function findPrivate(text, terms) {
  const lower = text.toLowerCase();
  return terms.filter((term) => lower.includes(term.toLowerCase()));
}

/** Everything a page shows as text: its rendered text, form values and accessible labels. */
export async function pageText(page) {
  return page.evaluate(() => {
    const parts = [document.title, document.body?.innerText ?? ""];
    for (const el of document.querySelectorAll("input, textarea")) parts.push(el.value ?? "", el.placeholder ?? "");
    for (const el of document.querySelectorAll("[aria-label], [title]")) {
      parts.push(el.getAttribute("aria-label") ?? "", el.getAttribute("title") ?? "");
    }
    return parts.join("\n");
  });
}

/** Throws when the page shows a deny-list term. `what` names the shot in the message. */
export async function assertPagePrivate(page, terms, what) {
  const found = findPrivate(await pageText(page), terms);
  if (found.length) {
    throw new Error(`privacy gate: ${what} shows ${found.map((t) => JSON.stringify(t)).join(", ")}; change the fixtures or mask it`);
  }
}
