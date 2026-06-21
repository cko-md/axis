-- Library module: file metadata table + private Storage bucket for uploads

CREATE TABLE IF NOT EXISTS library_files (
  id            uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  storage_path  text        NOT NULL,
  display_name  text        NOT NULL,
  mime_type     text,
  size_bytes    bigint,
  collection    smallint    NOT NULL DEFAULT 0 CHECK (collection BETWEEN 0 AND 4),
  created_at    timestamptz DEFAULT now()
);

ALTER TABLE library_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own library files"
  ON library_files FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS library_files_user_idx ON library_files (user_id, created_at DESC);

-- Private bucket: personal documents, not publicly readable.
-- Objects are stored under `${user.id}/...` so storage.foldername(name)[1] == auth.uid()
-- mirrors the existing avatars_* policy pattern on storage.objects.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('library-files', 'library-files', false, 5368709120) -- 5 GB, matches dropzone copy
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "library_files_select_own"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'library-files' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "library_files_insert_own"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'library-files' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "library_files_update_own"
  ON storage.objects FOR UPDATE
  USING (bucket_id = 'library-files' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "library_files_delete_own"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'library-files' AND auth.uid()::text = (storage.foldername(name))[1]);
