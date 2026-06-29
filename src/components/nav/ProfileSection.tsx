"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Cropper, { type Area, type Point } from "react-easy-crop";
import { createClient } from "@/lib/supabase/client";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { getCroppedImageBlob } from "./cropImage";

type Props = {
  onSignOut: () => void;
  /** Called whenever the resolved profile name changes (used by Sidebar for the wordmark). */
  onProfileName?: (name: string) => void;
};

type ProfileForm = { name: string; role: string; bio: string; photo: string };
type SaveState = "idle" | "saving" | "saved" | "error";

const AUTOSAVE_DEBOUNCE_MS = 600;

export function ProfileSection({ onSignOut, onProfileName }: Props) {
  const { toast } = useToast();
  const supabase = useMemo(() => createClient(), []);

  const [profile, setProfile] = useState<{ name: string; role: string } | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileForm, setProfileForm] = useState<ProfileForm>({ name: "", role: "", bio: "", photo: "" });
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const photoInputRef = useRef<HTMLInputElement>(null);

  // Crop step — selecting a file opens this instead of uploading immediately.
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [cropPoint, setCropPoint] = useState<Point>({ x: 0, y: 0 });
  const [cropZoom, setCropZoom] = useState(1);
  const [cropArea, setCropArea] = useState<Area | null>(null);
  const [cropSaving, setCropSaving] = useState(false);

  // Auto-save plumbing. We persist the actual upsert behind a debounce so rapid
  // keystrokes collapse into one write. `loadedRef` guards against the initial
  // hydration of the form (from the DB) triggering a needless save.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedRef = useRef(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setProfile(null); return; }
      const { data } = await supabase
        .from("profiles")
        .select("display_name, role_title, bio, avatar_url")
        .eq("id", user.id)
        .maybeSingle();
      const name = data?.display_name || user.email?.split("@")[0] || "Account";
      const role = data?.role_title || user.email || "";
      setProfile({ name, role });
      onProfileName?.(name);
      setProfileForm({
        name,
        role,
        bio: data?.bio ?? "",
        photo: data?.avatar_url ?? "",
      });
      // Mark loaded on the next tick so the form-hydration state update above
      // does not fire the auto-save effect.
      loadedRef.current = false;
      requestAnimationFrame(() => { loadedRef.current = true; });
    })();
  }, [supabase, onProfileName]);

  const persistProfile = useCallback(async (form: ProfileForm) => {
    setSaveState("saving");
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setSaveState("idle"); return; }
      const { error } = await supabase.from("profiles").upsert({
        id: user.id,
        display_name: form.name.trim(),
        role_title: form.role.trim(),
        bio: form.bio.trim(),
        avatar_url: form.photo.trim(),
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      const savedName = form.name.trim() || "Account";
      setProfile({ name: savedName, role: form.role.trim() });
      onProfileName?.(savedName);
      setSaveState("saved");
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaveState("idle"), 2000);
    } catch {
      setSaveState("error");
      toast("Could not save profile", "error", "Profile");
    }
  }, [supabase, onProfileName, toast]);

  // Debounced auto-save: any change to the form (after initial load) schedules
  // an upsert ~600ms later. The modal being open is not required — edits flush
  // even if the user closes it mid-debounce because the timer outlives the modal.
  useEffect(() => {
    if (!loadedRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void persistProfile(profileForm);
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [profileForm, persistProfile]);

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
  }, []);

  const saveStateLabel =
    saveState === "saving" ? "Saving…" :
    saveState === "saved" ? "Saved" :
    saveState === "error" ? "Retry pending…" :
    "";

  const handlePhotoFile = async (file: File | Blob, revokeUrl?: string) => {
    const preview = URL.createObjectURL(file);
    setProfileForm((p) => ({ ...p, photo: preview }));
    try {
      const form = new FormData();
      form.append("file", file, "avatar.jpg");
      const res = await fetch("/api/profile/avatar", { method: "POST", body: form });
      const json = await res.json() as { url?: string; error?: string };
      if (!res.ok || !json.url) throw new Error(json.error ?? "Upload failed");
      setProfileForm((p) => ({ ...p, photo: json.url! }));
    } catch {
      toast("Photo upload failed", "error", "Profile");
      setProfileForm((p) => ({ ...p, photo: "" }));
    } finally {
      URL.revokeObjectURL(preview);
      if (revokeUrl) URL.revokeObjectURL(revokeUrl);
    }
  };

  const openCropForFile = (file: File) => {
    if (!file.type.startsWith("image/")) { toast("Select an image file", "warn", "Profile"); return; }
    setCropPoint({ x: 0, y: 0 });
    setCropZoom(1);
    setCropArea(null);
    setCropSrc(URL.createObjectURL(file));
  };

  const cancelCrop = () => {
    if (cropSrc) URL.revokeObjectURL(cropSrc);
    setCropSrc(null);
  };

  const confirmCrop = async () => {
    if (!cropSrc || !cropArea) return;
    setCropSaving(true);
    try {
      const blob = await getCroppedImageBlob(cropSrc, cropArea);
      await handlePhotoFile(blob, cropSrc);
    } catch {
      toast("Could not crop photo", "error", "Profile");
    } finally {
      setCropSaving(false);
      setCropSrc(null);
    }
  };

  return (
    <>
      <div className="sidefoot">
        {profile ? (
          <div className="profile" style={{ alignItems: "center", cursor: "pointer" }} onClick={() => setProfileOpen(true)} title="Edit profile">
            {profileForm.photo ? (
              <Image src={profileForm.photo} alt={profile.name} width={32} height={32} className="avatar" style={{ objectFit: "cover", borderRadius: "50%" }} unoptimized={profileForm.photo.startsWith("blob:")} />
            ) : (
              <div className="avatar">{profile.name[0]?.toUpperCase() ?? "A"}</div>
            )}
            <div className="pmeta">
              <div className="pn">{profile.name}</div>
              <div className="pr">{profile.role}</div>
            </div>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onSignOut(); }}
              title="Sign out"
              aria-label="Sign out"
              style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--ink-faint)", cursor: "pointer", padding: 4 }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 14, height: 14 }}>
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
              </svg>
            </button>
          </div>
        ) : (
          <Link href="/login" className="profile">
            <div className="avatar">→</div>
            <div className="pmeta">
              <div className="pn">Sign in</div>
              <div className="pr">Sync across devices</div>
            </div>
          </Link>
        )}
      </div>

      {/* Profile modal — fields auto-save on edit (debounced). Swaps to a crop
          step in place when a new photo is selected, rather than stacking a
          second modal on top. */}
      <Modal
        open={profileOpen}
        onClose={() => { if (cropSrc) cancelCrop(); setProfileOpen(false); }}
        title={cropSrc ? "Adjust Photo" : "Profile"}
        footer={
          cropSrc ? (
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, width: "100%" }}>
              <button
                type="button"
                onClick={cancelCrop}
                disabled={cropSaving}
                style={{ background: "none", border: "1px solid var(--line)", borderRadius: "var(--r)", padding: "6px 14px", fontSize: 12, color: "var(--ink-dim)", cursor: cropSaving ? "default" : "pointer", fontFamily: "var(--narrow)" }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmCrop}
                disabled={cropSaving || !cropArea}
                style={{ background: "var(--accent)", border: "none", borderRadius: "var(--r)", padding: "6px 14px", fontSize: 12, color: "#fff", cursor: cropSaving ? "default" : "pointer", fontFamily: "var(--narrow)", opacity: cropSaving ? 0.6 : 1 }}
              >
                {cropSaving ? "Saving…" : "Save Photo"}
              </button>
            </div>
          ) : (
          <div style={{ display: "flex", alignItems: "center", width: "100%" }}>
            <span
              role="status"
              aria-live="polite"
              style={{
                fontFamily: "var(--mono)",
                fontSize: 10,
                letterSpacing: ".1em",
                textTransform: "uppercase",
                color: saveState === "error" ? "var(--clay-2)" : saveState === "saved" ? "var(--gold)" : "var(--ink-faint)",
                transition: "color .2s",
                minHeight: 14,
              }}
            >
              {saveStateLabel ? (
                <>
                  {saveState === "saving" && (
                    <span
                      aria-hidden
                      style={{
                        display: "inline-block",
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: "currentColor",
                        marginRight: 7,
                        verticalAlign: "middle",
                        animation: "pulse 1s ease-in-out infinite",
                      }}
                    />
                  )}
                  {saveStateLabel}
                </>
              ) : (
                "Changes save automatically"
              )}
            </span>
          </div>
          )
        }
      >
        {cropSrc ? (
          <div>
            <div
              style={{
                position: "relative",
                width: "100%",
                height: 320,
                borderRadius: "var(--r)",
                overflow: "hidden",
                background: "#111",
              }}
            >
              <Cropper
                image={cropSrc}
                crop={cropPoint}
                zoom={cropZoom}
                aspect={1}
                cropShape="round"
                showGrid={false}
                onCropChange={setCropPoint}
                onZoomChange={setCropZoom}
                onCropComplete={(_area, areaPixels) => setCropArea(areaPixels)}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--ink-faint)" }}>
                Zoom
              </span>
              <input
                type="range"
                min={1}
                max={3}
                step={0.01}
                value={cropZoom}
                onChange={(e) => setCropZoom(Number(e.target.value))}
                style={{ flex: 1, accentColor: "var(--accent)" }}
                aria-label="Zoom"
              />
            </div>
          </div>
        ) : (
        <>
        {/* Avatar upload */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
          <div
            style={{
              width: 72, height: 72, borderRadius: "50%", border: "2px solid var(--line)",
              background: "var(--surface-2)", overflow: "hidden", flexShrink: 0, position: "relative",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 26, color: "var(--ink-faint)", cursor: "pointer",
            }}
            onClick={() => photoInputRef.current?.click()}
            title="Click to change photo"
          >
            {profileForm.photo ? (
              <Image
                src={profileForm.photo}
                alt="Avatar"
                fill
                sizes="72px"
                unoptimized
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
            ) : (
              profileForm.name?.[0]?.toUpperCase() ?? "?"
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <button
              type="button"
              onClick={() => photoInputRef.current?.click()}
              style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: "var(--r)", padding: "5px 12px", fontSize: 12, color: "var(--ink)", cursor: "pointer", fontFamily: "var(--narrow)", letterSpacing: ".05em" }}
            >
              Upload Photo
            </button>
            {profileForm.photo && (
              <button
                type="button"
                onClick={() => setProfileForm((p) => ({ ...p, photo: "" }))}
                style={{ background: "none", border: "none", padding: 0, fontSize: 11, color: "var(--ink-faint)", cursor: "pointer", textAlign: "left" }}
              >
                Remove
              </button>
            )}
          </div>
          <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) openCropForFile(f); e.target.value = ""; }}
          />
        </div>

        {(["name", "role"] as const).map((field) => (
          <div key={field} style={{ marginBottom: 14 }}>
            <label htmlFor={`profile-${field}`} style={{ display: "block", fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--ink-faint)", marginBottom: 5 }}>
              {field === "name" ? "Display Name" : "Role / Title"}
            </label>
            <input
              id={`profile-${field}`}
              value={profileForm[field]}
              onChange={(e) => setProfileForm((p) => ({ ...p, [field]: e.target.value }))}
              placeholder={field === "name" ? "Your name" : "Resident Physician, Neurosurgery"}
              className="w-full rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
            />
          </div>
        ))}
        <div style={{ marginBottom: 14 }}>
          <label htmlFor="profile-bio" style={{ display: "block", fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--ink-faint)", marginBottom: 5 }}>
            Bio
          </label>
          <textarea
            id="profile-bio"
            value={profileForm.bio}
            onChange={(e) => setProfileForm((p) => ({ ...p, bio: e.target.value }))}
            placeholder="A short bio or description…"
            rows={3}
            style={{ width: "100%", padding: "8px 12px", borderRadius: "var(--r)", border: "1px solid var(--line)", background: "var(--surface-2)", color: "var(--ink)", fontFamily: "var(--sans)", fontSize: 13, resize: "vertical", outline: "none" }}
          />
        </div>
        <div>
          <label htmlFor="profile-photo" style={{ display: "block", fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--ink-faint)", marginBottom: 5 }}>
            Photo URL (optional override)
          </label>
          <input
            id="profile-photo"
            value={profileForm.photo.startsWith("data:") ? "" : profileForm.photo}
            onChange={(e) => setProfileForm((p) => ({ ...p, photo: e.target.value }))}
            placeholder="https://…"
            className="w-full rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
          />
        </div>
        </>
        )}
      </Modal>
    </>
  );
}

/** Returns the initials (up to 3 chars) for the wordmark superscript. */
export function profileInitials(name: string | undefined): string {
  if (!name) return "CKO";
  return name.trim().split(/\s+/).filter(Boolean).map((p) => p[0].toUpperCase()).join("").slice(0, 3) || "CKO";
}
