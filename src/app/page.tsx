import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LandingPublic } from "@/components/landing/LandingPublic";

export const metadata: Metadata = {
  title: "Axis — Personal Operating System",
  description:
    "Axis is a personal operating system: one private dashboard for your calendar, email, tasks, notes, health, finances, and reading — connected to the services you already use.",
};

export default async function HomePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) redirect("/command");

  return <LandingPublic />;
}
