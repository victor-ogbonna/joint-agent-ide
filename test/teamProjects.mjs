/**
 * Working together on a team, only by each person's choice
 * (server/teamProjects.ts): sharing a project with the team, one person
 * editing it at a time, sending changes back, secrets never in the team's
 * copy, and admins seeing a member's projects only once the member allows it.
 *
 * Runs against an in-memory stand-in for Firestore with the calls the code
 * uses (documents at any depth, merges, deletes, == queries, transactions).
 */
import { Timestamp } from "firebase-admin/firestore";
import {
  setAdminsCanView, projectsToShare, shareProject, listTeamProjects, viewTeamProject, editTeamProject,
  sendTeamProject, stopEditingTeamProject, freeTeamProject, removeTeamProject, copyTeamProject, teamCopyOf,
  memberProjects, memberProject, EDIT_HOLD_MS, MAX_TEAM_PROJECTS, TEAM_PROJECTS,
  listComments, postComment, deleteComment, commentText, MAX_COMMENT_LENGTH, MAX_COMMENTS_PER_PROJECT,
} from "../server/teamProjects.ts";
import { TeamError, teamPage } from "../server/teams.ts";

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};
const throwsWith = async (fn, re) => {
  try { await fn(); return false; } catch (e) { return e instanceof TeamError && re.test(e.message); }
};

// ---- An in-memory Firestore: documents at any depth ("users/u/projects/p") ----
const split = (key) => { const at = key.lastIndexOf("/"); return [key.slice(0, at), key.slice(at + 1)]; };
class Snap {
  constructor(ref, data) { this.ref = ref; this.id = ref.id; this._d = data; this.exists = data !== undefined; }
  data() { return this._d === undefined ? undefined : { ...this._d }; }
  get(f) { return this._d?.[f]; }
}
class DocRef {
  constructor(db, key) { this.db = db; this.key = key; this.id = split(key)[1]; }
  _snap() { return new Snap(this, this.db.store.get(this.key)); }
  _write(data, opts) {
    const cur = this.db.store.get(this.key);
    // A merge merges maps inside too, as Firestore does.
    const deep = (a, b) => {
      const out = { ...a };
      for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Timestamp) && a?.[k] && typeof a[k] === "object" ? deep(a[k], v) : v;
      return out;
    };
    this.db.store.set(this.key, opts?.merge && cur ? deep(cur, data) : { ...data });
  }
  _delete() { this.db.store.delete(this.key); }
  async get() { return this._snap(); }
  async set(data, opts) { this._write(data, opts); }
  async delete() { this._delete(); }
}
class Query {
  constructor(db, col, filters = []) { this.db = db; this.col = col; this.filters = filters; }
  where(field, op, value) {
    if (op !== "==") throw new Error("only == in the stand-in");
    return new Query(this.db, this.col, [...this.filters, [field, value]]);
  }
  // The fields asked for: the stand-in returns them all, as a superset.
  select() { this.selected = true; this.db.selects = (this.db.selects ?? 0) + 1; return this; }
  _snap() {
    const docs = [];
    for (const [key, d] of this.db.store) {
      if (split(key)[0] !== this.col) continue;
      if (this.filters.every(([f, v]) => d[f] === v)) docs.push(new Snap(new DocRef(this.db, key), d));
    }
    return { docs, empty: docs.length === 0, size: docs.length };
  }
  async get() { return this._snap(); }
}
class Col extends Query {
  doc(id) { return new DocRef(this.db, `${this.col}/${id ?? `auto${++this.db.auto}`}`); }
}
class FakeDb {
  constructor() { this.store = new Map(); this.auto = 0; }
  collection(path) { return new Col(this, path); }
  doc(path) { return new DocRef(this, path); }
  async runTransaction(fn) {
    const writes = [];
    let wrote = false;
    const tx = {
      get: async (r) => { if (wrote) throw new Error("a read after a write in a transaction"); return r._snap(); },
      set: (ref, data, opts) => { wrote = true; writes.push(() => ref._write(data, opts)); },
      delete: (ref) => { wrote = true; writes.push(() => ref._delete()); },
    };
    const result = await fn(tx);
    for (const w of writes) w();
    return result;
  }
}

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const db = new FakeDb();
const put = (path, data) => db.doc(path)._write(data);
const read = (path) => db.store.get(path);
const who = (uid) => ({ uid, email: `${uid}@school.ng`, emailVerified: true });
const [ada, ben, chi, dee, eve] = ["ada", "ben", "chi", "dee", "eve"].map(who);

// Lagos Robotics: Ada (admin), Ben, Chi. Another team: Dee (its admin). Eve: no team.
put("teams/T1", { name: "Lagos Robotics", kind: "school", seats: 5, paidUntil: NOW + 30 * 86400000, joinCode: "ABCD2345", memberCount: 3, createdAt: NOW });
put("teams/T2", { name: "Abuja Makers", kind: "team", seats: 5, paidUntil: NOW + 30 * 86400000, joinCode: "WXYZ6789", memberCount: 1, createdAt: NOW });
put("teamMembers/ada", { teamId: "T1", role: "admin", email: "ada@school.ng", emailVerified: true, joinedAt: NOW - 3 });
put("teamMembers/ben", { teamId: "T1", role: "member", email: "ben@school.ng", emailVerified: true, joinedAt: NOW - 2 });
put("teamMembers/chi", { teamId: "T1", role: "member", email: "chi@school.ng", emailVerified: true, joinedAt: NOW - 1 });
put("teamMembers/dee", { teamId: "T2", role: "admin", email: "dee@school.ng", emailVerified: true, joinedAt: NOW });

const stamp = (ms) => Timestamp.fromMillis(ms);
const BEN_CODE = '#include <WiFi.h>\nconst char* ssid = "BenHome";\nconst char* password = "hunter2secret";\nvoid setup() { WiFi.begin(ssid, password); }\nvoid loop() {}\n';
put("users/ben/projects/p1", {
  name: "Weather station", code: BEN_CODE, description: "Reads the temperature", mcu: "esp32", boardId: "esp32dev",
  components: [{ id: "dht", type: "dht22" }], connections: [{ from: "dht", to: "esp32" }],
  messages: [{ id: "m1", role: "user", content: "my private question", timestamp: 1 }],
  createdAt: stamp(NOW - 5000), updatedAt: stamp(NOW - 1000),
});
put("users/ben/projects/p2", { name: "Old one", code: "void setup(){}", mcu: "arduino", boardId: "uno", components: [], connections: [], deletedAt: stamp(NOW - 100), createdAt: stamp(NOW - 9000), updatedAt: stamp(NOW - 9000) });
put("users/chi/projects/c1", { name: "Chi's blink", code: "void setup(){}", mcu: "arduino", boardId: "uno", components: [], connections: [], createdAt: stamp(NOW), updatedAt: stamp(NOW) });

// The fields a project always has: the Firestore rules that check fields allow these.
const PROJECT_FIELDS = ["name", "code", "description", "components", "connections", "mcu", "boardId", "messages", "createdAt", "updatedAt", "deletedAt"];

console.log("Admins see a member's projects only when the member allows it");
check(await throwsWith(() => memberProjects(db, ada, "ben", NOW), /haven't chosen/), "before Ben chooses: Ada (admin) can't");
check(await throwsWith(() => setAdminsCanView(db, ben, "yes"), /allow it or not/), "the choice is on or off");
check(await throwsWith(() => setAdminsCanView(db, eve, true), /not on a team/), "someone on no team has nothing to allow");
check(await setAdminsCanView(db, ben, true) === true && read("teamMembers/ben").adminsCanView === true && read("teamMembers/ben").teamId === "T1", "Ben allows it (his membership otherwise unchanged)");
const list = await memberProjects(db, ada, "ben", NOW);
check(list.length === 1 && list[0].id === "p1" && list[0].name === "Weather station", "Ada sees his projects (not the one in Trash)");
const seen = await memberProject(db, ada, "ben", "p1", NOW);
check(seen.code.includes("WiFi.begin") && !seen.code.includes("hunter2secret") && !("messages" in seen), "read-only: the code with the password hidden, never the conversation");
check(await throwsWith(() => memberProject(db, ada, "ben", "p2", NOW), /isn't there/), "not a project in Trash");
check(await throwsWith(() => memberProjects(db, chi, "ben", NOW), /Only the team's admins/), "Chi (not an admin) can't");
check(await throwsWith(() => memberProjects(db, dee, "ben", NOW), /isn't on your team/), "another team's admin can't");
await setAdminsCanView(db, ben, false);
check(await throwsWith(() => memberProject(db, ada, "ben", "p1", NOW), /haven't chosen/), "Ben turns it off: Ada can't any more");
const pageBen = await teamPage(db, ben, NOW);
const pageAda = await teamPage(db, ada, NOW);
check(pageBen.team?.adminsCanView === false && pageAda.team?.members.find((m) => m.uid === "ben")?.adminsCanView === false, "the /team page shows each person's choice (to them, and to admins)");

console.log("Sharing a project with the team: the owner's choice, project by project");
check((await projectsToShare(db, ben, NOW)).map((p) => `${p.id}:${p.shared}`).join() === "p1:false", "Ben's projects to share (not the one in Trash)");
check(await throwsWith(() => shareProject(db, ben, "p2", NOW), /can't be found/), "not one in Trash");
check(await throwsWith(() => shareProject(db, ben, "c1", NOW), /can't be found/), "not someone else's");
check(await throwsWith(() => shareProject(db, eve, "x1", NOW), /not on a team/), "not without a team");
check(await throwsWith(() => shareProject(db, ben, "../c1", NOW), /No such project/), "a bad project id is refused");
const tp = await shareProject(db, ben, "p1", NOW);
const copy0 = read(`${TEAM_PROJECTS}/${tp}`);
check(copy0.teamId === "T1" && copy0.version === 1 && copy0.name === "Weather station" && copy0.code.includes("WiFi.begin") && !copy0.code.includes("hunter2secret") && !("messages" in copy0),
  "the team gets its own copy: the password hidden, no conversation");
check(read("users/ben/projects/p1").code === BEN_CODE, "Ben's own project is unchanged");
check((await projectsToShare(db, ben, NOW))[0].shared === true, "and is marked shared");
check(await throwsWith(() => shareProject(db, ben, "p1", NOW), /already/), "the same project isn't shared twice");

console.log("Everyone on the team sees it; nobody else does");
const rowChi = (await listTeamProjects(db, chi, NOW))[0];
check(rowChi?.id === tp && rowChi.sharedBy === "ben@school.ng" && rowChi.editing === null && !rowChi.canRemove && !rowChi.canFree, "Chi sees it, free to edit; she can't remove it");
const rowAda = (await listTeamProjects(db, ada, NOW))[0];
check(rowAda.canRemove && !rowAda.canFree, "Ada (admin) can remove it");
check((await listTeamProjects(db, dee, NOW)).length === 0 && await throwsWith(() => viewTeamProject(db, dee, tp, NOW), /no longer shared with your team/), "another team sees nothing of it");
const view = await viewTeamProject(db, chi, tp, NOW);
check(view.name === "Weather station" && !view.code.includes("hunter2secret") && view.components.length === 1, "Chi can look at it");

console.log("One person edits at a time");
const e1 = await editTeamProject(db, chi, tp, NOW);
const chiCopy = read(`users/chi/projects/${e1.copyId}`);
check(e1.fresh && chiCopy?.name === "Weather station (team)" && chiCopy.code === copy0.code && chiCopy.createdAt instanceof Timestamp,
  "Chi presses Edit: a working copy among her own projects");
check(Object.keys(chiCopy).every((k) => PROJECT_FIELDS.includes(k)), "with only the fields a project always has", Object.keys(chiCopy).join(","));
const chiRow = (await listTeamProjects(db, chi, NOW))[0];
const benRow = (await listTeamProjects(db, ben, NOW))[0];
check(chiRow.editing?.you === true && chiRow.copyId === e1.copyId && benRow.editing?.by === "chi@school.ng" && benRow.editing.you === false && benRow.copyId === null,
  "she's shown as editing it, to herself and to Ben");
check(await throwsWith(() => editTeamProject(db, ben, tp, NOW + 1000), /chi@school.ng is editing it now/), "Ben can't edit it while she is");
check(await throwsWith(() => sendTeamProject(db, ben, tp, NOW + 1000), /is editing it now/), "nor send changes");
const info = await teamCopyOf(db, chi, e1.copyId, NOW);
check(info?.teamProjectId === tp && info.teamName === "Lagos Robotics" && info.name === "Weather station" && info.editing === true, "the app knows her project is her working copy of it");
check(await teamCopyOf(db, chi, "c1", NOW) === null, "and that her other projects aren't");

console.log("Sending changes");
db.doc(`users/chi/projects/${e1.copyId}`)._write({ code: 'const char* password = "chi-wifi-pass";\n// faster readings\n', updatedAt: stamp(NOW + 2000) }, { merge: true });
const sent = await sendTeamProject(db, chi, tp, NOW + 3000);
const copy1 = read(`${TEAM_PROJECTS}/${tp}`);
check(sent.version === 2 && copy1.version === 2 && copy1.code.includes("faster readings") && !copy1.code.includes("chi-wifi-pass") && copy1.updatedBy.uid === "chi" && copy1.editor === null,
  "Chi sends: her version is the team's (her password hidden), and it's free again");
check(read(`users/chi/projects/${e1.copyId}`).code.includes("chi-wifi-pass"), "her own working copy keeps her password");
check(await throwsWith(() => sendTeamProject(db, chi, tp, NOW + 4000), /aren't editing it now/), "sending again needs Edit first");
const e2 = await editTeamProject(db, chi, tp, NOW + 5000);
check(!e2.fresh && e2.copyId === e1.copyId && read(`users/chi/projects/${e1.copyId}`).code.includes("chi-wifi-pass"), "Edit again: her same working copy, untouched (nobody changed the team's since)");
await stopEditingTeamProject(db, chi, tp);
check(read(`${TEAM_PROJECTS}/${tp}`).editor === null && read(`${TEAM_PROJECTS}/${tp}`).version === 2, "Stop editing: free again, unchanged");

console.log("Turns, and who can end them");
const e3 = await editTeamProject(db, ben, tp, NOW + 6000);
check(e3.fresh && e3.copyId !== "p1" && read(`users/ben/projects/${e3.copyId}`).name === "Weather station (team)", "Ben's turn: a working copy of his own (his original stays as it was)");
const e4 = await editTeamProject(db, chi, tp, NOW + 6000 + EDIT_HOLD_MS + 1);
check(!e4.fresh && e4.copyId === e1.copyId && read(`${TEAM_PROJECTS}/${tp}`).editor.uid === "chi", "a turn ends by itself after a day: Chi can take it then (her working copy again: Ben sent nothing)");
check(await throwsWith(() => sendTeamProject(db, ben, tp, NOW + 6000 + EDIT_HOLD_MS + 2), /chi@school.ng is editing it now/), "and Ben's late send is refused, his work safe in his own projects");
check(await throwsWith(() => freeTeamProject(db, ben, tp), /Only the team's admins/), "only an admin can end someone else's turn");
await freeTeamProject(db, ada, tp);
check(read(`${TEAM_PROJECTS}/${tp}`).editor === null, "Ada (admin) ends Chi's turn");
await editTeamProject(db, chi, tp, NOW + 7000 + EDIT_HOLD_MS);
check((await listTeamProjects(db, ben, NOW + 7001 + EDIT_HOLD_MS))[0].editing?.by === "chi@school.ng", "while Chi is on the team, Ben sees her editing it");
db.store.delete("teamMembers/chi");
const afterLeaving = (await listTeamProjects(db, ben, NOW + 7001 + EDIT_HOLD_MS))[0];
check(afterLeaving.editing === null, "once she has left, it shows as free to edit (Edit isn't held back)");
check((await editTeamProject(db, ben, tp, NOW + 7001 + EDIT_HOLD_MS)).copyId.length > 0, "someone who left the team doesn't keep a turn");
db.doc("teamMembers/chi")._write({ teamId: "T1", role: "member", email: "chi@school.ng", emailVerified: true, joinedAt: NOW });
const benCopyId = read(`${TEAM_PROJECTS}/${tp}`).editor.copyId;
db.doc(`users/ben/projects/${benCopyId}`)._write({ deletedAt: stamp(NOW) }, { merge: true });
check(await throwsWith(() => sendTeamProject(db, ben, tp, NOW + 8000 + EDIT_HOLD_MS), /isn't in your projects any more/), "a working copy moved to Trash can't be sent");
await stopEditingTeamProject(db, ben, tp);

console.log("Only while the license is paid, or in its grace days");
const DAY = 86400000;
const license = (paidUntil, paidFor) => db.doc("teams/T1")._write({ paidUntil, paidFor }, { merge: true });
const paidT1 = read("teams/T1").paidUntil;
license(NOW - DAY, "month");
check((await listTeamProjects(db, chi, NOW)).some((r) => r.id === tp), "a month's license, 1 day after it ended (2 grace days): still works");
license(NOW - 20 * DAY, "year");
check((await listTeamProjects(db, chi, NOW)).some((r) => r.id === tp), "a year's license, 20 days after it ended (30 grace days): still works");
license(NOW - DAY, "month");
const e5 = await editTeamProject(db, chi, tp, NOW);
license(NOW - 3 * DAY, "month");
const ENDED_MEMBER = /Your team's license has ended\. Team projects come back once an admin renews it\. Your own projects are kept\./;
const ENDED_ADMIN = /The license has ended\. Renew it on the Team page/;
check(await throwsWith(() => listTeamProjects(db, chi, NOW), ENDED_MEMBER), "past the grace days: a member is told to ask an admin to renew");
check(await throwsWith(() => listTeamProjects(db, ada, NOW), ENDED_ADMIN), "and an admin, to renew it on the Team page");
check(await throwsWith(() => sendTeamProject(db, chi, tp, NOW), ENDED_MEMBER), "changes can't be sent (Chi's work stays in her own projects)");
check(read(`users/chi/projects/${e5.copyId}`) !== undefined, "her working copy is still hers");
let allLocked = true;
for (const [what, fn] of [
  ["view", () => viewTeamProject(db, chi, tp, NOW)],
  ["edit", () => editTeamProject(db, ben, tp, NOW)],
  ["copy", () => copyTeamProject(db, chi, tp, NOW)],
  ["projects to share", () => projectsToShare(db, ben, NOW)],
  ["share", () => shareProject(db, chi, "c1", NOW)],
]) if (!(await throwsWith(fn, /license has ended/))) { allLocked = false; console.log(`    not locked: ${what}`); }
check(allLocked, "view, edit, copy and share are all locked");
await setAdminsCanView(db, ben, true);
check(read("teamMembers/ben").adminsCanView === true, "each member's own choice still works");
check(await throwsWith(() => memberProjects(db, ada, "ben", NOW), ENDED_ADMIN) && await throwsWith(() => memberProject(db, ada, "ben", "p1", NOW), ENDED_ADMIN), "admins can't see members' projects either");
await setAdminsCanView(db, ben, false);
check((await teamCopyOf(db, chi, e5.copyId, NOW))?.editing === true, "the app still knows Chi's working copy (to show why it can't be sent)");
await stopEditingTeamProject(db, chi, tp);
check(read(`${TEAM_PROJECTS}/${tp}`).editor === null, "Stop editing still works, so nobody is stuck holding it");
license(null, null);
const UNPAID_MEMBER = /Team projects start once your team's license is paid\. Ask an admin to pay for it\./;
check(await throwsWith(() => listTeamProjects(db, chi, NOW), UNPAID_MEMBER) && await throwsWith(() => shareProject(db, chi, "c1", NOW), UNPAID_MEMBER), "never paid: a member is told to ask an admin to pay");
check(await throwsWith(() => listTeamProjects(db, ada, NOW), /Team projects start once the license is paid\. Pay for it on the Team page\./), "and an admin, to pay on the Team page");
try { await listTeamProjects(db, chi, NOW); } catch (e) { check(e.status === 402 && e.reason === "unpaid", "refused as unpaid (402)"); }
license(paidT1, null);
check((await listTeamProjects(db, chi, NOW)).some((r) => r.id === tp), "paid again: everything is back");

console.log("Too big, and reading only what's needed");
put("users/chi/projects/huge", { name: "Huge", code: "x".repeat(500_001), mcu: "arduino", boardId: "uno", components: [], connections: [], createdAt: stamp(NOW), updatedAt: stamp(NOW) });
try { await shareProject(db, chi, "huge", NOW); check(false, "code over 500,000 characters is refused, never cut short"); }
catch (e) { check(e instanceof TeamError && e.status === 413 && /too long to share/.test(e.message), "code over 500,000 characters is refused, never cut short"); }
check(db.selects > 0, "lists ask for the row fields only (not every project's code)");
check(read("teamMembers/chi")?.teamCopies?.[e1.copyId] === tp, "Edit records which team project a working copy is, so opening a project reads one document");

console.log("Comments on a team project");
{
  const row = async (w, at = NOW) => (await listTeamProjects(db, w, at)).find((r) => r.id === tp);
  check((await row(chi)).comments === 0 && (await row(chi)).newComments === false, "none yet: nothing new");
  const c1 = await postComment(db, ada, tp, "  Check the resistor\r\n\r\n\r\n\r\non pin 4.  ", NOW + 10);
  const stored = read(`${TEAM_PROJECTS}/${tp}/comments/${c1}`);
  check(stored?.text === "Check the resistor\n\non pin 4." && stored.author?.uid === "ada" && stored.author?.email === "ada@school.ng" && stored.createdAt === NOW + 10,
    "Ada (the teacher) comments: kept tidy (spaces trimmed, one blank line at most), with who and when", JSON.stringify(stored?.text));
  check(read(`${TEAM_PROJECTS}/${tp}`).commentCount === 1 && read(`${TEAM_PROJECTS}/${tp}`).lastCommentBy === "ada", "the project counts it");
  const benRow = await row(ben);
  check(benRow.comments === 1 && benRow.newComments === true, "Ben sees 1 comment, marked new");
  check((await row(ada)).newComments === false, "her own comment isn't new to Ada");
  const seenByBen = await listComments(db, ben, tp, NOW + 20);
  check(seenByBen.length === 1 && seenByBen[0].by === "ada@school.ng" && seenByBen[0].text === "Check the resistor\n\non pin 4." && seenByBen[0].mine === false && seenByBen[0].canDelete === false,
    "Ben reads it: who wrote it, the text; he can't delete the teacher's comment");
  check((await row(ben, NOW + 21)).newComments === false && (await row(chi)).newComments === true, "read: not new for Ben any more, still new for Chi");
  const c2 = await postComment(db, ben, tp, "Moved it to pin 5, works now!", NOW + 30);
  check((await row(ada, NOW + 31)).newComments === true && (await row(ben, NOW + 31)).newComments === false, "Ben replies: new for Ada, not for him");
  const asAda = await listComments(db, ada, tp, NOW + 40);
  check(asAda.map((c) => c.id).join() === `${c1},${c2}` && asAda.every((c) => c.canDelete) && asAda[0].mine && !asAda[1].mine, "oldest first; Ada (admin) may delete any comment");
  check(commentText("a\u202Eevil\u0007b\u200F") === "aevilb" && commentText(42) === "", "invisible direction marks and control characters are dropped");
  check(await throwsWith(() => postComment(db, chi, tp, "   \n\n  ", NOW), /Write a comment first/), "an empty comment is refused");
  check(await throwsWith(() => postComment(db, chi, tp, "x".repeat(MAX_COMMENT_LENGTH + 1), NOW), /up to 1000 characters\. This one is 1001/), `over ${MAX_COMMENT_LENGTH} characters is refused, never cut short`);
  check((await postComment(db, chi, tp, "y".repeat(MAX_COMMENT_LENGTH), NOW + 50)).length > 0, `exactly ${MAX_COMMENT_LENGTH} is fine`);
  check(await throwsWith(() => listComments(db, dee, tp, NOW), /no longer shared with your team/) && await throwsWith(() => postComment(db, dee, tp, "hi", NOW), /no longer shared with your team/), "another team can't read or comment");
  check(await throwsWith(() => listComments(db, eve, tp, NOW), /not on a team/), "nor can someone on no team");
  check(await throwsWith(() => deleteComment(db, chi, tp, c1), /Only whoever wrote it, or an admin/), "Chi can't delete Ada's comment");
  check(await throwsWith(() => deleteComment(db, ben, tp, "../x"), /No such comment/), "a made-up comment id is refused");
  await deleteComment(db, ben, tp, c2);
  check(read(`${TEAM_PROJECTS}/${tp}/comments/${c2}`) === undefined && read(`${TEAM_PROJECTS}/${tp}`).commentCount === 2, "Ben deletes his own; the count follows");
  check(await throwsWith(() => deleteComment(db, ben, tp, c2), /isn't there any more/), "deleting it twice: said plainly");
  const c3 = await postComment(db, ben, tp, "oops, wrong project", NOW + 60);
  check((await row(chi, NOW + 61)).newComments === true, "Ben posts again: new for Chi");
  await deleteComment(db, ben, tp, c3);
  const afterOops = read(`${TEAM_PROJECTS}/${tp}`);
  check((await row(chi, NOW + 62)).newComments === false && afterOops.commentCount === 2 && afterOops.lastCommentAt === NOW + 50 && afterOops.lastCommentBy === "chi",
    "he deletes it at once: it never shows as new; the latest is Chi's own again", JSON.stringify([afterOops.commentCount, afterOops.lastCommentAt, afterOops.lastCommentBy]));
  license(null, null);
  check(await throwsWith(() => listComments(db, chi, tp, NOW), UNPAID_MEMBER) && await throwsWith(() => postComment(db, chi, tp, "hi", NOW), UNPAID_MEMBER), "unpaid: comments can't be read or written");
  await deleteComment(db, ada, tp, c1);
  check(read(`${TEAM_PROJECTS}/${tp}/comments/${c1}`) === undefined, "but deleting one always works");
  license(paidT1, null);
  db.doc(`${TEAM_PROJECTS}/${tp}`)._write({ commentCount: MAX_COMMENTS_PER_PROJECT }, { merge: true });
  check(await throwsWith(() => postComment(db, chi, tp, "one more", NOW), /the most it can keep/), `at most ${MAX_COMMENTS_PER_PROJECT} comments a project`);
  db.doc(`${TEAM_PROJECTS}/${tp}`)._write({ commentCount: 1 }, { merge: true });
  const p = read(`${TEAM_PROJECTS}/${tp}`);
  check(typeof p.code === "string" && p.version >= 1 && p.updatedBy, "commenting leaves the project itself as it was");
}

console.log("Copies, removing, and the limit");
const mine = await copyTeamProject(db, chi, tp, NOW);
check(read(`users/chi/projects/${mine}`).name === "Weather station (copy)" && await teamCopyOf(db, chi, mine, NOW) === null, "Copy to my projects: Chi's to keep, not linked to the team's");
check(await throwsWith(() => removeTeamProject(db, chi, tp), /Only whoever shared it/), "Chi can't remove it");
await removeTeamProject(db, ben, tp);
check(read(`${TEAM_PROJECTS}/${tp}`) === undefined && read(`users/chi/projects/${e1.copyId}`) !== undefined, "Ben (who shared it) removes it; everyone's own copies stay theirs");
check(![...db.store.keys()].some((k) => k.startsWith(`${TEAM_PROJECTS}/${tp}/comments/`)), "its comments go with it");
check(await throwsWith(() => editTeamProject(db, chi, tp, NOW), /no longer shared/), "it can't be edited after that");
for (let i = 0; i < MAX_TEAM_PROJECTS; i++) put(`${TEAM_PROJECTS}/fill${i}`, { teamId: "T1", name: `P${i}`, version: 1, sharedBy: { uid: "ada" }, updatedBy: { uid: "ada" } });
check(await throwsWith(() => shareProject(db, ben, "p1", NOW), /the most it can have/), `at most ${MAX_TEAM_PROJECTS} shared projects a team`);

console.log(bad ? `\n${bad} team project check(s) failed.` : "\nAll team project checks passed.");
process.exit(bad ? 1 : 0);
