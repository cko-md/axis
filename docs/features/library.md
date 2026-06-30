# Library

Library stores user files in Supabase Storage with `library_files` metadata.

## Current Production Boundary

- Upload, open/download, and delete are backed by Supabase Storage and `library_files`.
- File rows are owner-scoped with RLS.
- Image thumbnails use signed URLs and degrade to a file card when unavailable.
- Mail attachments can be routed into Library as Dispatch signals for follow-up until provider-specific attachment download is implemented.

## Validation Checklist

- Upload PDF, image, and document files.
- Open/download each uploaded file.
- Delete a file and confirm storage object plus metadata row are removed.
- Confirm second-user RLS cannot read another user's metadata.
- Confirm missing storage bucket or signed URL failure shows visible feedback.
