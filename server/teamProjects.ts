/**
 * Working together on a team or school license, each only by the person's
 * own choice:
 *
 *   - Team projects. A project's owner shares it with the team (a button on
 *     /team, project by project). The team gets its own copy, which everyone
 *     on the team can view, copy to their own projects, or edit, one person
 *     at a time. Passwords, keys and tokens in the code are hidden in the
 *     team's copy (server/hideSecrets.ts), and the conversation with the
 *     agent is never shared.
 *   - Editing. Edit puts the team's copy in the editor's own projects (their
 *     working copy, which the app opens) and holds the team project for them
 *     for EDIT_HOLD_MS. Send makes their working copy the team's copy and
 *     lets it go; Stop editing lets it go unchanged. While one person holds
 *     it, the others see who, and can view or copy it. The team's admins can
 *     free a hold and remove a team project; so can whoever shared it.
 *   - Comments. Everyone on the team can comment on a team project (a
 *     teacher's note on a student's project, and the reply), and sees
 *     which projects have comments they haven't read. Whoever wrote a
 *     comment, or an admin, can delete it; removing the project removes
 *     its comments.
 *   - Admins seeing members' projects. Each member chooses whether the
 *     team's admins may see their projects (off until they turn it on).
 *     Admins then see them read-only, as a share link shows a project: the
 *     code and circuit, with secrets hidden, never the conversation.
 *
 * Both work only while the team's license is paid, or in its grace days
 * (licensePaid): not before the first payment, nor after a license ends
 * until it's renewed. Stopping, freeing and removing always work, and so
 * does each member's choice, so nobody is stuck holding a project and
 * privacy can always be switched back on.
 *
 * Firestore, server-only (the browser can't read or write these):
 *   teamProjects/{id}            the team's copy, who shared it, who is
 *                                editing it, and each editor's working copy
 *                                (which version of the team's copy it is),
 *                                and how many comments it has and when the
 *                                latest was written
 *   teamProjects/{id}/comments/{commentId}
 *                                each comment: who wrote it, when, the text
 *   teamMembers/{uid}            adminsCanView, the member's own choice,
 *                                teamCopies (each working copy's team project,
 *                                so opening a project reads one document, not
 *                                every team project), and commentsSeen (when
 *                                they last read each project's comments)
 *   users/{uid}/projects/{id}    working copies are written here, among the
 *                                person's own projects, with only the fields
 *                                a project always has (so the Firestore rules
 *                                that check a project's fields still pass)
 *
 * Every function takes the database as its first argument: adminDb in the
 * server, an in-memory stand-in in test/teamProjects.mjs.
 */
import type express from "express";
import { Timestamp } from "firebase-admin/firestore";
import { adminDb, isFirebaseAdminConfigured } from "./firebaseAdmin";
import { requireFirebaseAuth } from "./quota";
import { hideSecrets } from "./hideSecrets";
import { sharedView } from "./share";
import { MEMBERS, TEAMS, TeamError, licensePaid, memberOf, teamOf, type MemberRecord, type Who } from "./teams";

export const TEAM_PROJECTS = "teamProjects";
/** Most projects one team can share. */
export const MAX_TEAM_PROJECTS = 200;
/** How long Edit holds a team project for one person, unless they send it or stop first. */
export const EDIT_HOLD_MS = 24 * 60 * 60 * 1000;
/** The longest comment, in characters. */
export const MAX_COMMENT_LENGTH = 1000;
/** Most comments one team project keeps: a thread, not a chat room. */
export const MAX_COMMENTS_PER_PROJECT = 500;

const PROJECT_ID = /^[A-Za-z0-9]{1,64}$/;
const TEAM_PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UID = /^[A-Za-z0-9_-]{1,128}$/;

/** adminDb, or a stand-in with the same calls (tests). */
type Db = any;

const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const millis = (v: any): number | null => (v && typeof v.toMillis === "function" ? v.toMillis() : typeof v === "number" ? v : null);

const memberRef = (db: Db, uid: string) => db.collection(MEMBERS).doc(uid);
const teamProjectRef = (db: Db, id: string) => db.collection(TEAM_PROJECTS).doc(id);
const commentsOf = (db: Db, teamProjectId: string) => db.collection(`${TEAM_PROJECTS}/${teamProjectId}/comments`);
const ownProjects = (db: Db, uid: string) => db.collection(`users/${uid}/projects`);
const ownProjectRef = (db: Db, uid: string, projectId: string) => db.doc(`users/${uid}/projects/${projectId}`);

function cleanId(raw: unknown, re: RegExp, what: string): string {
  if (typeof raw !== "string" || !re.test(raw)) throw new TeamError(`No such ${what}.`, 404);
  return raw;
}

/** The person's membership: they must be on a team. `get` reads through a transaction or directly. */
async function membership(get: (ref: any) => Promise<any>, db: Db, uid: string): Promise<MemberRecord> {
  const snap = await get(memberRef(db, uid));
  const m = snap.exists ? memberOf(uid, snap.data()) : null;
  if (!m || !m.teamId) throw new TeamError("You're not on a team.", 404, "gone");
  return m;
}

/** Refused unless the person's team is paid now, or in its grace days: what to do instead depends on their role. */
async function paidTeam(get: (ref: any) => Promise<any>, db: Db, me: MemberRecord, now: number): Promise<void> {
  const snap = await get(db.collection(TEAMS).doc(me.teamId));
  if (!snap.exists) throw new TeamError("You're not on a team.", 404, "gone");
  const team = teamOf(me.teamId, snap.data());
  if (licensePaid(team, now)) return;
  const admin = me.role === "admin";
  throw new TeamError(team.paidUntil === null
    ? (admin ? "Team projects start once the license is paid. Pay for it on the Team page." : "Team projects start once your team's license is paid. Ask an admin to pay for it.")
    : (admin ? "The license has ended. Renew it on the Team page to use team projects again. Everyone's own projects are kept." : "Your team's license has ended. Team projects come back once an admin renews it. Your own projects are kept."),
  402, "unpaid");
}

/** Most code a team project holds; a longer one is refused, never cut short. */
const MAX_SHARED_CODE = 500_000;

/** What a project carries into a team's copy: never the conversation, never a secret in the code. */
function sharedContent(p: Record<string, any>) {
  const mcu = p.mcu === "arduino" ? "arduino" : "esp32";
  if (typeof p.code === "string" && p.code.length > MAX_SHARED_CODE) {
    throw new TeamError("This project's code is too long to share with the team (over 500,000 characters).", 413);
  }
  return {
    mcu,
    boardId: text(p.boardId, 64) || (mcu === "arduino" ? "uno" : "esp32dev"),
    description: text(p.description, 5000),
    code: hideSecrets(text(p.code, MAX_SHARED_CODE)),
    components: Array.isArray(p.components) ? p.components : [],
    connections: Array.isArray(p.connections) ? p.connections : [],
  };
}

interface Person { uid: string; email: string | null }
interface Editor extends Person { since: number; copyId: string }

export interface TeamProjectRecord {
  id: string;
  teamId: string;
  name: string;
  mcu: "esp32" | "arduino";
  boardId: string;
  description: string;
  code: string;
  components: any[];
  connections: any[];
  sharedBy: Person;
  sharedAt: number;
  updatedBy: Person;
  updatedAt: number;
  version: number;
  editor: Editor | null;
  /** Each editor's working copy, by their uid, and the team version it started from. */
  copies: Record<string, { copyId: string; version: number }>;
  /** The project it was shared from, so the same one isn't shared twice. */
  source: { uid: string; projectId: string } | null;
  commentCount: number;
  /** When the latest comment was written, and by whom: for "new comments". */
  lastCommentAt: number;
  lastCommentBy: string | null;
}

const personOf = (v: any): Person => ({ uid: typeof v?.uid === "string" ? v.uid : "", email: typeof v?.email === "string" && v.email ? v.email : null });

export function teamProjectOf(id: string, d: any): TeamProjectRecord {
  d = d || {};
  const editor = d.editor && typeof d.editor.uid === "string" && typeof d.editor.copyId === "string"
    ? { ...personOf(d.editor), since: num(d.editor.since), copyId: d.editor.copyId }
    : null;
  const copies: Record<string, { copyId: string; version: number }> = {};
  if (d.copies && typeof d.copies === "object") {
    for (const [k, v] of Object.entries(d.copies as Record<string, any>)) {
      if (v && typeof v.copyId === "string") copies[k] = { copyId: v.copyId, version: num(v.version) };
    }
  }
  return {
    id,
    teamId: typeof d.teamId === "string" ? d.teamId : "",
    name: text(d.name, 200) || "Untitled Project",
    mcu: d.mcu === "arduino" ? "arduino" : "esp32",
    boardId: text(d.boardId, 64),
    description: text(d.description, 5000),
    code: typeof d.code === "string" ? d.code : "",
    components: Array.isArray(d.components) ? d.components : [],
    connections: Array.isArray(d.connections) ? d.connections : [],
    sharedBy: personOf(d.sharedBy),
    sharedAt: num(d.sharedAt),
    updatedBy: personOf(d.updatedBy),
    updatedAt: num(d.updatedAt),
    version: Math.max(1, num(d.version, 1)),
    editor,
    copies,
    source: d.source && typeof d.source.uid === "string" && typeof d.source.projectId === "string" ? { uid: d.source.uid, projectId: d.source.projectId } : null,
    commentCount: Math.max(0, Math.floor(num(d.commentCount))),
    lastCommentAt: num(d.lastCommentAt),
    lastCommentBy: typeof d.lastCommentBy === "string" ? d.lastCommentBy : null,
  };
}

/** Someone holds it for editing, and their hold hasn't run out. */
const heldNow = (t: TeamProjectRecord, now: number) => !!t.editor && now - t.editor.since < EDIT_HOLD_MS;

/** A team project in the /team page's list. */
export interface TeamProjectRow {
  id: string;
  name: string;
  mcu: "esp32" | "arduino";
  boardId: string;
  sharedBy: string | null;
  sharedAt: number;
  updatedBy: string | null;
  updatedAt: number;
  /** Who is editing it now, if anyone. */
  editing: { by: string | null; since: number; you: boolean } | null;
  /** The person's working copy, while they're the one editing. */
  copyId: string | null;
  canRemove: boolean;
  canFree: boolean;
  /** How many comments it has. */
  comments: number;
  /** Someone else commented since the person last read its comments. */
  newComments: boolean;
}

/**
 * Whom a hold counts for: the person themself, or someone still on the team
 * (`onTeam`). A hold by someone who has left doesn't block anyone, as Edit
 * lets the next person take it over.
 */
function rowOf(t: TeamProjectRecord, me: MemberRecord, now: number, onTeam: Set<string>, seen: Record<string, number>): TeamProjectRow {
  const held = heldNow(t, now) && t.editor && (t.editor.uid === me.uid || onTeam.has(t.editor.uid)) ? t.editor : null;
  const mine = !!held && held.uid === me.uid;
  return {
    id: t.id,
    name: t.name,
    mcu: t.mcu,
    boardId: t.boardId,
    sharedBy: t.sharedBy.email,
    sharedAt: t.sharedAt,
    updatedBy: t.updatedBy.email,
    updatedAt: t.updatedAt,
    editing: held ? { by: held.email, since: held.since, you: mine } : null,
    copyId: mine && held ? held.copyId : null,
    canRemove: me.role === "admin" || t.sharedBy.uid === me.uid,
    canFree: me.role === "admin" && !!held && !mine,
    comments: t.commentCount,
    newComments: t.commentCount > 0 && t.lastCommentBy !== me.uid && t.lastCommentAt > (seen[t.id] ?? 0),
  };
}

/** When the person last read each team project's comments, from their membership record. */
function seenOf(memberSnap: any): Record<string, number> {
  const raw = memberSnap?.exists ? memberSnap.get("commentsSeen") : null;
  const seen: Record<string, number> = {};
  if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw)) if (typeof v === "number" && Number.isFinite(v)) seen[k] = v;
  return seen;
}

async function readTeamProject(get: (ref: any) => Promise<any>, db: Db, id: string, me: MemberRecord): Promise<TeamProjectRecord> {
  const snap = await get(teamProjectRef(db, id));
  const t = snap.exists ? teamProjectOf(id, snap.data()) : null;
  if (!t || t.teamId !== me.teamId) throw new TeamError("That project is no longer shared with your team.", 404, "gone");
  return t;
}

/** Of the people holding these projects for editing, those still on the person's team. */
async function holdersOnTeam(db: Db, records: TeamProjectRecord[], me: MemberRecord, now: number): Promise<Set<string>> {
  const uids = [...new Set(records.filter((t) => heldNow(t, now) && t.editor && t.editor.uid !== me.uid).map((t) => t.editor!.uid))];
  const onTeam = new Set<string>();
  await Promise.all(uids.map(async (uid) => {
    const snap = await memberRef(db, uid).get();
    if (snap.exists && memberOf(uid, snap.data()).teamId === me.teamId) onTeam.add(uid);
  }));
  return onTeam;
}

// Only the fields a list needs: never the code of every shared project.
const ROW_FIELDS = ["teamId", "name", "mcu", "boardId", "sharedBy", "sharedAt", "updatedBy", "updatedAt", "version", "editor", "commentCount", "lastCommentAt", "lastCommentBy"];
const OWN_ROW_FIELDS = ["name", "mcu", "boardId", "updatedAt", "deletedAt"];

// ---- The member's choice: may the team's admins see my projects? ----

export async function setAdminsCanView(db: Db, who: Who, allow: unknown): Promise<boolean> {
  if (typeof allow !== "boolean") throw new TeamError("Choose to allow it or not.");
  return db.runTransaction(async (tx: any) => {
    await membership((r) => tx.get(r), db, who.uid);
    tx.set(memberRef(db, who.uid), { adminsCanView: allow }, { merge: true });
    return allow;
  });
}

// ---- Team projects ----

/** The person's own projects, to choose one to share; each says whether it's shared already. */
export async function projectsToShare(db: Db, who: Who, now: number): Promise<{ id: string; name: string; mcu: string; boardId: string; updatedAt: number | null; shared: boolean }[]> {
  const me = await membership((r) => r.get(), db, who.uid);
  await paidTeam((r) => r.get(), db, me, now);
  const [own, shared] = await Promise.all([
    ownProjects(db, who.uid).select(...OWN_ROW_FIELDS).get(),
    db.collection(TEAM_PROJECTS).where("teamId", "==", me.teamId).select("source").get(),
  ]);
  const sharedIds = new Set(shared.docs.map((d: any) => teamProjectOf(d.id, d.data())).filter((t: TeamProjectRecord) => t.source?.uid === who.uid).map((t: TeamProjectRecord) => t.source!.projectId));
  return own.docs
    .filter((d: any) => !d.get("deletedAt"))
    .map((d: any) => {
      const p = d.data() || {};
      const mcu = p.mcu === "arduino" ? "arduino" : "esp32";
      return { id: d.id, name: text(p.name, 200) || "Untitled Project", mcu, boardId: text(p.boardId, 64), updatedAt: millis(p.updatedAt), shared: sharedIds.has(d.id) };
    })
    .sort((a: any, b: any) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** The owner shares one of their projects: the team gets its own copy. */
export async function shareProject(db: Db, who: Who, rawProjectId: unknown, now: number): Promise<string> {
  const projectId = cleanId(rawProjectId, PROJECT_ID, "project");
  const first = await membership((r) => r.get(), db, who.uid);
  await paidTeam((r) => r.get(), db, first, now);
  // Checked before the transaction, from what each shared project was shared
  // from: a share then holds only the person's own project, never every
  // team project (which would hold up everyone's Edit and Send meanwhile).
  const existing = await db.collection(TEAM_PROJECTS).where("teamId", "==", first.teamId).select("source").get();
  const team = existing.docs.map((d: any) => teamProjectOf(d.id, d.data()));
  if (team.some((t: TeamProjectRecord) => t.source?.uid === who.uid && t.source.projectId === projectId)) {
    throw new TeamError("That project is shared with your team already. To change the team's copy, press Edit on it.", 409);
  }
  if (team.length >= MAX_TEAM_PROJECTS) throw new TeamError(`Your team has ${MAX_TEAM_PROJECTS} shared projects, the most it can have. Remove one first.`, 409);
  const ref = db.collection(TEAM_PROJECTS).doc();
  return db.runTransaction(async (tx: any) => {
    const me = await membership((r) => tx.get(r), db, who.uid);
    if (me.teamId !== first.teamId) throw new TeamError("Your team changed. Refresh the page, then try again.", 409);
    await paidTeam((r) => tx.get(r), db, me, now);
    const own = await tx.get(ownProjectRef(db, who.uid, projectId));
    if (!own.exists || own.get("deletedAt")) throw new TeamError("That project can't be found in your projects.", 404);
    const p = own.data() || {};
    const by = { uid: who.uid, email: who.email };
    tx.set(ref, {
      teamId: me.teamId,
      name: text(p.name, 200) || "Untitled Project",
      ...sharedContent(p),
      sharedBy: by,
      sharedAt: now,
      updatedBy: by,
      updatedAt: now,
      version: 1,
      editor: null,
      copies: {},
      source: { uid: who.uid, projectId },
    });
    return ref.id;
  });
}

/** Everything shared with the person's team, most recently changed first. */
export async function listTeamProjects(db: Db, who: Who, now: number): Promise<TeamProjectRow[]> {
  const mine = await memberRef(db, who.uid).get();
  const me = await membership(async () => mine, db, who.uid);
  await paidTeam((r) => r.get(), db, me, now);
  const snap = await db.collection(TEAM_PROJECTS).where("teamId", "==", me.teamId).select(...ROW_FIELDS).get();
  const records: TeamProjectRecord[] = snap.docs.map((d: any) => teamProjectOf(d.id, d.data()));
  const onTeam = await holdersOnTeam(db, records, me, now);
  const seen = seenOf(mine);
  return records
    .map((t) => rowOf(t, me, now, onTeam, seen))
    .sort((a: TeamProjectRow, b: TeamProjectRow) => b.updatedAt - a.updatedAt);
}

/** A team project to look at (its secrets were hidden when it was shared). */
export async function viewTeamProject(db: Db, who: Who, rawId: unknown, now: number) {
  const id = cleanId(rawId, TEAM_PROJECT_ID, "project");
  const me = await membership((r) => r.get(), db, who.uid);
  await paidTeam((r) => r.get(), db, me, now);
  const t = await readTeamProject((r) => r.get(), db, id, me);
  return {
    name: t.name, description: t.description, mcu: t.mcu, boardId: t.boardId, code: t.code,
    components: t.components.slice(0, 200), connections: t.connections.slice(0, 200), updatedAt: t.updatedAt,
  };
}

/** A new project of the person's own, from a team project: the fields a project always has, no more. */
function newOwnProject(tx: any, db: Db, uid: string, t: TeamProjectRecord, name: string, now: number): string {
  const ref = ownProjects(db, uid).doc();
  const stamp = Timestamp.fromMillis(now);
  tx.set(ref, {
    name: name.slice(0, 200),
    mcu: t.mcu,
    boardId: t.boardId || (t.mcu === "arduino" ? "uno" : "esp32dev"),
    description: t.description,
    code: t.code,
    components: t.components,
    connections: t.connections,
    createdAt: stamp,
    updatedAt: stamp,
  });
  return ref.id;
}

/**
 * Edit: holds the team project for the person and gives them a working copy
 * among their own projects. Their working copy from before is used again if
 * nobody has sent changes since; otherwise they get a fresh one, and the old
 * one stays theirs, untouched.
 */
export async function editTeamProject(db: Db, who: Who, rawId: unknown, now: number): Promise<{ copyId: string; fresh: boolean }> {
  const id = cleanId(rawId, TEAM_PROJECT_ID, "project");
  return db.runTransaction(async (tx: any) => {
    const me = await membership((r) => tx.get(r), db, who.uid);
    await paidTeam((r) => tx.get(r), db, me, now);
    const t = await readTeamProject((r) => tx.get(r), db, id, me);
    if (t.editor && t.editor.uid !== who.uid && heldNow(t, now)) {
      // Held by someone still on the team: it's their turn.
      const theirs = await tx.get(memberRef(db, t.editor.uid));
      if (theirs.exists && memberOf(t.editor.uid, theirs.data()).teamId === me.teamId) {
        throw new TeamError(`${t.editor.email || "Someone on your team"} is editing it now. You can view it, or copy it to your projects.`, 409);
      }
    }
    const earlier = t.copies[who.uid];
    const earlierSnap = earlier && PROJECT_ID.test(earlier.copyId) ? await tx.get(ownProjectRef(db, who.uid, earlier.copyId)) : null;
    const reuse = !!earlier && earlier.version === t.version && !!earlierSnap?.exists && !earlierSnap.get("deletedAt");
    const copyId = reuse && earlier ? earlier.copyId : newOwnProject(tx, db, who.uid, t, `${t.name} (team)`, now);
    tx.set(teamProjectRef(db, id), {
      editor: { uid: who.uid, email: who.email, since: now, copyId },
      copies: { ...t.copies, [who.uid]: { copyId, version: t.version } },
    }, { merge: true });
    // Which team project this working copy is, for teamCopyOf.
    tx.set(memberRef(db, who.uid), { teamCopies: { [copyId]: id } }, { merge: true });
    return { copyId, fresh: !reuse };
  });
}

/** Send: the person's working copy becomes the team's copy, and the project is free again. */
export async function sendTeamProject(db: Db, who: Who, rawId: unknown, now: number): Promise<{ version: number }> {
  const id = cleanId(rawId, TEAM_PROJECT_ID, "project");
  return db.runTransaction(async (tx: any) => {
    const me = await membership((r) => tx.get(r), db, who.uid);
    await paidTeam((r) => tx.get(r), db, me, now);
    const t = await readTeamProject((r) => tx.get(r), db, id, me);
    if (!t.editor || t.editor.uid !== who.uid) {
      throw new TeamError(t.editor && heldNow(t, now)
        ? `${t.editor.email || "Someone on your team"} is editing it now, so your changes can't be sent. Your work is safe in your own projects.`
        : "You aren't editing it now. Press Edit on the Team page first; your work is safe in your own projects.", 409);
    }
    const copyRef = ownProjectRef(db, who.uid, t.editor.copyId);
    const copy = await tx.get(copyRef);
    if (!copy.exists || copy.get("deletedAt")) {
      throw new TeamError("Your copy of it isn't in your projects any more (in Trash, or deleted). Restore it, or press Stop editing.", 409);
    }
    const version = t.version + 1;
    tx.set(teamProjectRef(db, id), {
      ...sharedContent(copy.data() || {}),
      updatedBy: { uid: who.uid, email: who.email },
      updatedAt: now,
      version,
      editor: null,
      // Their working copy matches the team's copy now: Edit uses it again.
      copies: { ...t.copies, [who.uid]: { copyId: t.editor.copyId, version } },
    }, { merge: true });
    return { version };
  });
}

/** Stop editing without sending: the project is free again, unchanged. */
export async function stopEditingTeamProject(db: Db, who: Who, rawId: unknown): Promise<void> {
  const id = cleanId(rawId, TEAM_PROJECT_ID, "project");
  await db.runTransaction(async (tx: any) => {
    const me = await membership((r) => tx.get(r), db, who.uid);
    const t = await readTeamProject((r) => tx.get(r), db, id, me);
    if (!t.editor || t.editor.uid !== who.uid) return;
    tx.set(teamProjectRef(db, id), { editor: null }, { merge: true });
  });
}

/** An admin frees a project someone else is holding (they forgot, or left). */
export async function freeTeamProject(db: Db, who: Who, rawId: unknown): Promise<void> {
  const id = cleanId(rawId, TEAM_PROJECT_ID, "project");
  await db.runTransaction(async (tx: any) => {
    const me = await membership((r) => tx.get(r), db, who.uid);
    if (me.role !== "admin") throw new TeamError("Only the team's admins can do that.", 403, "not_admin");
    await readTeamProject((r) => tx.get(r), db, id, me);
    tx.set(teamProjectRef(db, id), { editor: null }, { merge: true });
  });
}

/** Whoever shared it, or an admin, takes it off the team. Everyone's own copies stay theirs; its comments go with it. */
export async function removeTeamProject(db: Db, who: Who, rawId: unknown): Promise<void> {
  const id = cleanId(rawId, TEAM_PROJECT_ID, "project");
  await db.runTransaction(async (tx: any) => {
    const me = await membership((r) => tx.get(r), db, who.uid);
    const t = await readTeamProject((r) => tx.get(r), db, id, me);
    if (me.role !== "admin" && t.sharedBy.uid !== who.uid) throw new TeamError("Only whoever shared it, or an admin, can remove it.", 403);
    tx.delete(teamProjectRef(db, id));
  });
  // Afterwards, outside the transaction (a transaction can't list them).
  // The project is gone, so nobody can read them meanwhile; one left behind
  // by a failure here can't be reached either.
  try {
    const left = await commentsOf(db, id).get();
    for (let i = 0; i < left.docs.length; i += 50) {
      await Promise.all(left.docs.slice(i, i + 50).map((d: any) => d.ref.delete()));
    }
  } catch (err: any) {
    console.error("[Team projects] Removing a removed project's comments failed:", err?.message || err);
  }
}

/** A copy of a team project for the person to keep, not linked to the team's. */
export async function copyTeamProject(db: Db, who: Who, rawId: unknown, now: number): Promise<string> {
  const id = cleanId(rawId, TEAM_PROJECT_ID, "project");
  return db.runTransaction(async (tx: any) => {
    const me = await membership((r) => tx.get(r), db, who.uid);
    await paidTeam((r) => tx.get(r), db, me, now);
    const t = await readTeamProject((r) => tx.get(r), db, id, me);
    return newOwnProject(tx, db, who.uid, t, `${t.name} (copy)`, now);
  });
}

/** Whether one of the person's projects is their working copy of a team project, for the app's banner. */
export async function teamCopyOf(db: Db, who: Who, rawProjectId: unknown, now: number): Promise<{ teamProjectId: string; teamName: string; name: string; editing: boolean; editingBy: string | null } | null> {
  const projectId = cleanId(rawProjectId, PROJECT_ID, "project");
  const mine = await memberRef(db, who.uid).get();
  const me = mine.exists ? memberOf(who.uid, mine.data()) : null;
  if (!me || !me.teamId) return null;
  // Asked each time the app opens a project: one look in the member's own
  // record, then the one team project, never every team project.
  const index = mine.get("teamCopies");
  const teamProjectId = index && typeof index === "object" ? index[projectId] : null;
  if (typeof teamProjectId !== "string" || !TEAM_PROJECT_ID.test(teamProjectId)) return null;
  const snap = await teamProjectRef(db, teamProjectId).get();
  const t = snap.exists ? teamProjectOf(teamProjectId, snap.data()) : null;
  if (!t || t.teamId !== me.teamId || t.copies[who.uid]?.copyId !== projectId) return null;
  const team = await db.collection(TEAMS).doc(me.teamId).get();
  const onTeam = await holdersOnTeam(db, [t], me, now);
  const held = heldNow(t, now) && t.editor && (t.editor.uid === who.uid || onTeam.has(t.editor.uid)) ? t.editor : null;
  const editing = !!held && held.uid === who.uid && held.copyId === projectId;
  return {
    teamProjectId: t.id,
    teamName: team.exists ? teamOf(me.teamId, team.data()).name : "Your team",
    name: t.name,
    editing,
    editingBy: held && !editing ? held.email : null,
  };
}

// ---- Comments on a team project ----

/** A comment as the person sees it. */
export interface TeamComment {
  id: string;
  by: string | null;
  at: number;
  text: string;
  mine: boolean;
  canDelete: boolean;
}

/**
 * What's kept of what someone typed: line breaks as \n, no control
 * characters or invisible direction marks (which can make text read as
 * something else), no more than one blank line in a row, no space around.
 */
export function commentText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const COMMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A team project's comments, oldest first. Opening them marks them read for the person. */
export async function listComments(db: Db, who: Who, rawId: unknown, now: number): Promise<TeamComment[]> {
  const id = cleanId(rawId, TEAM_PROJECT_ID, "project");
  const me = await membership((r) => r.get(), db, who.uid);
  await paidTeam((r) => r.get(), db, me, now);
  await readTeamProject((r) => r.get(), db, id, me);
  const snap = await commentsOf(db, id).get();
  const comments: TeamComment[] = snap.docs
    .map((d: any) => {
      const c = d.data() || {};
      const author = personOf(c.author);
      return {
        id: d.id,
        by: author.email,
        at: num(c.createdAt),
        text: typeof c.text === "string" ? c.text : "",
        mine: author.uid === who.uid,
        canDelete: author.uid === who.uid || me.role === "admin",
      };
    })
    .filter((c: TeamComment) => c.text)
    .sort((a: TeamComment, b: TeamComment) => a.at - b.at || a.id.localeCompare(b.id));
  // Read now: only the person's own record, and only while they're on the team.
  await db.runTransaction(async (tx: any) => {
    const still = await membership((r) => tx.get(r), db, who.uid);
    if (still.teamId !== me.teamId) return;
    tx.set(memberRef(db, who.uid), { commentsSeen: { [id]: now } }, { merge: true });
  });
  return comments;
}

/** Everyone on the team can comment on a team project while the license is paid. */
export async function postComment(db: Db, who: Who, rawId: unknown, rawText: unknown, now: number): Promise<string> {
  const id = cleanId(rawId, TEAM_PROJECT_ID, "project");
  const body = commentText(rawText);
  if (!body) throw new TeamError("Write a comment first.");
  if (body.length > MAX_COMMENT_LENGTH) throw new TeamError(`A comment can be up to ${MAX_COMMENT_LENGTH} characters. This one is ${body.length}.`);
  const ref = commentsOf(db, id).doc();
  return db.runTransaction(async (tx: any) => {
    const me = await membership((r) => tx.get(r), db, who.uid);
    await paidTeam((r) => tx.get(r), db, me, now);
    const t = await readTeamProject((r) => tx.get(r), db, id, me);
    if (t.commentCount >= MAX_COMMENTS_PER_PROJECT) {
      throw new TeamError(`This project has ${MAX_COMMENTS_PER_PROJECT} comments, the most it can keep. Delete some old ones first.`, 409);
    }
    tx.set(ref, { author: { uid: who.uid, email: who.email }, text: body, createdAt: now });
    tx.set(teamProjectRef(db, id), { commentCount: t.commentCount + 1, lastCommentAt: now, lastCommentBy: who.uid }, { merge: true });
    // Their own comment isn't news to them.
    tx.set(memberRef(db, who.uid), { commentsSeen: { [id]: now } }, { merge: true });
    return ref.id;
  });
}

/**
 * Whoever wrote it, or an admin, deletes a comment: always allowed, paid or
 * not. The count and the latest comment are worked out again from what's
 * left, so a deleted comment never shows as new.
 */
export async function deleteComment(db: Db, who: Who, rawId: unknown, rawCommentId: unknown): Promise<void> {
  const id = cleanId(rawId, TEAM_PROJECT_ID, "project");
  const commentId = cleanId(rawCommentId, COMMENT_ID, "comment");
  await db.runTransaction(async (tx: any) => {
    const me = await membership((r) => tx.get(r), db, who.uid);
    await readTeamProject((r) => tx.get(r), db, id, me);
    const ref = commentsOf(db, id).doc(commentId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new TeamError("That comment isn't there any more.", 404);
    const author = personOf(snap.get("author"));
    if (author.uid !== who.uid && me.role !== "admin") throw new TeamError("Only whoever wrote it, or an admin, can delete it.", 403);
    const all = await tx.get(commentsOf(db, id));
    const rest = all.docs
      .filter((d: any) => d.id !== commentId)
      .map((d: any) => ({ at: num(d.get("createdAt")), by: personOf(d.get("author")).uid || null }))
      .sort((a: { at: number }, b: { at: number }) => b.at - a.at);
    tx.delete(ref);
    tx.set(teamProjectRef(db, id), {
      commentCount: rest.length,
      lastCommentAt: rest[0]?.at ?? 0,
      lastCommentBy: rest[0]?.by ?? null,
    }, { merge: true });
  });
}

// ---- Admins seeing a member's projects, when the member allows it ----

async function consentingMember(db: Db, who: Who, rawUid: unknown, now: number): Promise<MemberRecord> {
  const uid = cleanId(rawUid, UID, "member");
  const me = await membership((r) => r.get(), db, who.uid);
  if (me.role !== "admin") throw new TeamError("Only the team's admins can do that.", 403, "not_admin");
  await paidTeam((r) => r.get(), db, me, now);
  const snap = await memberRef(db, uid).get();
  const them = snap.exists ? memberOf(uid, snap.data()) : null;
  if (!them || them.teamId !== me.teamId) throw new TeamError("That person isn't on your team.", 404);
  if (snap.get("adminsCanView") !== true) throw new TeamError("They haven't chosen to let admins see their projects.", 403);
  return them;
}

export async function memberProjects(db: Db, who: Who, rawUid: unknown, now: number): Promise<{ id: string; name: string; mcu: string; boardId: string; updatedAt: number | null }[]> {
  const them = await consentingMember(db, who, rawUid, now);
  const snap = await ownProjects(db, them.uid).select(...OWN_ROW_FIELDS).get();
  return snap.docs
    .filter((d: any) => !d.get("deletedAt"))
    .map((d: any) => {
      const p = d.data() || {};
      return { id: d.id, name: text(p.name, 200) || "Untitled Project", mcu: p.mcu === "arduino" ? "arduino" : "esp32", boardId: text(p.boardId, 64), updatedAt: millis(p.updatedAt) };
    })
    .sort((a: any, b: any) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export async function memberProject(db: Db, who: Who, rawUid: unknown, rawProjectId: unknown, now: number) {
  const them = await consentingMember(db, who, rawUid, now);
  const projectId = cleanId(rawProjectId, PROJECT_ID, "project");
  const snap = await ownProjectRef(db, them.uid, projectId).get();
  if (!snap.exists || snap.get("deletedAt")) throw new TeamError("That project isn't there any more.", 404);
  return sharedView(snap.data() || {});
}

// ---- Routes ----

// Writes are cheap to try, so each account has a limit an hour.
const tries = new Map<string, { count: number; start: number }>();
function tooMany(key: string, max: number, now: number): boolean {
  const e = tries.get(key);
  if (!e || now - e.start > 60 * 60 * 1000) {
    tries.set(key, { count: 1, start: now });
    if (tries.size > 20000) tries.delete(tries.keys().next().value as string);
    return false;
  }
  e.count += 1;
  return e.count > max;
}

function sendError(res: express.Response, err: unknown, what: string) {
  if (err instanceof TeamError) return res.status(err.status).json({ error: err.message });
  // Firestore keeps a document up to 1 MB.
  if (/exceeds the maximum allowed size/i.test(String((err as any)?.message ?? ""))) {
    return res.status(413).json({ error: "This project is too big to keep as a team project (over 1 MB). Make it smaller, then try again." });
  }
  console.error(`[Team projects] ${what} failed:`, (err as any)?.message || err);
  return res.status(500).json({ error: "Something went wrong. Try again." });
}

const whoOf = (req: express.Request): Who => ({ uid: req.uid!, email: req.email ?? null, emailVerified: req.emailVerified === true });

export function registerTeamProjectRoutes(app: express.Express) {
  const ready = (res: express.Response) => {
    if (isFirebaseAdminConfigured()) return true;
    res.status(503).json({ error: "Accounts aren't configured on the server yet." });
    return false;
  };
  const limited = (req: express.Request, res: express.Response) => {
    if (!tooMany(`teamprojects:${req.uid}`, 300, Date.now())) return false;
    res.status(429).json({ error: "Too many tries. Wait a while, then try again." });
    return true;
  };
  // Reads too: each reads team projects from the database (a list, up to
  // 200), so a script can't run up the bill. The app asks once per project
  // opened; a person stays far below this.
  const readLimited = (req: express.Request, res: express.Response) => {
    if (!tooMany(`teamprojects-read:${req.uid}`, 1200, Date.now())) return false;
    res.status(429).json({ error: "Too many tries. Wait a while, then try again." });
    return true;
  };
  const get = (path: string, what: string, fn: (req: express.Request) => Promise<unknown>) =>
    app.get(path, requireFirebaseAuth, async (req, res) => {
      if (!ready(res) || readLimited(req, res)) return;
      res.setHeader("Cache-Control", "no-store");
      try { res.json(await fn(req)); } catch (err) { sendError(res, err, what); }
    });
  const post = (path: string, what: string, fn: (req: express.Request) => Promise<unknown>) =>
    app.post(path, requireFirebaseAuth, async (req, res) => {
      if (!ready(res) || limited(req, res)) return;
      try { res.json(await fn(req)); } catch (err) { sendError(res, err, what); }
    });

  post("/api/team/consent", "Changing who sees projects", async (req) => ({ adminsCanView: await setAdminsCanView(adminDb, whoOf(req), req.body?.adminsCanView) }));

  get("/api/team/projects", "Listing team projects", async (req) => ({ projects: await listTeamProjects(adminDb, whoOf(req), Date.now()) }));
  get("/api/team/projects-to-share", "Listing projects to share", async (req) => ({ projects: await projectsToShare(adminDb, whoOf(req), Date.now()) }));
  post("/api/team/projects", "Sharing a project", async (req) => ({ id: await shareProject(adminDb, whoOf(req), req.body?.projectId, Date.now()) }));
  get("/api/team/projects/:id", "Opening a team project", async (req) => viewTeamProject(adminDb, whoOf(req), req.params.id, Date.now()));
  post("/api/team/projects/:id/edit", "Editing a team project", async (req) => editTeamProject(adminDb, whoOf(req), req.params.id, Date.now()));
  post("/api/team/projects/:id/send", "Sending changes", async (req) => sendTeamProject(adminDb, whoOf(req), req.params.id, Date.now()));
  post("/api/team/projects/:id/stop", "Stopping editing", async (req) => { await stopEditingTeamProject(adminDb, whoOf(req), req.params.id); return { ok: true }; });
  post("/api/team/projects/:id/free", "Freeing a team project", async (req) => { await freeTeamProject(adminDb, whoOf(req), req.params.id); return { ok: true }; });
  post("/api/team/projects/:id/remove", "Removing a team project", async (req) => { await removeTeamProject(adminDb, whoOf(req), req.params.id); return { ok: true }; });
  post("/api/team/projects/:id/copy", "Copying a team project", async (req) => ({ projectId: await copyTeamProject(adminDb, whoOf(req), req.params.id, Date.now()) }));

  get("/api/team/projects/:id/comments", "Opening the comments", async (req) => ({ comments: await listComments(adminDb, whoOf(req), req.params.id, Date.now()) }));
  post("/api/team/projects/:id/comments", "Posting a comment", async (req) => ({ id: await postComment(adminDb, whoOf(req), req.params.id, req.body?.text, Date.now()) }));
  post("/api/team/projects/:id/comments/:commentId/delete", "Deleting a comment", async (req) => { await deleteComment(adminDb, whoOf(req), req.params.id, req.params.commentId); return { ok: true }; });

  get("/api/team/copy/:projectId", "Checking a working copy", async (req) => ({ copy: await teamCopyOf(adminDb, whoOf(req), req.params.projectId, Date.now()) }));

  get("/api/team/members/:uid/projects", "Listing a member's projects", async (req) => ({ projects: await memberProjects(adminDb, whoOf(req), req.params.uid, Date.now()) }));
  get("/api/team/members/:uid/projects/:projectId", "Opening a member's project", async (req) => memberProject(adminDb, whoOf(req), req.params.uid, req.params.projectId, Date.now()));
}
