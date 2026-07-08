import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Calendar,
  ChefHat,
  ClipboardList,
  Dumbbell,
  FolderOpen,
  GitBranch,
  LayoutDashboard,
  LineChart,
  ListTodo,
  Mail,
  Music2,
  Newspaper,
  Paintbrush,
  Radio,
  RotateCcw,
  Settings,
  Target,
  Users,
} from "lucide-react";

/** Semantic Lucide mapping for sidebar / command palette nav icons. */
export const NAV_ICON_MAP: Record<string, LucideIcon> = {
  console: LayoutDashboard,
  signals: Radio,
  calendar: Calendar,
  agenda: ListTodo,
  mail: Mail,
  notes: ClipboardList,
  goals: Target,
  review: RotateCcw,
  pipeline: GitBranch,
  literature: BookOpen,
  fitness: Dumbbell,
  atelier: Paintbrush,
  people: Users,
  briefing: Newspaper,
  vault: Music2,
  library: FolderOpen,
  recipes: ChefHat,
  chart: LineChart,
  system: Settings,
};

export function resolveNavIcon(name: string): LucideIcon {
  return NAV_ICON_MAP[name] ?? LineChart;
}
