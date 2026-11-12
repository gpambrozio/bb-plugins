// Shot list for launchd-jobs: the Scheduled jobs page with a failing job open and the failure count on
// the sidebar entry, at desktop and phone width, light and dark; the New job form saying a cron
// expression in words; and a GIF of typing one. Run with `npm run shots -- launchd-jobs` in
// tools/shots; it writes into launchd-jobs/docs/screenshots/.
//
// The jobs are fixtures: plists written into the fake HOME's ~/Library/LaunchAgents, their history
// and logs in the plugin's own data folder, and their launchd state in the dev bb's stub `launchctl`
// (tools/shots/launchctl-stub.mjs). The real launchd is never asked: the seed checks that the
// plugin's first listing reached the stub before anything is shot, and nothing here saves, runs,
// enables or deletes a job.
import { join } from "node:path";
import { writeTree } from "../../tools/shots/lib/seed.mjs";

const PREFIX = "com.paseo-plugins.launchd-jobs.";
const PLUGIN = "launchd-jobs";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Every combination of the listed values, as launchd's calendar entries for a cron expression. */
function product(fields) {
  return Object.entries(fields).reduce(
    (entries, [key, values]) => entries.flatMap((entry) => values.map((value) => ({ ...entry, [key]: value }))),
    [{}],
  );
}
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * The jobs. `runs` are [days ago, exit code, seconds] for a daily job's history, newest first;
 * `every` spaces them for the interval job. `state` is what the stub launchd says.
 */
const JOBS = [
  {
    slug: "back-up-photos",
    name: "Back up photos",
    command: "rsync -a --delete ~/Pictures/ /Volumes/Backup/Pictures/",
    cron: { expression: "0 2 * * *", entries: [{ Hour: 2, Minute: 0 }] },
    runs: Array.from({ length: 14 }, (_, i) => [i, 0, 40 + ((i * 7) % 23)]),
    log: ["sending incremental file list", "2026/IMG_4183.heic", "2026/IMG_4184.heic", "sent 48.2M bytes  received 1.1K bytes  total size 61.4G"],
    state: { running: false, runs: 14, lastExitCode: 0 },
  },
  {
    slug: "sync-notes",
    name: "Sync notes",
    command: "git -C ~/Notes pull --rebase && git -C ~/Notes push",
    interval: 1800,
    every: 0.5 * HOUR,
    runs: [
      ...Array.from({ length: 5 }, (_, i) => [i, 128, 3]),
      ...Array.from({ length: 15 }, (_, i) => [i + 5, 0, 2 + (i % 3)]),
    ],
    log: [
      "ssh: connect to host git.example.com port 22: Network is unreachable",
      "fatal: Could not read from remote repository.",
      "",
      "Please make sure you have the correct access rights",
      "and the repository exists.",
    ],
    state: { running: false, runs: 20, lastExitCode: 128 },
  },
  {
    slug: "renew-dev-certificates",
    name: "Renew dev certificates",
    command: "mkcert -install && mkcert -cert-file ~/.certs/dev.pem -key-file ~/.certs/dev-key.pem localhost '*.acme.test'",
    cron: { expression: "0 9 1 * *", entries: [{ Day: 1, Hour: 9, Minute: 0 }] },
    runs: [[11, 1, 2], [42, 0, 3], [72, 0, 3]],
    log: ["ERROR: failed to save CA certificate: open ~/.certs/dev.pem: no such file or directory"],
    state: { running: false, runs: 1, lastExitCode: 1 },
  },
  {
    slug: "build-docs-site",
    name: "Build docs site",
    command: "cd ~/Sites/acme-docs && npm run build",
    cron: { expression: "*/30 9-18 * * 1-5", entries: product({ Minute: [0, 30], Hour: range(9, 18), Weekday: range(1, 5) }) },
    runs: [[0, 0, 74], [0.02, 0, 71], [0.04, 0, 69], [0.06, 0, 77]],
    log: ["> acme-docs@3.2.0 build", "> astro build", "building 214 pages"],
    state: { running: true, pid: 48213, runs: 31, lastExitCode: 0 },
  },
  {
    slug: "prune-docker-images",
    name: "Prune Docker images",
    command: "docker image prune -af --filter until=168h",
    cron: { expression: "30 3 * * 0", entries: [{ Weekday: 0, Hour: 3, Minute: 30 }] },
    runs: [[3, 0, 12], [10, 0, 9], [17, 0, 15]],
    log: ["Deleted Images:", "deleted: sha256:4f1c…", "Total reclaimed space: 6.2GB"],
    state: { running: false, runs: 3, lastExitCode: 0 },
  },
  {
    slug: "clear-old-downloads",
    name: "Clear old downloads",
    command: "find ~/Downloads -type f -mtime +30 -delete",
    cron: { expression: "0 12 * * 6", entries: [{ Weekday: 6, Hour: 12, Minute: 0 }] },
    runs: [[20, 0, 1], [27, 0, 1]],
    log: [],
    disabled: true,
  },
];

const xml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const dict = (entry) => `<dict>${Object.entries(entry).map(([k, v]) => `<key>${k}</key><integer>${v}</integer>`).join("")}</dict>`;

/** The plist the plugin itself writes for a job: the runner shape, its data folder named inside. */
function plist(job, dataDir) {
  const schedule = job.interval
    ? `<key>StartInterval</key><integer>${job.interval}</integer>`
    : `<key>StartCalendarInterval</key><array>${job.cron.entries.map(dict).join("")}</array>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PREFIX}${job.slug}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>${dataDir}/runner.sh</string><string>${job.slug}</string><string>${xml(job.command)}</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PASEO_LAUNCHD_JOBS_DIR</key><string>${dataDir}</string><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  ${schedule}
  <key>StandardErrorPath</key><string>${dataDir}/logs/${job.slug}.log</string>
</dict>
</plist>
`;
}

/** The runner's history: one JSON line per run, oldest first. */
function history(job, now) {
  const at9 = new Date(now);
  at9.setHours(job.cron?.entries?.[0]?.Hour ?? 9, job.cron?.entries?.[0]?.Minute ?? 0, 4, 0);
  const latest = Math.min(at9.getTime() - (at9.getTime() > now ? DAY : 0), now - 20 * 60_000);
  return job.runs
    .map(([ago, exitCode, seconds], i) => {
      const start = job.every ? now - 12 * 60_000 - i * job.every : latest - ago * DAY;
      const record = { startedAt: new Date(start).toISOString().replace(/\.\d+Z$/, "Z"), finishedAt: new Date(start + seconds * 1000).toISOString().replace(/\.\d+Z$/, "Z"), exitCode, durationMs: seconds * 1000 + 137 };
      return JSON.stringify(record);
    })
    .reverse()
    .join("\n") + "\n";
}

function log(job, now) {
  if (!job.log.length) return "";
  const at = new Date(now - 12 * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
  const failed = job.runs[0][1];
  return [`=== ${at} start`, ...job.log, `=== ${at} exit ${failed}`, ""].join("\n");
}

export async function seed({ bb, seed }) {
  const dataDir = join(bb.cfg.data, "plugins", PLUGIN, "host-data");
  const now = Date.now();
  const files = { "jobs.json": JSON.stringify({ names: Object.fromEntries(JOBS.map((job) => [job.slug, job.name])) }) };
  for (const job of JOBS) {
    files[`runs/${job.slug}.jsonl`] = history(job, now);
    if (job.log.length) files[`logs/${job.slug}.log`] = log(job, now);
  }
  writeTree(dataDir, files);
  seed.homeFiles(Object.fromEntries(JOBS.map((job) => [`Library/LaunchAgents/${PREFIX}${job.slug}.plist`, plist(job, dataDir)])));
  seed.launchd({
    services: Object.fromEntries(JOBS.filter((job) => job.state).map((job) => [`${PREFIX}${job.slug}`, job.state])),
    disabled: JOBS.filter((job) => job.disabled).map((job) => `${PREFIX}${job.slug}`),
  });

  // The plugin was installed before these files existed; a reload counts the failures at once
  // instead of at its next one-minute poll.
  bb.cli(["plugin", "reload", PLUGIN]);
  const { primaryHostId } = seed.rpc(PLUGIN, "hosts");
  const { jobs } = seed.rpc(PLUGIN, "list", { hostId: primaryHostId });
  // The safety check: the listing's launchd state must have come from the stub.
  const asked = seed.launchctlCalls().filter(([verb]) => verb === "print");
  const building = jobs.find((job) => job.id === "build-docs-site");
  if (asked.length < JOBS.length - 1 || building?.running !== true || building?.pid !== 48213) {
    throw new Error(`the plugin's listing did not come from the stub launchctl (${asked.length} print calls); refusing to shoot`);
  }
  if (jobs.length !== JOBS.length || jobs.some((job) => job.problem)) {
    throw new Error(`the fixture jobs did not list cleanly: ${JSON.stringify(jobs.map((job) => [job.id, job.problem]))}`);
  }
}

const PAGE = "/plugins/launchd-jobs/jobs";
const FAILING = "Sync notes";

async function openPage(shots, variant) {
  const page = await shots.page(variant, PAGE);
  await page.getByText("Back up photos", { exact: true }).first().waitFor();
  return page;
}

/** Opens the failing job; opening it acknowledges it, so the badge then counts the other one. */
async function openFailing(page) {
  await page.getByText(FAILING, { exact: true }).first().click();
  await page.getByText("Recent runs", { exact: false }).first().waitFor();
  await page.getByText(/Could not read from remote repository/).first().waitFor();
  await page.getByRole("button", { name: /Scheduled jobs.*1/ }).first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(500);
}

export async function shoot({ shots, VARIANTS }) {
  for (const [variant, file] of [
    [VARIANTS.desktopLight, "jobs-light.png"],
    [VARIANTS.desktopDark, "jobs-dark.png"],
    [VARIANTS.phoneLight, "jobs-phone-light.png"],
    [VARIANTS.phoneDark, "jobs-phone-dark.png"],
  ]) {
    const page = await openPage(shots, variant);
    if (!variant.isMobile) {
      await openFailing(page);
    } else {
      await page.waitForTimeout(800);
    }
    await shots.still(page, file);
    await shots.closePage(page);
  }

  // The form says a cron expression in words. Nothing is saved: it is closed with the page.
  for (const [variant, file] of [
    [VARIANTS.desktopLight, "new-job-light.png"],
    [VARIANTS.desktopDark, "new-job-dark.png"],
  ]) {
    const page = await openPage(shots, variant);
    await page.getByRole("button", { name: "New job" }).click();
    await page.locator("#launchd-job-name").fill("Back up the database");
    await page.locator("#launchd-job-command").fill("pg_dump acme_dev | gzip > ~/Backups/acme-$(date +%F).sql.gz");
    await page.getByLabel("Cron expression").fill("0 9-17/2 * * 1-5");
    await page.getByText(/Mon–Fri/).first().waitFor();
    await page.waitForTimeout(400);
    await shots.still(page, file);
    await shots.closePage(page);
  }

  await shots.video(
    "new-job-demo",
    { ...VARIANTS.desktopLight, viewport: { width: 1280, height: 720 } },
    async (page) => {
      await page.goto(new URL(PAGE, page.url()).href, { waitUntil: "networkidle" });
      await page.getByText("Back up photos", { exact: true }).first().waitFor();
      await page.waitForTimeout(1200);
      await page.getByRole("button", { name: "New job" }).click();
      await page.waitForTimeout(800);
      await page.locator("#launchd-job-name").pressSequentially("Back up the database", { delay: 45 });
      await page.locator("#launchd-job-command").pressSequentially("pg_dump acme_dev | gzip > ~/Backups/acme.sql.gz", { delay: 30 });
      await page.waitForTimeout(500);
      const cron = page.getByLabel("Cron expression");
      // A daily time first, then a weekday range of every other hour: the sentence follows each key.
      await cron.fill("");
      await cron.pressSequentially("0 9 * * *", { delay: 160 });
      await page.getByText(/At 09:00/).first().waitFor();
      await page.waitForTimeout(1500);
      await cron.fill("");
      await cron.pressSequentially("0 9-17/2 * * 1-5", { delay: 160 });
      await page.getByText(/Mon–Fri/).first().waitFor();
      await page.waitForTimeout(2500);
    },
    { formats: ["gif"] },
  );
}
