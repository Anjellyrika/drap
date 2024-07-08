import { error } from '@sveltejs/kit';

export async function load({ locals: { db } }) {
    const draft = await db.getLatestDraft();
    if (draft === null) error(499);
    return { draft };
}
