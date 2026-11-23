/**
 * Announcements while a session is live: a thread starts waiting on you (a question or an approval), a
 * thread fails, and, when the **Announce** setting says so, a root thread finishes its turn. Each waits for a
 * gap (no response under way, no reply audio playing, you not speaking) and then asks the model, in the
 * conversation, to say it in a sentence. One cut off by you (barge-in) goes back in the queue once, whether
 * the cut came while the response was still being made or later, while its audio played (a response is done
 * before its audio has drained). Adapted from firstmate-voice's announcer.
 *
 * Each announcement is a script built here from the thread's title and project, said word for word, so the
 * model names nothing that is not in bb.
 */

export interface Announcement {
  id: string;
  /** What the model is asked to say, read with the items already in the conversation. */
  instructions: string;
  tries: number;
}

export interface AnnouncerOutput {
  /** Starts a response in the conversation with these instructions, tagged with the announcement id. */
  respond(instructions: string, id: string): void;
}

/** Text for inside a quoted script: one line, no double quotes to end it early. */
function scriptText(text: string): string {
  return text.replace(/\s+/gu, " ").replace(/"/gu, "'").trim();
}

export type ThreadNews = "waiting" | "failed" | "finished";

/** What the voice says when a thread starts waiting on you, fails or finishes. */
export function newsScript(news: ThreadNews, title: string, project: string | null): string {
  const name = `${scriptText(title)}${project === null ? "" : ` in ${scriptText(project)}`}`;
  switch (news) {
    case "waiting":
      return `${name} is waiting on you.`;
    case "failed":
      return `${name} failed.`;
    case "finished":
      return `${name} finished its turn.`;
  }
}

/** The announcement's instructions: the script word for word, and an offer that fits it. */
export function newsAnnouncement(news: ThreadNews, title: string, project: string | null): string {
  const after =
    news === "waiting"
      ? " Then offer, in a few words, to read it out. Do not read it until the user says so."
      : news === "failed"
        ? " Add nothing else."
        : " Then, only if the user asks, use get_thread for what it said.";
  return `Say exactly this, word for word: "${newsScript(news, title, project)}"${after} Do not name any other thread or project.`;
}

export class Announcer {
  private readonly queue: Announcement[] = [];
  private speaking = false;
  private responding = false;
  private playing = false;
  /** The announcement whose response is under way, by id. */
  private live: Announcement | null = null;
  /** The announcement whose response is done and whose audio may still be playing, until that audio ends. */
  private played: Announcement | null = null;
  private counter = 0;

  constructor(private readonly output: AnnouncerOutput) {}

  /** Queues an announcement; answers its id, which tags the response (or responses, on a retry) that say it. */
  enqueue(instructions: string): string {
    this.counter += 1;
    const id = `vp_ann_${this.counter}`;
    this.queue.push({ id, instructions, tries: 0 });
    this.pump();
    return id;
  }

  pending(): number {
    return this.queue.length;
  }

  userSpeaking(value: boolean): void {
    this.speaking = value;
    this.pump();
  }

  responseStarted(): void {
    this.responding = true;
  }

  /**
   * A response ended; `announcementId` is its metadata id when it was one of ours. `nextIsOurs` says the
   * session is starting another response at once (a tool's answer), so no announcement may start now.
   */
  responseDone(status: string, announcementId: string | null, nextIsOurs = false): void {
    this.responding = nextIsOurs;
    if (announcementId !== null && this.live?.id === announcementId) {
      const finished = this.live;
      this.live = null;
      // The user spoke over it: say it again once, at the next gap.
      if (status === "cancelled") {
        if (finished.tries < 2) this.queue.unshift(finished);
      } else this.played = finished;
    }
    this.pump();
  }

  /** OpenAI refused the last response.create (one was already under way, say): try the announcement again later. */
  refused(): void {
    const refused = this.live;
    this.live = null;
    this.responding = false;
    if (refused !== null && refused.tries < 2) this.queue.unshift(refused);
  }

  audio(playing: boolean): void {
    this.playing = playing;
    this.pump();
  }

  /**
   * Reply audio ended: played to its end, or `cut` by you talking over it. `announcementId` is the
   * announcement that audio belonged to, if any; one cut in playback is said again once, at the next gap.
   */
  audioEnded(cut: boolean, announcementId: string | null): void {
    this.playing = false;
    const played = this.played;
    if (announcementId !== null && played?.id === announcementId) {
      this.played = null;
      if (cut && played.tries < 2) this.queue.unshift(played);
    }
    this.pump();
  }

  /** Sends the next announcement when there is a gap. */
  pump(): void {
    if (this.speaking || this.responding || this.playing || this.live !== null) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    next.tries += 1;
    this.live = next;
    this.responding = true;
    this.output.respond(next.instructions, next.id);
  }
}
