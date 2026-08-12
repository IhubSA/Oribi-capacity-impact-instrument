/* ===================== Supabase client ===================== */
/* This project's URL and public (anon/publishable) key. The key below is safe to ship in
 * client-side code — it identifies the project, it does not grant blanket access. Access is
 * controlled entirely by Row Level Security policies on the tables in Supabase, not by keeping
 * this key secret. See supabase/migration.sql for the policies currently in force.
 */
const SUPABASE_URL = 'https://ziladpnlfajtiboavwvn.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_9PPylQ1CDhMUvQFuE3nW3Q__pTIhYjb';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
