-- Gallery favorites: cross-device sync for pinned art, poems, and readings
CREATE TABLE IF NOT EXISTS gallery_favorites (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item_type   text        NOT NULL CHECK (item_type IN ('art', 'poem', 'reading')),
  item_id     text        NOT NULL,
  metadata    jsonb,
  created_at  timestamptz DEFAULT now(),
  CONSTRAINT gallery_favorites_user_item_unique UNIQUE (user_id, item_type, item_id)
);

ALTER TABLE gallery_favorites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own gallery favorites"
  ON gallery_favorites FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX gallery_favorites_user_type_idx ON gallery_favorites (user_id, item_type);
