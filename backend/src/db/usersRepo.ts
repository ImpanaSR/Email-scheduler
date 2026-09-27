import { pool } from "./pool";

export interface UserRow {
  id: number;
  google_id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
}

export async function upsertGoogleUser(profile: {
  googleId: string;
  email: string;
  name: string;
  avatarUrl: string;
}): Promise<UserRow> {
  const { rows } = await pool.query<UserRow>(
    `INSERT INTO users (google_id, email, name, avatar_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (google_id) DO UPDATE
       SET email = EXCLUDED.email, name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url
     RETURNING *`,
    [profile.googleId, profile.email, profile.name, profile.avatarUrl]
  );
  return rows[0];
}

export async function getUserById(id: number): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows[0] ?? null;
}
