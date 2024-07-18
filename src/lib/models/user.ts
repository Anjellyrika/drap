import {
    type InferOutput,
    bigint,
    boolean,
    email,
    literal,
    maxLength,
    minLength,
    nullable,
    object,
    pipe,
    string,
    union,
    url,
} from 'valibot';
import { Lab } from '$lib/models/lab';

export const User = object({
    is_admin: boolean(),
    student_number: nullable(bigint()),
    lab_id: nullable(Lab.entries.lab_id),
    email: pipe(string(), email()),
    user_id: nullable(pipe(string(), minLength(1), maxLength(255))),
    given_name: string(),
    family_name: string(),
    avatar: union([literal(''), pipe(string(), url())]),
});

export type User = InferOutput<typeof User>;
