import { validateEmail, validateString } from '$lib/forms';
import assert from 'node:assert/strict';
import { error } from '@sveltejs/kit';

export async function load({ locals: { db }, parent }) {
    const { user, draft } = await parent();
    if (!user.is_admin || user.user_id === null || user.lab_id === null) error(403);

    const { lab, students, researchers, isDone } = await db.getLabAndRemainingStudentsInDraftWithLabPreference(
        draft.draft_id,
        user.lab_id,
    );
    if (lab === null) error(404);

    return { draft, lab, students, researchers, isDone };
}

export const actions = {
    async rankings({ locals: { db }, cookies, request }) {
        const sid = cookies.get('sid');
        if (typeof sid === 'undefined') error(401);

        const user = await db.getUserFromValidSession(sid);
        if (user === null) error(401);
        if (!user.is_admin || user.user_id === null || user.lab_id === null) error(403);

        const data = await request.formData();
        const draft = BigInt(validateString(data.get('draft')));
        const students = data.getAll('students').map(validateEmail);

        const { quota, selected } = await db.getLabQuotaAndSelectedStudentCountInDraft(draft, user.lab_id);
        assert(quota !== null);

        const total = selected + BigInt(students.length);
        if (total > quota) error(403);

        const lab = user.lab_id;
        const faculty = user.email;
        await db.begin(async db => {
            await db.insertFacultyChoice(draft, lab, faculty, students);
            const postDraftRoundSubmittedNotification = await db.postDraftRoundSubmittedNotification(draft, lab);
            db.logger.info({ postDraftRoundSubmittedNotification });
            await db.notifyDraftChannel();

            while (true) {
                const count = await db.getPendingLabCountInDraft(draft);
                if (count > 0) break;

                const round = await db.incrementDraftRound(draft);
                assert(round !== null);

                const postDraftRoundStartedNotification = await db.postDraftRoundStartedNotification(
                    draft,
                    round.curr_round,
                );
                db.logger.info({ postDraftRoundStartedNotification });

                if (round.curr_round === null) break;
                db.logger.info({ incrementDraftRound: round });

                const autoAcknowledgeLabsWithoutPreferences = await db.autoAcknowledgeLabsWithoutPreferences(draft);
                db.logger.info({ autoAcknowledgeLabsWithoutPreferences });
            }
        });
    },
};
