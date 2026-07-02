-- Track when the session title was last written, independently of `updated_at`.
-- `updated_at` is also advanced by unrelated status/touch writes, so gating the
-- title sync on it let an interleaved newer status write permanently suppress a
-- valid title in the index. Title writes are gated on this column instead.
-- NULL means no title has been synced yet.
ALTER TABLE sessions ADD COLUMN title_updated_at INTEGER;
