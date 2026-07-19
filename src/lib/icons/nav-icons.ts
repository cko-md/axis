import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Brain,
  Bot,
  Calendar,
  ChefHat,
  ClipboardList,
  Dumbbell,
  FolderOpen,
  Gamepad2,
  GitBranch,
  LayoutDashboard,
  LineChart,
  ListTodo,
  Mail,
  Music2,
  Newspaper,
  Paintbrush,
  Palette,
  Radio,
  RotateCcw,
  Settings,
  ShieldCheck,
  Sparkles,
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
  vector: Gamepad2,
  envoys: Sparkles,
  chart: LineChart,
  tasks: Bot,
  approvals: ShieldCheck,
  memory: Brain,
  system: Settings,
  // Command palette action / create keys (not sidebar routes)
  create: Sparkles,
  palette: Palette,
};

export function resolveNavIcon(name: string): LucideIcon {
  return NAV_ICON_MAP[name] ?? LineChart;
}
