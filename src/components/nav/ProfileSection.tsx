"use client";

import Image from "next/image";
import Link from "next/link";
import React, { useCallback, useEffect, useRef, useState } from "react";
import Cropper, { type Area, type Point } from "react-easy-crop";
import * as Sentry from "@sentry/nextjs";
import { useShellProfile } from "@/components/layout/ShellProfileContext";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { getCroppedImageBlob } from "./cropImage";

type Props = {
  onSignOut: () => void;
  /** Called whenever the resolved profile name changes (used by Sidebar for the wordmark). */
  onProfileName?: (name: string) => void;
};

type ProfileForm = { name: string; role: string; bio: string; photo: string };
type SaveState = "idle" | "saving" | "saved" | "error" | "session-expired";
type QueuedProfileSave = {
  form: ProfileForm;
  generation: number;
};

const AUTOSAVE_DEBOUNCE_MS = 600;

function captureProfileSaveNetworkFailure() {
  Sentry.captureException(new Error("Profile save network failure"), {
    tags: {
      area: "navigation",
      operation: "profile_save_network",
    },
  });
}

export function ProfileSection({ onSignOut, onProfileName }: Props) {
  const { toast } = useToast();
  const { state: accountState, profile: shellProfile } = useShellProfile();

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
  const mountedRef = useRef(false);
  const saveControllerRef = useRef<AbortController | null>(null);
  const saveGenerationRef = useRef(0);
  const saveQueueRef = useRef<QueuedProfileSave[]>([]);
  const drainingSaveQueueRef = useRef(false);
  const saveBlockedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      saveGenerationRef.current += 1;
      saveBlockedRef.current = true;
      saveQueueRef.current = [];
      saveControllerRef.current?.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  useEffect(() => {
    let hydrationFrame: number | null = null;
    loadedRef.current = false;
    if (accountState !== "ready" || !shellProfile) {
      setProfile(null);
      return;
    }

    const name =
      shellProfile.display_name ||
      shellProfile.email?.split("@")[0] ||
      "Account";
    const role = shellProfile.role_title || shellProfile.email || "";
    saveBlockedRef.current = false;
    setProfile({ name, role });
    onProfileName?.(name);
    setProfileForm({
      name,
      role,
      bio: shellProfile.bio ?? "",
      photo: shellProfile.avatar_url ?? "",
    });
    hydrationFrame = requestAnimationFrame(() => {
      if (mountedRef.current) loadedRef.current = true;
    });

    return () => {
      if (hydrationFrame !== null) cancelAnimationFrame(hydrationFrame);
    };
  }, [accountState, onProfileName, shellProfile]);

  const drainSaveQueue = useCallback(async () => {
    if (drainingSaveQueueRef.current) return;
    drainingSaveQueueRef.current = true;
    try {
      while (mountedRef.current && saveQueueRef.current.length > 0) {
        const job = saveQueueRef.current.shift();
        if (!job) continue;

        const controller = new AbortController();
        saveControllerRef.current = controller;
        try {
          const response = await fetch("/api/auth/profile", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(job.form),
            signal: controller.signal,
          });
          if (!mountedRef.current) return;

          if (response.status === 401) {
            saveBlockedRef.current = true;
            saveQueueRef.current = [];
            setSaveState("session-expired");
            toast(
              "Your session expired. Sign in again to save profile changes.",
              "error",
              "Profile",
            );
            return;
          }

          if (!response.ok) {
            if (job.generation === saveGenerationRef.current) {
              setSaveState("error");
              toast("Could not save profile", "error", "Profile");
            }
            continue;
          }

          if (job.generation !== saveGenerationRef.current) continue;
          const savedName = job.form.name.trim() || "Account";
          setProfile({ name: savedName, role: job.form.role.trim() });
          onProfileName?.(savedName);
          setSaveState("saved");
          if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
          savedTimerRef.current = setTimeout(() => {
            if (
              mountedRef.current &&
              job.generation === saveGenerationRef.current
            ) {
              setSaveState("idle");
            }
          }, 2000);
        } catch (error) {
          if (
            !mountedRef.current ||
            controller.signal.aborted ||
            (error instanceof DOMException && error.name === "AbortError")
          ) {
            return;
          }
          captureProfileSaveNetworkFailure();
          if (job.generation === saveGenerationRef.current) {
            setSaveState("error");
            toast("Could not save profile", "error", "Profile");
          }
        } finally {
          if (saveControllerRef.current === controller) {
            saveControllerRef.current = null;
          }
        }
      }
    } finally {
      drainingSaveQueueRef.current = false;
    }
  }, [onProfileName, toast]);

  // Debounced auto-save: any change to the form (after initial load) schedules
  // an upsert ~600ms later. The modal being open is not required — edits flush
  // even if the user closes it mid-debounce because the timer outlives the modal.
  useEffect(() => {
    if (!loadedRef.current) return;
    const generation = ++saveGenerationRef.current;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    debounceRef.current = setTimeout(() => {
      if (!mountedRef.current || saveBlockedRef.current) return;
      saveQueueRef.current.push({ form: profileForm, generation });
      setSaveState("saving");
      void drainSaveQueue();
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [drainSaveQueue, profileForm]);

  const saveStateLabel =
    saveState === "saving" ? "Saving…" :
    saveState === "saved" ? "Saved" :
    saveState === "session-expired" ? "Session expired — changes not saved" :
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
        {accountState === "ready" && profile ? (
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
        ) : accountState === "signed-out" ? (
          <Link href="/login" prefetch={false} className="profile">
            <div className="avatar">→</div>
            <div className="pmeta">
              <div className="pn">Sign in</div>
              <div className="pr">Sync across devices</div>
            </div>
          </Link>
        ) : accountState === "error" ? (
          <button
            type="button"
            className="profile"
            onClick={() => window.location.reload()}
            title="Reload to retry account lookup"
            style={{ width: "100%", textAlign: "left" }}
          >
            <div className="avatar">!</div>
            <div className="pmeta">
              <div className="pn">Account unavailable</div>
              <div className="pr">Reload to retry</div>
            </div>
          </button>
        ) : (
          <div className="profile" aria-busy="true" aria-label="Loading account">
            <div className="avatar" aria-hidden>…</div>
            <div className="pmeta">
              <div className="pn">Loading account</div>
              <div className="pr">Checking session</div>
            </div>
          </div>
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
                color: saveState === "error" || saveState === "session-expired" ? "var(--clay-2)" : saveState === "saved" ? "var(--gold)" : "var(--ink-faint)",
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
