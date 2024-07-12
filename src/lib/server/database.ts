import { type InferOutput, array, bigint, nullable, object, parse, pick } from 'valibot';
import { type Loggable, timed } from '$lib/decorators';
import { fail, strictEqual } from 'node:assert/strict';
import type { Logger } from 'pino';
import postgres from 'postgres';

import { FacultyChoice, FacultyChoiceEmail } from '$lib/models/faculty-choice';
import { Pending, Session } from '$lib/server/models/session';
import { Draft } from '$lib/models/draft';
import { Lab } from '$lib/models/lab';
import { StudentRank } from '$lib/models/student-rank';
import { User } from '$lib/models/user';

const AvailableLabs = array(pick(Lab, ['lab_id', 'lab_name']));
const CountResult = object({ count: bigint() });
const CreatedLab = pick(Lab, ['lab_id']);
const CreatedDraft = pick(Draft, ['draft_id', 'active_period_start']);
const DeletedPendingSession = pick(Pending, ['nonce', 'expiration']);
const DeletedValidSession = pick(Session, ['email', 'expiration']);
const DraftMaxRounds = pick(Draft, ['max_rounds']);
const IncrementedDraftRound = pick(Draft, ['curr_round', 'max_rounds']);
const LabQuota = pick(Lab, ['quota']);
const LatestDraft = pick(Draft, ['draft_id', 'curr_round', 'max_rounds', 'active_period_start']);
const QueriedDraft = pick(Draft, ['curr_round', 'max_rounds', 'active_period_start', 'active_period_end']);
const QueriedFaculty = array(
    object({
        ...pick(User, ['email', 'given_name', 'family_name', 'avatar', 'user_id']).entries,
        lab_name: nullable(Lab.entries.lab_name),
    }),
);
const QueriedLab = pick(Lab, ['lab_name', 'quota']);
const QueriedStudentRank = object({
    ...pick(StudentRank, ['created_at']).entries,
    labs: array(Lab.entries.lab_name),
});
const RegisteredLabs = array(Lab);
const StudentsWithLabPreference = array(pick(User, ['email', 'given_name', 'family_name', 'avatar', 'student_number']));
const TaggedStudentsWithLabs = array(
    object({
        ...pick(User, ['email', 'given_name', 'family_name', 'avatar', 'student_number']).entries,
        ...pick(StudentRank, ['labs']).entries,
        lab_id: nullable(FacultyChoiceEmail.entries.lab_id),
    }),
);
const UserEmails = array(pick(User, ['email']));

export type AvailableLabs = InferOutput<typeof AvailableLabs>;
export type QueriedFaculty = InferOutput<typeof QueriedFaculty>;
export type TaggedStudentsWithLabs = InferOutput<typeof TaggedStudentsWithLabs>;

export type Sql = postgres.Sql<{ bigint: bigint; }>;

export class Database implements Loggable {
    #sql: Sql;
    #logger: Logger;

    constructor(sql: Sql, logger: Logger) {
        this.#sql = sql;
        this.#logger = logger;
    }

    get logger() {
        return this.#logger;
    }

    /** Begins a transaction. */
    begin<T>(fn: (db: Database) => Promise<T>) {
        return this.#sql.begin('ISOLATION LEVEL REPEATABLE READ', sql => fn(new Database(sql, this.#logger)));
    }

    @timed async generatePendingSession() {
        const sql = this.#sql;
        const [first, ...rest] =
            await sql`INSERT INTO drap.pendings DEFAULT VALUES RETURNING session_id, expiration, nonce`;
        strictEqual(rest.length, 0);
        return parse(Pending, first);
    }

    @timed async deletePendingSession(sid: Pending['session_id']) {
        const sql = this.#sql;
        const [first, ...rest] =
            await sql`DELETE FROM drap.pendings WHERE session_id = ${sid} RETURNING expiration, nonce`;
        strictEqual(rest.length, 0);
        return typeof first === 'undefined' ? null : parse(DeletedPendingSession, first);
    }

    @timed async insertValidSession(
        sid: Pending['session_id'],
        email: Session['email'],
        expiration: Session['expiration'],
    ) {
        const sql = this.#sql;
        const { count } =
            await sql`INSERT INTO drap.sessions (session_id, email, expiration) VALUES (${sid}, ${email}, ${expiration})`;
        return count;
    }

    @timed async getUserFromValidSession(sid: Session['session_id']) {
        const sql = this.#sql;
        const [first, ...rest] =
            await sql`SELECT u.* FROM drap.sessions JOIN drap.users u USING (email) WHERE session_id = ${sid}`;
        strictEqual(rest.length, 0);
        return typeof first === 'undefined' ? null : parse(User, first);
    }

    @timed async deleteValidSession(sid: Session['session_id']) {
        const sql = this.#sql;
        const [first, ...rest] =
            await sql`DELETE FROM drap.sessions WHERE session_id = ${sid} RETURNING email, expiration`;
        strictEqual(rest.length, 0);
        return typeof first === 'undefined' ? null : parse(DeletedValidSession, first);
    }

    @timed async initUser(email: User['email']) {
        const sql = this.#sql;
        const { count } =
            await sql`INSERT INTO drap.users (email) VALUES (${email}) ON CONFLICT ON CONSTRAINT users_pkey DO NOTHING RETURNING student_number, lab_id`;
        return count;
    }

    @timed async upsertOpenIdUser(
        email: User['email'],
        uid: NonNullable<User['user_id']>,
        given: User['given_name'],
        family: User['family_name'],
        avatar: User['avatar'],
    ) {
        const sql = this.#sql;
        const { count } =
            await sql`INSERT INTO drap.users AS u (email, user_id, given_name, family_name, avatar) VALUES (${email}, ${uid}, ${given}, ${family}, ${avatar}) ON CONFLICT ON CONSTRAINT users_pkey DO UPDATE SET user_id = EXCLUDED.user_id, given_name = coalesce(nullif(trim(u.given_name), ''), EXCLUDED.given_name), family_name = coalesce(nullif(trim(u.family_name), ''), EXCLUDED.family_name), avatar = EXCLUDED.avatar`;
        return count;
    }

    @timed async updateProfileBySession(
        sid: Session['session_id'],
        studentNumber: User['student_number'],
        given: User['given_name'],
        family: User['family_name'],
    ) {
        const sql = this.#sql;
        const { count } =
            await sql`UPDATE drap.users AS u SET student_number = coalesce(u.student_number, ${studentNumber}), given_name = ${given}, family_name = ${family} FROM drap.sessions s WHERE session_id = ${sid} AND s.email = u.email`;
        return count;
    }

    @timed async insertNewLab(id: Lab['lab_id'], name: Lab['lab_name']) {
        const sql = this.#sql;
        const [first, ...rest] =
            await sql`INSERT INTO drap.labs (lab_id, lab_name) VALUES (${id}, ${name}) RETURNING lab_id`;
        strictEqual(rest.length, 0);
        return parse(CreatedLab, first).lab_id;
    }

    @timed async getAvailableLabs() {
        const sql = this.#sql;
        const labs = await sql`SELECT lab_id, lab_name FROM drap.labs WHERE quota > 0 ORDER BY lab_name`;
        return parse(AvailableLabs, labs);
    }

    @timed async getLabRegistry() {
        const sql = this.#sql;
        const labs = await sql`SELECT lab_id, lab_name, quota FROM drap.labs ORDER BY lab_name`;
        return parse(RegisteredLabs, labs);
    }

    @timed async getLabCountAndStudentCount(draft: Draft['draft_id']) {
        const [[labCount, ...labRest], [studentCount, ...studentRest]] = await this.#sql.begin(
            sql =>
                [
                    sql`SELECT count(lab_id) FROM drap.labs`,
                    sql`SELECT count(email) FROM drap.student_ranks WHERE draft_id = ${draft}`,
                ] as const,
        );
        strictEqual(labRest.length, 0);
        strictEqual(studentRest.length, 0);
        return { labCount: parse(CountResult, labCount).count, studentCount: parse(CountResult, studentCount).count };
    }

    @timed async updateLabQuotas(quota: Iterable<readonly [Lab['lab_id'], Lab['quota']]>) {
        const sql = this.#sql;
        const values = sql(Array.from(quota));
        const { count } =
            await sql`UPDATE drap.labs l SET quota = d.quota::SMALLINT FROM (VALUES ${values}) d (lab_id, quota) WHERE l.lab_id = d.lab_id`;
        return count;
    }

    @timed async getFacultyAndStaff() {
        const sql = this.#sql;
        const users =
            await sql`SELECT email, given_name, family_name, avatar, user_id, lab_name FROM drap.users LEFT JOIN drap.labs USING (lab_id) WHERE is_admin`;
        return parse(QueriedFaculty, users);
    }

    @timed async getDraftById(id: Draft['draft_id']) {
        const sql = this.#sql;
        const [first, ...rest] =
            await sql`SELECT curr_round, max_rounds, lower(active_period) active_period_start, CASE WHEN upper_inf(active_period) THEN NULL ELSE upper(active_period) END active_period_end FROM drap.drafts WHERE draft_id = ${id}`;
        strictEqual(rest.length, 0);
        return typeof first === 'undefined' ? null : parse(QueriedDraft, first);
    }

    @timed async getActiveDraft() {
        const sql = this.#sql;
        const [first, ...rest] =
            await sql`SELECT draft_id, curr_round, max_rounds, lower(active_period) active_period_start, CASE WHEN upper_inf(active_period) THEN NULL ELSE upper(active_period) END active_period_end FROM drap.drafts WHERE upper_inf(active_period)`;
        strictEqual(rest.length, 0);
        return typeof first === 'undefined' ? null : parse(LatestDraft, first);
    }

    @timed async getMaxRoundInDraft(draft: Draft['draft_id']) {
        const sql = this.#sql;
        const [first, ...rest] = await sql`SELECT max_rounds FROM drap.drafts WHERE draft_id = ${draft}`;
        strictEqual(rest.length, 0);
        return typeof first === 'undefined' ? null : parse(DraftMaxRounds, first).max_rounds;
    }

    @timed async getStudentsInDraftTaggedByLab(draft: Draft['draft_id']) {
        const sql = this.#sql;
        const students =
            await sql`SELECT email, given_name, family_name, avatar, student_number, labs, fce.lab_id FROM drap.student_ranks sr JOIN drap.users u USING (email) LEFT JOIN drap.faculty_choices_emails fce ON u.email = student_email WHERE sr.draft_id = ${draft}`;
        return parse(TaggedStudentsWithLabs, students);
    }

    @timed async getLabAndRemainingStudentsInDraftWithLabPreference(
        draft: Draft['draft_id'],
        lab: StudentRank['labs'][number],
    ) {
        const [[first, ...rest], available, selected] = await this.#sql.begin(
            'ISOLATION LEVEL REPEATABLE READ',
            sql =>
                [
                    sql`SELECT lab_name, quota FROM drap.labs WHERE lab_id = ${lab}`,
                    sql`SELECT email, given_name, family_name, avatar, student_number FROM drap.student_ranks LEFT JOIN drap.faculty_choices_emails USING (draft_id) JOIN drap.drafts USING (draft_id) JOIN drap.users USING (email) WHERE draft_id = ${draft} AND student_email IS NULL AND labs[curr_round] = ${lab}`,
                    sql`SELECT email, given_name, family_name, avatar, student_number FROM drap.faculty_choices_emails fce JOIN drap.users ON student_email = email WHERE draft_id = ${draft} AND fce.lab_id = ${lab}`,
                ] as const,
        );
        strictEqual(rest.length, 0);
        return {
            lab: typeof first === 'undefined' ? null : parse(QueriedLab, first),
            students: parse(StudentsWithLabPreference, available),
            researchers: parse(StudentsWithLabPreference, selected),
        };
    }

    @timed async autoAcknowledgeLabsWithoutPreferences(draft: Draft['draft_id']) {
        // TODO: Auto-acknowledge labs without quota left as well.
        const sql = this.#sql;
        const { count } =
            await sql`INSERT INTO drap.faculty_choices (draft_id, round, lab_id) WITH d AS (SELECT draft_id, curr_round FROM drap.drafts WHERE draft_id = ${draft}) SELECT draft_id, curr_round, lab_id FROM d, (SELECT lab_id FROM drap.labs EXCEPT SELECT labs[curr_round] lab_id FROM d JOIN drap.student_ranks USING (draft_id) LEFT JOIN drap.faculty_choices_emails fce ON email = student_email WHERE student_email IS NULL) _;`;
        return count;
    }

    @timed async getLabQuotaAndSelectedStudentCountInDraft(draft: Draft['draft_id'], lab: StudentRank['labs'][number]) {
        const [[quota, ...quotaRest], [selected, ...selectedRest]] = await this.#sql.begin(
            'ISOLATION LEVEL REPEATABLE READ',
            sql =>
                [
                    sql`SELECT quota FROM drap.labs WHERE lab_id = ${lab}`,
                    sql`SELECT count(student_email) FROM drap.faculty_choices_emails fce WHERE draft_id = ${draft} AND fce.lab_id = ${lab}`,
                ] as const,
        );
        strictEqual(quotaRest.length, 0);
        strictEqual(selectedRest.length, 0);
        return {
            quota: typeof quota === 'undefined' ? null : parse(LabQuota, quota).quota,
            selected: parse(CountResult, selected).count,
        };
    }

    @timed async initDraft(rounds: Draft['max_rounds']) {
        const sql = this.#sql;
        const [first, ...rest] =
            await sql`INSERT INTO drap.drafts (max_rounds) VALUES (${rounds}) RETURNING draft_id, lower(active_period) active_period_start`;
        strictEqual(rest.length, 0);
        return parse(CreatedDraft, first);
    }

    @timed async incrementDraftRound(draft: Draft['draft_id']) {
        const sql = this.#sql;
        const [first, ...rest] =
            await sql`UPDATE drap.drafts SET curr_round = curr_round + 1 WHERE draft_id = ${draft} ON CONFLICT ON CONSTRAINT curr_round_within_bounds DO UPDATE SET curr_round = NULL RETURNING curr_round, max_rounds `;
        strictEqual(rest.length, 0);
        return typeof first === 'undefined' ? null : parse(IncrementedDraftRound, first);
    }

    @timed async randomizeRemainingStudents(draft: Draft['draft_id']) {
        const sql = this.#sql;
        const emails =
            await sql`SELECT email FROM drap.student_ranks LEFT JOIN drap.faculty_choices_emails ON email = student_email WHERE draft_id = ${draft} AND student_email IS NULL ORDER BY random()`;
        return parse(UserEmails, emails).map(({ email }) => email);
    }

    @timed async concludeDraft(draft: Draft['draft_id']) {
        const sql = this.#sql;
        const { count } =
            await sql`UPDATE drap.drafts d SET active_period = tstzrange(lower(d.active_period), coalesce(upper(d.active_period), now())) WHERE draft_id = ${draft} RETURNING upper(active_period) active_period_end`;
        switch (count) {
            case 0:
                return false;
            case 1:
                return true;
            default:
                fail(`concludeDraft => unexpected update count ${count}`);
        }
    }

    @timed async insertStudentRanking(draft: Draft['draft_id'], email: User['email'], labs: StudentRank['labs']) {
        const sql = this.#sql;
        const { count } =
            await sql`INSERT INTO drap.student_ranks (draft_id, email, labs) VALUES (${draft}, ${email}, ${labs}) ON CONFLICT ON CONSTRAINT student_ranks_pkey DO NOTHING`;
        switch (count) {
            case 0:
                return false;
            case 1:
                return true;
            default:
                fail(`insertStudentRanking => unexpected insertion count ${count}`);
        }
    }

    @timed async getStudentRankings(draft: StudentRank['draft_id'], email: StudentRank['email']) {
        const sql = this.#sql;
        const [first, ...rest] =
            await sql`SELECT created_at, array_agg(lab_name ORDER BY idx) labs FROM (SELECT generate_subscripts(labs, 1) idx, created_at, unnest(labs) lab_id FROM drap.student_ranks WHERE draft_id = ${draft} AND email = ${email}) _ JOIN drap.labs USING (lab_id) GROUP BY created_at`;
        strictEqual(rest.length, 0);
        return typeof first === 'undefined' ? null : parse(QueriedStudentRank, first);
    }

    @timed async insertFacultyChoice(
        draft: StudentRank['draft_id'],
        lab: FacultyChoice['lab_id'],
        faculty: FacultyChoice['faculty_email'],
        students: StudentRank['email'][],
    ) {
        const sql = this.#sql;
        const emails = students.map(email => [email] as const);
        const { count } =
            await sql`WITH fc AS (INSERT INTO drap.faculty_choices (draft_id, round, lab_id, faculty_email) SELECT draft_id, curr_round, ${lab}, ${faculty} FROM drap.drafts WHERE draft_id = ${draft} RETURNING draft_id, round, lab_id) INSERT INTO drap.faculty_choices_emails (draft_id, round, lab_id, student_email) SELECT draft_id, round, lab_id, email FROM fc, (VALUES ${sql(emails)}) _ (email)`;
        strictEqual(students.length, count);
    }

    @timed async insertLotteryChoices(
        draft: Draft['draft_id'],
        admin: FacultyChoice['faculty_email'],
        batch: Iterable<readonly [StudentRank['email'], FacultyChoice['lab_id']]>,
    ) {
        const sql = this.#sql;
        const rows = Array.from(batch);
        const labs = Array.from(new Set(rows.map(([_, lab]) => lab)), lab => [lab] as const);
        const { count } =
            await sql`WITH fc AS (INSERT INTO drap.faculty_choices (draft_id, round, lab_id, faculty_email) SELECT draft_id, curr_round, lab_id, ${admin} FROM drap.drafts, (VALUES ${sql(labs)}) labs (lab_id) WHERE draft_id = ${draft} ON CONFLICT ON CONSTRAINT faculty_choices_pkey DO UPDATE SET faculty_email = EXCLUDED.faculty_email RETURNING draft_id, round, lab_id) INSERT INTO drap.faculty_choices_emails (draft_id, round, lab_id, student_email) SELECT draft_id, round, lab_id, email FROM fc JOIN (VALUES ${sql(rows)}) batch (email, lab_id) USING (lab_id)`;
        strictEqual(rows.length, count);
    }

    @timed async getPendingLabCountInDraft(draft: Draft['draft_id']) {
        const sql = this.#sql;
        const [first, ...rest] =
            await sql`SELECT count(l.lab_id) FROM drap.drafts d JOIN drap.faculty_choices fc ON (d.draft_id, curr_round) = (fc.draft_id, round) RIGHT JOIN drap.labs l USING (lab_id) WHERE d.draft_id = ${draft} AND fc.lab_id IS NULL`;
        strictEqual(rest.length, 0);
        return parse(CountResult, first).count;
    }

    @timed async inviteNewFacultyOrStaff(email: User['email'], lab: User['lab_id']) {
        const sql = this.#sql;
        const { count } =
            await sql`INSERT INTO drap.users (email, lab_id, is_admin) VALUES (${email}, ${lab}, TRUE) ON CONFLICT ON CONSTRAINT users_pkey DO NOTHING`;
        switch (count) {
            case 0:
                return false;
            case 1:
                return true;
            default:
                fail(`inviteNewUser => unexpected insertion count ${count}`);
        }
    }
}
