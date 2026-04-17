// kaikei はオフライン・1ユーザの Tauri デスクトップアプリなので Supabase は使わない。
// 既存コードの `import { supabase } from "@/lib/supabase"` を壊さないため、
// ローカルDBラッパを `supabase` としてここで再エクスポートする。
export { db as supabase, resolveLocalImageUrl } from "@/lib/localDb";
