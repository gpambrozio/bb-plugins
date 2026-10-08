/**
 * Tickets and sessions, with no sockets in sight.
 *
 * A ticket is what the app asks for before it opens the relay's WebSocket: a
 * random token bound to one Mac, usable once, for a few seconds. Redeeming it
 * opens a session; the relay (relay.ts) owns the sockets and tells the
 * registry when they close. The registry ends a session itself when it has
 * been idle too long, when it is too old, or when the user closes them all.
 */
import { CloseCode, type SessionInfo } from "../shared/channels";

export interface SessionRegistryOptions {
  now(): number;
  /** An unguessable string; tokens and session ids both come from it. */
  randomId(): string;
  /** How long a ticket may wait before its WebSocket opens. */
  ticketTtlMs: number;
  /**
   * A session with no bytes either way for this long is ended. While a page is
   * open noVNC keeps bytes moving, so this catches clients that went away; the
   * page ends sessions nobody is using (app/vnc-session.tsx).
   */
  idleMs: number;
  /** A session is ended this long after it opened, busy or not. */
  maxAgeMs: number;
  /** Unredeemed tickets kept at most; the oldest goes first. */
  maxTickets: number;
  /** Called with the open sessions after every open and close. */
  onChange(sessions: SessionInfo[]): void;
}

export type Redeemed = { ok: true; hostId: string } | { ok: false; reason: string };

/** How the registry asks the relay to drop a session's sockets. */
export type EndSession = (code: number, reason: string) => void;

export interface OpenSession {
  readonly id: string;
  /** Bytes moved: the session is not idle. */
  touch(): void;
  /** The sockets closed on their own; forget the session. Safe to call twice. */
  closed(): void;
}

interface Ticket {
  hostId: string;
  expiresAt: number;
}

interface Session {
  info: SessionInfo;
  end: EndSession;
}

export class SessionRegistry {
  private readonly tickets = new Map<string, Ticket>();
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly options: SessionRegistryOptions) {}

  mint(hostId: string): { token: string; expiresAt: number } {
    this.dropExpiredTickets();
    while (this.tickets.size >= this.options.maxTickets) {
      const oldest = this.tickets.keys().next().value;
      if (oldest === undefined) break;
      this.tickets.delete(oldest);
    }
    const token = this.options.randomId();
    const expiresAt = this.options.now() + this.options.ticketTtlMs;
    this.tickets.set(token, { hostId, expiresAt });
    return { token, expiresAt };
  }

  /** Uses up a ticket. A wrong Mac uses it up too: a token is never tried twice. */
  redeem(token: string, hostId: string): Redeemed {
    const ticket = this.tickets.get(token);
    this.tickets.delete(token);
    if (ticket === undefined) return { ok: false, reason: "unknown or already used ticket" };
    if (ticket.expiresAt <= this.options.now()) return { ok: false, reason: "expired ticket" };
    if (ticket.hostId !== hostId) return { ok: false, reason: "ticket is for another Mac" };
    return { ok: true, hostId };
  }

  open(hostId: string, end: EndSession): OpenSession {
    const now = this.options.now();
    const id = this.options.randomId();
    const session: Session = { info: { id, hostId, openedAt: now, lastActivityAt: now }, end };
    this.sessions.set(id, session);
    this.changed();
    return {
      id,
      touch: () => {
        session.info.lastActivityAt = this.options.now();
      },
      closed: () => {
        if (this.sessions.delete(id)) this.changed();
      },
    };
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((session) => ({ ...session.info }));
  }

  /** Ends every session; returns how many there were. */
  closeAll(code: number = CloseCode.closedByUser, reason = "closed from bb"): number {
    const ending = [...this.sessions.values()];
    for (const session of ending) this.end(session, code, reason);
    return ending.length;
  }

  /** Ends idle and old sessions and forgets expired tickets. Run it on a timer. */
  sweep(): void {
    this.dropExpiredTickets();
    const now = this.options.now();
    for (const session of [...this.sessions.values()]) {
      if (now - session.info.openedAt >= this.options.maxAgeMs) {
        this.end(session, CloseCode.maxAge, "session reached its maximum length");
      } else if (now - session.info.lastActivityAt >= this.options.idleMs) {
        this.end(session, CloseCode.idle, "no traffic for too long");
      }
    }
  }

  private end(session: Session, code: number, reason: string): void {
    if (!this.sessions.delete(session.info.id)) return;
    try {
      session.end(code, reason);
    } finally {
      this.changed();
    }
  }

  private dropExpiredTickets(): void {
    const now = this.options.now();
    for (const [token, ticket] of this.tickets) {
      if (ticket.expiresAt <= now) this.tickets.delete(token);
    }
  }

  private changed(): void {
    this.options.onChange(this.list());
  }
}
